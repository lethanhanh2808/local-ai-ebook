// src/worker/index.ts
// BullMQ worker process – runs independently from Next.js
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
// Load .env.local (preferred) then fall back to .env — override: true forces
// refresh even if the var was already in the shell environment
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });
import { UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAME, ConversionJobData, redisConnection } from '../lib/queue';
import { updateJob } from '../lib/db/jobs';
import { getEffectiveSettings } from '../lib/db/settings';
import { runConversionPipeline } from '../lib/pipeline/conversion-pipeline';
import { outputPath } from '../lib/storage';
import { prisma } from '../lib/db/client';
import { probeCalibre, convertWithCalibre } from '../lib/tools/calibre';

// Use a dedicated connection for the liveness ping (separate from BullMQ
// which sometimes has its own connection state). This is more reliable.
const pingConnection = new IORedis({
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // required by BullMQ (we share this with the queue)
});

// ── Liveness ping: mark the worker as "alive" in Redis every 10s.
const WORKER_ALIVE_KEY = 'ebook:worker:alive';
const WORKER_ALIVE_TTL_SEC = 30;
async function pingAlive() {
  try {
    await pingConnection.set(WORKER_ALIVE_KEY, Date.now().toString(), 'EX', WORKER_ALIVE_TTL_SEC);
  } catch (err) {
    console.warn('[worker] ping alive failed:', err);
  }
}
void pingAlive();
const pingTimer = setInterval(() => { void pingAlive(); }, 10_000);
pingTimer.unref();
const shutdownPing = async () => {
  clearInterval(pingTimer);
  try { await pingConnection.del(WORKER_ALIVE_KEY); } catch { /* best-effort */ }
};

const connection = pingConnection;

// ── Per-job log file writer ──────────────────────────────────────────────
// Each job gets a JSON-lines log file at data/job-logs/<jobId>.jsonl that
// the UI can tail to show real-time progress (debug console).
const LOG_DIR = path.resolve(process.cwd(), 'data/job-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  stage: string;
  message: string;
  meta?: Record<string, unknown>;
}

function jobLogPath(jobId: string): string {
  return path.join(LOG_DIR, `${jobId}.jsonl`);
}

function appendLog(jobId: string, entry: LogEntry): void {
  try {
    fs.appendFileSync(jobLogPath(jobId), JSON.stringify(entry) + '\n');
  } catch {
    /* best-effort */
  }
}

// ── Watchdog: log a heartbeat every 30s so the UI knows the job is still alive
let heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

// ── Worker boot: read concurrency from settings
async function getWorkerConcurrency(): Promise<number> {
  try {
    const s = await getEffectiveSettings();
    return Math.max(1, Math.min(8, s.workerConcurrency));
  } catch {
    return 2;
  }
}

let activeConcurrency = 2;
getWorkerConcurrency().then((n) => { activeConcurrency = n; });

const worker = new Worker<ConversionJobData>(
  QUEUE_NAME,
  async (job) => {
    const { jobId, inputPath, originalExt, filename, aiEnhance, aiWatermarkClean, deepFormat, readerFriendly, aiPrompt, requiresPreprocessing } = job.data;

    // Reset per-job log
    try { fs.writeFileSync(jobLogPath(jobId), ''); } catch { /* noop */ }
    const log = (level: LogEntry['level'], stage: string, message: string, meta?: LogEntry['meta']) =>
      appendLog(jobId, { ts: Date.now(), level, stage, message, meta });
    log('info', 'start', `Job ${jobId} starting`, { aiEnhance, aiWatermarkClean, deepFormat, readerFriendly });
    // Persist logPath immediately so the Debug Console button can appear in
    // JobCard as soon as the job starts (not just at completion).
    try { await updateJob(jobId, { logPath: jobLogPath(jobId) }); } catch { /* noop */ }

    // Start heartbeat — writes a log line every 30s so the UI can show
    // the job is still alive even when no real progress is happening.
    const heartbeat = setInterval(() => {
      log('debug', 'heartbeat', `Job still running`);
    }, 30_000);
    heartbeatTimers.set(jobId, heartbeat);

    const tick = async (pct: number, stage: string) => {
      await updateJob(jobId, { status: 'processing', progress: pct, stage: stage as never });
      log('info', stage, `Progress ${pct}%`);
    };

    let totalTokens = 0;
    let totalDurationMs = 0;
    let totalCalls = 0;
    // Track the latest server-reported per-second rates (OMLX emits these
    // via streaming). When the job finishes we surface them in the JobCard so
    // users can compare speeds across models / runs.
    let lastGenTokensPerSec: number | null = null;
    let lastPromptTokensPerSec: number | null = null;
    const t0 = Date.now();

    try {
      await tick(1, 'validate');
      const out = outputPath(jobId);
      log('info', 'paths', `input=${inputPath} output=${out}`);

      // Phase 4.3 — Calibre pre-step. When the upload route flagged this job
      // as needing preprocessing (MOBI), convert to a staged .epub via
      // ebook-convert and swap the pipeline input. The pre-step occupies
      // ticks 3-8 (validate=1, preprocess=3-8) so the progress bar is
      // monotonically increasing.
      let effectiveInputPath = inputPath;
      let effectiveOriginalExt = originalExt;
      if (requiresPreprocessing) {
        await tick(3, 'preprocess-resolve');
        const probe = await probeCalibre(true); // fresh probe in worker process
        if (!probe.ok) {
          log('error', 'preprocess-resolve', probe.error ?? 'Calibre missing');
          throw new UnrecoverableError(probe.error ?? 'Calibre (ebook-convert) not installed');
        }
        log('info', 'preprocess-resolve', `using ${probe.path} (${probe.version ?? 'unknown version'})`, {
          path: probe.path, version: probe.version,
        });

        await tick(5, 'preprocess-convert');
        const stagedPath = path.join(path.dirname(inputPath), `${jobId}-staged.epub`);
        const tConv = Date.now();
        let lastPct = 5;
        const heartbeat = setInterval(() => {
          if (lastPct < 7) { lastPct += 1; void tick(lastPct, 'preprocess-convert'); }
        }, 10_000);
        try {
          await convertWithCalibre(inputPath, stagedPath, {
            binaryPath: probe.path ?? undefined,
            onLog: (chunk) => log('info', 'preprocess-convert', chunk.slice(-200)),
          });
        } catch (err) {
          clearInterval(heartbeat);
          log('error', 'preprocess-convert', `ebook-convert failed: ${String(err)}`);
          // Calibre errors are non-recoverable (bad MOBI, missing dep). Skip
          // BullMQ retries — each attempt would re-fail identically.
          throw new UnrecoverableError(`Calibre preprocess failed: ${String(err)}`);
        }
        clearInterval(heartbeat);
        const elapsed = Date.now() - tConv;
        const bytes = fs.statSync(stagedPath).size;
        log('info', 'preprocess-done', `staged EPUB written in ${elapsed}ms (${bytes} bytes)`, {
          bytes, elapsedMs: elapsed, stagedPath,
        });

        effectiveInputPath = stagedPath;
        effectiveOriginalExt = 'epub';
      }

      // Read current model/provider from settings so the JobCard can show it
      const settings = await getEffectiveSettings();
      log('info', 'config', `provider=${settings.aiProvider} model=${settings.aiModel}`);
      try {
        await updateJob(jobId, {
          aiModel: settings.aiModel,
          aiProvider: settings.aiProvider,
        });
      } catch (e) {
        log('warn', 'config', `Failed to save model info: ${String(e)}`);
      }

      const result = await runConversionPipeline({
        inputPath: effectiveInputPath,
        outputPath: out,
        originalExt: effectiveOriginalExt,
        // Pass the Job ID so the pipeline can write the deep-format
        // sidecar (`<outputPath>.deepFormat.json`). When the user later
        // imports this job into the library, the POST /api/library
        // handler copies the sidecar to the new library location so
        // the bible worker can keep reading from the cleaned text.
        bookId: jobId,
        onProgress: tick,
        aiEnhance: aiEnhance ?? false,
        aiWatermarkClean: aiWatermarkClean ?? false,
        deepFormat: deepFormat ?? false,
        readerFriendly: readerFriendly ?? false,
        aiPrompt,
        // Per-chapter AI stats callback: each AI call reports tokens + duration
        onAiCall: (stats) => {
          totalTokens += stats.tokens;
          totalDurationMs += stats.durationMs;
          totalCalls += 1;
          // Track server-reported rates (OMLX supplies these via streaming).
          // We store the latest so the JobCard can show "gen X.X tok/s".
          if (stats.generationTokensPerSecond) lastGenTokensPerSec = stats.generationTokensPerSecond;
          if (stats.promptTokensPerSecond) lastPromptTokensPerSec = stats.promptTokensPerSecond;
          // Prefer the server-reported generation rate (more accurate) when
          // OMLX supplied it; otherwise fall back to client-measured throughput.
          const serverGen = stats.generationTokensPerSecond;
          const serverPrompt = stats.promptTokensPerSecond;
          const clientTokPerSec = stats.durationMs > 0 ? (stats.tokens * 1000 / stats.durationMs).toFixed(1) : '–';
          const toksLabel = serverGen
            ? `${stats.tokens} tokens (gen ${serverGen.toFixed(1)} tok/s${serverPrompt ? `, prompt ${serverPrompt.toFixed(1)} tok/s` : ''})`
            : `${stats.tokens} tokens (${clientTokPerSec} tok/s)`;
          log('info', 'ai-call',
            `model=${stats.model} ${toksLabel} dur=${stats.durationMs}ms${stats.promptTokens ? ` in=${stats.promptTokens} out=${stats.completionTokens}` : ''}`,
            stats,
          );
        },
        onChapterDone: async (i, total, chapterTitle) => {
          log('info', 'chapter-done', `${i + 1}/${total} — ${chapterTitle || '(no title)'}`);
          // Sync running stats to DB so the JobCard shows live progress
          // (every chapter, not just at completion).
          try {
            await updateJob(jobId, {
              aiCallCount: totalCalls,
              aiTotalTokens: totalTokens,
              aiTotalDurationMs: totalDurationMs,
              aiGenerationTokensPerSecond: lastGenTokensPerSec,
              aiPromptTokensPerSecond: lastPromptTokensPerSec,
            });
          } catch (e) {
            log('warn', 'chapter-done', `Failed to sync stats: ${String(e)}`);
          }
        },
      });

      // Read final AI stats from the result (set by pipeline if it tracked)
      const elapsed = Date.now() - t0;
      const tokPerSec = elapsed > 0 ? ((totalTokens * 1000) / elapsed).toFixed(1) : '0';
      log('info', 'done', `Conversion done in ${elapsed}ms | ${totalCalls} AI calls | ${totalTokens} tokens | avg ${tokPerSec} tok/s`);

      // ── Deep-format sidecar → bible fan-out ───────────────────────
      // When deepFormat ran, the pipeline wrote a sidecar JSON next to
      // the EPUB containing the AI-cleaned chapter text. We now fan
      // out one bible-refresh job per chapter so the character bible is
      // built off the SAME cleaned prose the user reads in their ebook.
      // Skipped if the user opted out (a Settings flag exists — see
      // 'bibleAutoEnqueueOnDeepFormat' below) so power users can keep
      // the two stages independent.
      let bibleFanout: { enqueued: number; skipped: boolean; reason?: string } = {
        enqueued: 0,
        skipped: true,
        reason: 'deep-format was not used',
      };
      try {
        const s = await getEffectiveSettings();
        // Per-book gate: when false (the default for new users who
        // haven't reviewed it yet), do NOT auto-enqueue. Power users
        // who want the integration flip this in /settings.
        // We DO still write the sidecar regardless — that's a pure
        // on-disk artifact and never auto-triggers work.
        const autoEnqueue = (s as { bibleAutoEnqueueOnDeepFormat?: boolean }).bibleAutoEnqueueOnDeepFormat === true;
        if (result.aiUsed.deepFormat && autoEnqueue) {
          // Read chapter count from the final EPUB so we fan out exactly
          // once per chapter. parseEpub is cheap (~10ms for the spine
          // walk) and matches the chapterIndex ordering the bible worker
          // uses (htmlFiles[i] = chapterIndex i).
          const { parseEpub } = await import('@/lib/pipeline/epub-parser');
          const finalEpub = await parseEpub(out);
          const chapterIndices = finalEpub.htmlFiles.map((_f: string, i: number) => i);
          const { enqueueBibleRefreshForChapters } = await import('@/lib/ai/character-bible-enqueue');
          const r = await enqueueBibleRefreshForChapters(jobId, chapterIndices, {
            useDeepFormatSidecar: true,
            reason: 'deep-format',
          });
          bibleFanout = { enqueued: r.added, skipped: false };
          log('info', 'bible-fanout', `Enqueued ${r.added} bible-refresh job(s) (deep-format source)`, {
            bookId: jobId, chapters: chapterIndices.length,
          });
        } else if (result.aiUsed.deepFormat && !autoEnqueue) {
          bibleFanout = { enqueued: 0, skipped: true, reason: 'bibleAutoEnqueueOnDeepFormat is off' };
        }
      } catch (err) {
        log('warn', 'bible-fanout', `Auto-enqueue failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }

      await updateJob(jobId, {
        status: 'completed',
        progress: 100,
        stage: 'done',
        outputPath: out,
        aiModel: settings.aiModel,
        aiProvider: settings.aiProvider,
        aiTotalTokens: totalTokens,
        aiTotalDurationMs: totalDurationMs,
        aiCallCount: totalCalls,
        aiGenerationTokensPerSecond: lastGenTokensPerSec,
        aiPromptTokensPerSecond: lastPromptTokensPerSec,
        logPath: jobLogPath(jobId),
        metadata: result.metadata as Record<string, unknown>,
        report: {
          validation: result.validation,
          repair: result.repairReport,
          deepFormatAiCalls: result.deepFormatAiCalls ?? 0,
          deepFormatWarning: result.deepFormatWarning,
          deepFormatSidecar: result.deepFormatSidecar,
          deepFormatSidecarError: result.deepFormatSidecarError,
          bibleFanout,
        },
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'failed', msg);
      console.error(`[worker] Job ${jobId} failed: ${msg}`);
      await updateJob(jobId, {
        status: 'failed',
        errorMsg: msg,
        logPath: jobLogPath(jobId),
      });
      throw err;
    } finally {
      clearInterval(heartbeat);
      heartbeatTimers.delete(jobId);
    }
  },
  {
    connection,
    // Construction uses a safe default; startup immediately applies the
    // persisted setting through BullMQ's runtime concurrency setter.
    concurrency: 2,
    limiter: { max: 60, duration: 60_000 }, // generous: 60 jobs/min
    // AI enhancement on a 12-chapter book takes ~10-15 min on slow local
    // models (5-15 tok/s × 12 chapters × ~700 output tokens each). The
    // default 30s lockDuration + 15s renewal would mark the job as stalled
    // mid-pipeline. Use an 8-min lock with 1-min renewal — comfortable
    // headroom for both light enhance AND deep format paths, plus the
    // MOBI→EPUB Calibre pre-step (Phase 4.3) which adds a few seconds at
    // the start of the job.
    lockDuration: 8 * 60_000,
    lockRenewTime: 60_000,
    // Give the worker 1 min to detect a truly-stalled job (vs the 30s
    // default, which would falsely fire on a long AI call).
    stalledInterval: 60_000,
    maxStalledCount: 2,
  },
);

// Periodically update concurrency from settings (BullMQ supports changing
// this value live; active jobs are not interrupted).
setInterval(async () => {
  try {
    const n = await getWorkerConcurrency();
    if (n !== activeConcurrency) {
      worker.concurrency = n;
      activeConcurrency = n;
    }
  } catch { /* noop */ }
}, 30_000).unref();

worker.on('completed', () => {
  // Completion is already recorded via persistent job metadata/logs.
});

worker.on('failed', (job, err) => {
  console.error(`[worker] ✗ ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[worker] Worker error:', err);
});

let shuttingDown = false;
let staleSweeperHandle: NodeJS.Timeout | null = null;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceTimer = setTimeout(() => {
    console.error('[worker] graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();
  if (staleSweeperHandle) {
    clearInterval(staleSweeperHandle);
    staleSweeperHandle = null;
  }
  await shutdownPing();
  await worker.close();
  await pingConnection.quit().catch(() => undefined);
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

// ── Stale-job sweep ──────────────────────────────────────────────────────
// If the worker dies while a job is processing (OOM, SIGKILL, host
// crash, or someone killing the script directly), the DB row stays in
// `processing` forever because no BullMQ event will ever fire for it.
// We periodically mark such rows as `failed` so the UI shows the truth
// and the user can re-queue. We only touch rows older than 15 minutes
// so a briefly-overlapping replacement process cannot clobber live
// work. This sweeps the `Job` table for the conversion queue; the
// audiobook worker owns its own recovery path.
async function sweepStaleProcessingJobs(): Promise<void> {
  // The same idea applies to AudiobookChapter rows that got stuck in
  // 'generating' because the worker died mid-pipeline: there's no
  // Python child to clean up (the supervisor restarts the whole worker),
  // but the DB row would never recover on its own and the UI would show
  // a chapter stuck at <100% forever.
  //
  // Why raw $executeRaw instead of prisma.X.updateMany:
  //   Prisma 5.22.0 on SQLite has a bug where updateMany with a
  //   DateTime WHERE filter (`updatedAt < someDate`) silently matches
  //   zero rows even when findMany/findFirst returns the matching rows.
  //   We hit this on Job (the conversion queue) and AudiobookChapter.
  //   Raw executeRaw with bound ISO string works correctly. There are
  //   no user-controlled values in this query, so the SQL is safe.
  const staleBeforeIso = new Date(Date.now() - 15 * 60_000).toISOString();

  // 1) Job rows — conversion queue
  // strftime normalizes the stored "YYYY-MM-DD HH:MM:SS" text to the
  // ISO "YYYY-MM-DDTHH:MM:SS.sssZ" form so the lexicographic comparison
  // matches the chronological comparison. Without strftime, a fresh
  // row "2026-09-02 23:23:30" compares less than "2026-09-02T23:08:30Z"
  // for the wrong reason (' ' < 'T' at position 11) and gets swept.
  try {
    const recovered = await prisma.$executeRawUnsafe(
      `UPDATE Job SET status='failed', errorMsg=? WHERE status='processing' AND strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt) < ?`,
      'Worker was offline while this conversion was running. Requeue the book to try again.',
      staleBeforeIso,
    );
    if (recovered > 0) {
      console.warn(
        `[worker] sweep: recovered ${recovered} stale processing job(s) — marked failed.`,
      );
    }
  } catch (err) {
    console.error('[worker] Job sweep failed (will retry):', err);
  }

  // 2) AudiobookChapter rows — audiobook pre-generation pipeline
  try {
    const recoveredChapters = await prisma.$executeRawUnsafe(
      `UPDATE AudiobookChapter SET status='failed', errorMsg=? WHERE status='generating' AND strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt) < ?`,
      'Worker was offline while this chapter was generating. Re-queue from the Audiobook panel to retry.',
      staleBeforeIso,
    );
    if (recoveredChapters > 0) {
      console.warn(
        `[worker] sweep: recovered ${recoveredChapters} stale audiobook chapter(s) — marked failed.`,
      );
    }
  } catch (err) {
    console.error('[worker] AudiobookChapter sweep failed (will retry):', err);
  }
}

function startStaleSweeper(): NodeJS.Timeout {
  // Every 5 minutes. Lightweight (one indexed scan + 0–N row updates).
  const handle = setInterval(() => {
    void sweepStaleProcessingJobs();
  }, 5 * 60_000);
  handle.unref(); // don't keep the process alive just for the sweeper
  return handle;
}

(async () => {
  const n = await getWorkerConcurrency();
  activeConcurrency = n;
  worker.concurrency = n;

  // Run once at boot to clear anything left over from a previous crash
  // that wasn't caught by a startup sweep elsewhere.
  await sweepStaleProcessingJobs();

  // Then continue sweeping periodically for the lifetime of the worker.
  // Without this, a mid-runtime crash (worker dies but DB is intact) only
  // gets cleaned up at the next worker restart — which, if the launcher
  // supervises and auto-restarts immediately, the user might never notice.
  staleSweeperHandle = startStaleSweeper();

  // Also start the audiobook worker so audiobook jobs sitting on the
  // 'ebook-audiobook' queue actually get processed. Without this, books
  // enqueue but never generate audio — see commit log for context.
  try {
    const { startAudiobookWorker } = await import('./audiobook');
    await startAudiobookWorker();
  } catch (e) {
    console.error('[worker] Failed to start audiobook worker:', e);
  }
})();

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
import { getSettings } from '../lib/db/settings';
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
    const s = await getSettings();
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
      const settings = await getSettings();
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
        },
      });

      console.log(`[worker] Job ${jobId} completed → ${out} (${tokPerSec} tok/s avg)`);
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
      console.log(`[worker] Concurrency changed: ${activeConcurrency} → ${n}`);
      worker.concurrency = n;
      activeConcurrency = n;
    }
  } catch { /* noop */ }
}, 30_000).unref();

worker.on('completed', (job) => {
  console.log(`[worker] ✓ ${job.id} done`);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] ✗ ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[worker] Worker error:', err);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received; draining active work`);
  const forceTimer = setTimeout(() => {
    console.error('[worker] graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();
  await shutdownPing();
  await worker.close();
  await pingConnection.quit().catch(() => undefined);
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

(async () => {
  const n = await getWorkerConcurrency();
  activeConcurrency = n;
  worker.concurrency = n;
  console.log(`[worker] EPUB conversion worker started (concurrency=${n} from settings)`);

  // A hard-killed worker leaves rows in `processing`; no future BullMQ
  // event can complete them. Recover only sufficiently old rows so a
  // briefly overlapping replacement process cannot clobber live work.
  const staleBefore = new Date(Date.now() - 15 * 60_000);
  const recovered = await prisma.job.updateMany({
    where: { status: 'processing', updatedAt: { lt: staleBefore } },
    data: {
      status: 'failed',
      errorMsg: 'Worker restarted while this conversion was still running. Requeue the book to try again.',
    },
  });
  if (recovered.count > 0) {
    console.warn(`[worker] recovered ${recovered.count} stale processing job(s)`);
  }

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

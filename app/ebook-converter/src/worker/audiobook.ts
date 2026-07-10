// src/worker/audiobook.ts
// Audiobook worker – runs alongside the conversion worker.
// Reads each chapter, calls Python pre-generation script, updates DB.
//
// Usage:  tsx src/worker/audiobook.ts
// Or in worker/index.ts: register the worker.
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

import { Worker, Job, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { redisConnection } from '../lib/queue';
import {
  getBook,
} from '../lib/db/books';
import {
  listVoices,
  getDefaultVoice,
  listCharacters,
} from '../lib/db/voices';
import { BUILTIN_VIENEU_NAMES } from '../lib/tts/vieneu-voices';
import {
  ensureChapterRow,
  updateChapter,
  getChapter,
  listChapters,
  setBookAudiobookStatus,
  getAudiobookSummary,
} from '../lib/db/audiobook';
import { parseEpub } from '../lib/pipeline/epub-parser';

const PYTHON = process.env.TTS_PYTHON ?? '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11';

function resolveTtsServiceDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '..', 'tts-service'),
    path.resolve(process.cwd(), 'app', 'tts-service'),
    path.resolve(process.cwd(), 'tts-service'),
    '/Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'audiobook_generator.py'))) {
      return p;
    }
  }
  return null;
}

const TTS_SERVICE = resolveTtsServiceDir();
const GENERATOR = TTS_SERVICE ? path.join(TTS_SERVICE, 'audiobook_generator.py') : null;
const VENV_PY = TTS_SERVICE ? path.join(TTS_SERVICE, '.venv-moss-nano/bin/python') : null;
const DATA_DIR = path.resolve(process.cwd(), 'data/audiobooks');
const UNIFIED_TTS_URL = process.env.UNIFIED_TTS_URL ?? 'http://127.0.0.1:5010';

// Belt-and-suspenders: coerce any stale/mistyped backend value to a known
// one before spawning the Python subprocess. argparse in
// audiobook_generator.py will SystemExit(2) on unknown values, which would
// abort in-flight BullMQ jobs that still carry a legacy backend string.
const ALLOWED_BACKENDS = new Set(['vieneu', 'piper', 'moss-nano']);
function coerceBackend(raw: string | undefined): 'vieneu' | 'piper' | 'moss-nano' {
  const v = raw ?? 'vieneu';
  if (ALLOWED_BACKENDS.has(v)) return v as 'vieneu' | 'piper' | 'moss-nano';
  console.warn(`[audiobook-worker] unknown backend "${v}" coerced to "vieneu"`);
  return 'vieneu';
}

function pickPython(): string {
  // Use the Moss venv python if it has the unified_server module, else system.
  if (VENV_PY && fs.existsSync(VENV_PY)) return VENV_PY;
  return PYTHON;
}

async function runGenerator(opts: {
  bookId: string;
  chapterFile: string;
  backend: string;
  language: string;
  chapterTextFile: string;
  outDir: string;
  charactersJson: string;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (!GENERATOR || !fs.existsSync(GENERATOR)) {
      reject(new Error(`audiobook_generator.py not found. TTS_SERVICE=${TTS_SERVICE}`));
      return;
    }
    const py = pickPython();
    const args = [
      GENERATOR,
      '--book-id', opts.bookId,
      '--chapter-file', opts.chapterFile,
      '--backend', coerceBackend(opts.backend),
      '--language', opts.language,
      '--chapter-text-file', opts.chapterTextFile,
      '--out-dir', opts.outDir,
    ];
    const proc = spawn(py, args, {
      env: { ...process.env, UNIFIED_TTS_URL, CHARACTER_MAP: opts.charactersJson },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

function htmlBody(html: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return m ? m[1] : html;
}

async function computeAudiobookConfigHash(bookId: string, backend: string): Promise<string> {
  const [voices, characters] = await Promise.all([
    listVoices(bookId),
    listCharacters(bookId),
  ]);
  const payload = {
    backend,
    voices: voices.map((v) => ({
      id: v.id,
      name: v.name,
      refAudioPath: v.refAudioPath,
      language: v.language,
      isDefault: v.isDefault,
      defaultSpeed: v.defaultSpeed,
      defaultEmotion: v.defaultEmotion,
      kind: v.kind,
      builtinName: v.builtinName,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    characters: characters.map((c) => ({
      name: c.name,
      aliases: c.aliases ?? [],
      voiceId: c.voiceId,
      role: c.role,
      age: c.age,
      gender: c.gender,
      tone: c.tone,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function removeAudioFile(audioPath?: string | null): void {
  if (!audioPath) return;
  try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch {}
}

/** Convert a WAV file to MP3 using ffmpeg. Returns the duration in ms
 *  if successful, null otherwise (e.g. ffmpeg not installed). */
async function convertToMp3(
  wavPath: string, mp3Path: string,
): Promise<{ durationMs: number } | null> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-y',                     // overwrite
      '-i', wavPath,
      '-codec:a', 'libmp3lame', // MP3 encoder
      '-b:a', '96k',            // 96 kbps — good for Vietnamese speech
      '-ac', '1',               // mono
      '-ar', '24000',           // downsample to 24 kHz (VieNeu internally resamples anyway)
      mp3Path,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      console.warn(`[audiobook] ffmpeg not available (${err.message}); keeping WAV`);
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[audiobook] ffmpeg exit ${code}: ${stderr.slice(-300)}`);
        resolve(null);
        return;
      }
      // Parse duration from the output (ffmpeg writes "Duration: HH:MM:SS.MS" to stderr)
      // We didn't capture progress, so use ffprobe or estimate from file size
      // For accuracy, re-run a tiny ffprobe:
      const probe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        mp3Path,
      ]);
      let probeOut = '';
      probe.stdout.on('data', (d) => { probeOut += d.toString(); });
      probe.on('error', () => {
        // Fallback: estimate from size (96 kbps / 8 = 12 KB/s, but actual ≈ 11.5)
        const sizeBytes = fs.statSync(mp3Path).size;
        const durationMs = Math.round((sizeBytes / 12000) * 1000);
        resolve({ durationMs });
      });
      probe.on('close', () => {
        const secs = parseFloat(probeOut.trim());
        if (Number.isFinite(secs) && secs > 0) {
          resolve({ durationMs: Math.round(secs * 1000) });
        } else {
          const sizeBytes = fs.statSync(mp3Path).size;
          const durationMs = Math.round((sizeBytes / 12000) * 1000);
          resolve({ durationMs });
        }
      });
    });
  });
}

async function generateOneChapter(bookId: string, chapterFile: string, backend: string, opts: { force?: boolean } = {}) {
  const book = await getBook(bookId);
  if (!book) throw new Error('book not found');

  const configHash = await computeAudiobookConfigHash(bookId, backend);
  const existing = await getChapter(bookId, chapterFile);
  if (!opts.force && existing?.status === 'ready' && existing.configHash === configHash && existing.audioPath && fs.existsSync(existing.audioPath)) {
    console.log(`[audiobook] ${bookId}/${chapterFile} up-to-date; skipping`);
    return;
  }
  if (existing?.audioPath && (opts.force || existing.configHash !== configHash)) {
    removeAudioFile(existing.audioPath);
    await updateChapter(existing.id, {
      status: 'pending',
      progress: 0,
      audioPath: null,
      durationMs: null,
      sizeBytes: null,
      errorMsg: null,
      generatedAt: null,
      configHash,
    });
  }

  // Pre-create row
  const row = await ensureChapterRow({
    bookId,
    chapterFile,
    chapterTitle: chapterFile.replace(/^.*\//, '').replace(/\.x?html$/i, ''),
    configHash,
  });

  await updateChapter(row.id, { status: 'generating', progress: 5, errorMsg: null, configHash });

  // Parse the EPUB once and find the chapter HTML
  const epub = await parseEpub(book.filePath);
  const htmlEntry = epub.entries.get(chapterFile);
  if (!htmlEntry) {
    await updateChapter(row.id, { status: 'failed', errorMsg: `Chapter file not in EPUB: ${chapterFile}` });
    return;
  }

  // Load voices + characters
  const voices = await listVoices(bookId);
  const voicesById: Record<string, {
    name: string;
    refAudioPath: string;
    defaultSpeed?: number | null;
    defaultEmotion?: string | null;
    builtinName?: string | null;
    isBuiltinVieNeu?: boolean;
  }> = {};

  const BUILTIN_VIENEU = new Set(BUILTIN_VIENEU_NAMES);

  for (const v of voices) {
    const builtinName = v.builtinName ?? (BUILTIN_VIENEU.has(v.name) ? v.name : null);
    voicesById[v.id] = {
      name: builtinName ?? v.name,
      refAudioPath: v.refAudioPath ?? '',
      defaultSpeed: v.defaultSpeed,
      defaultEmotion: v.defaultEmotion,
      builtinName,
      isBuiltinVieNeu: !!builtinName,
    };
  }

  const characters = await listCharacters(bookId);
  // Build a fast alias → character-name lookup for dialogue attribution
  const charByAlias: Record<string, { name: string; voiceId: string | null }> = {};
  for (const c of characters) {
    const candidates = [c.name, ...(c.aliases ?? [])];
    for (const alias of candidates) {
      charByAlias[alias.toLowerCase()] = { name: c.name, voiceId: c.voiceId };
    }
  }

  const defaultVoice = await getDefaultVoice(bookId);

  // Pass character→voice map to Python generator via env var (JSON-encoded)
  // so the generator can attribute dialogue to the right character.
  const voicesForGenerator: Record<string, {
    name: string;
    refAudioPath: string;
    isBuiltinVieNeu?: boolean;
    defaultSpeed?: number | null;
    defaultEmotion?: string | null;
  }> = {};
  for (const [vid, v] of Object.entries(voicesById)) {
    voicesForGenerator[vid] = {
      name: v.builtinName ?? v.name,
      refAudioPath: v.refAudioPath,
      isBuiltinVieNeu: v.isBuiltinVieNeu,
      defaultSpeed: v.defaultSpeed,
      defaultEmotion: v.defaultEmotion,
    };
  }
  const charactersJson = JSON.stringify({
    voices_by_id: voicesForGenerator,
    characters: characters.map((c) => ({
      name: c.name,
      aliases: c.aliases ?? [],
      voiceId: c.voiceId,
      gender: c.gender ?? null,
    })),
    default_voice_id: defaultVoice?.id ?? null,
  });

  // Dump chapter body to a temp file for the Python generator
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-'));
  const tmpHtml = path.join(tmpDir, 'chapter.xhtml');
  const bodyHtml = htmlBody(htmlEntry.data.toString('utf8'));
  fs.writeFileSync(tmpHtml, bodyHtml, 'utf8');

  // outDir must be the per-book directory; the Python generator will NOT
  // append book_id again (that would create data/audiobooks/<id>/<id>/file.wav).
  const outDir = path.join(DATA_DIR, bookId);
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const { stdout, stderr, code } = await runGenerator({
      bookId,
      chapterFile,
      backend,
      language: book.language ?? 'vi',
      chapterTextFile: tmpHtml,
      outDir,
      charactersJson,
    });

    if (code !== 0) {
      await updateChapter(row.id, {
        status: 'failed',
        errorMsg: (stderr || stdout).slice(0, 1000),
      });
      console.error(`[audiobook] ${bookId}/${chapterFile} FAILED (exit ${code})`);
      console.error(stderr.slice(-500));
      return;
    }

    // Generator wrote file. Find it.
    const safe = chapterFile.replace(/\//g, '_').replace(/\\/g, '_').replace(/\.x?html$/, '');
    const wavPath = path.join(outDir, `${safe}.wav`);
    if (!fs.existsSync(wavPath)) {
      await updateChapter(row.id, { status: 'failed', errorMsg: `output WAV not found at ${wavPath}` });
      return;
    }

    // ── Convert WAV → MP3 (saves ~7.7× disk space) ──────────────────────
    // VieNeu-TTS outputs 48 kHz 16-bit mono WAV. We re-encode at 96 kbps
    // mono MP3 — high quality for Vietnamese speech (preserves tones) at
    // a fraction of the size. Audiobook files rarely need higher fidelity.
    const mp3Path = path.join(outDir, `${safe}.mp3`);
    let audioPath = wavPath;
    let sizeBytes = fs.statSync(wavPath).size;
    let durationMs = Math.round((sizeBytes / 88200) * 1000); // 44.1 kHz × 16-bit mono ≈ 88.2 KB/s

    const mp3Converted = await convertToMp3(wavPath, mp3Path);
    if (mp3Converted) {
      // Replace WAV with MP3 — delete the WAV to save space
      try { fs.unlinkSync(wavPath); } catch {}
      audioPath = mp3Path;
      sizeBytes = fs.statSync(mp3Path).size;
      // Get exact duration from ffmpeg's stderr output (more accurate than file-size estimate)
      durationMs = mp3Converted.durationMs;
    }

    await updateChapter(row.id, {
      status: 'ready',
      progress: 100,
      audioPath,
      sizeBytes,
      durationMs,
      generatedAt: new Date(),
      configHash,
    });
    const ratio = mp3Converted ? ` (MP3 ${(sizeBytes/1024).toFixed(0)} KB)` : ` (WAV ${(sizeBytes/1024).toFixed(0)} KB)`;
    console.log(`[audiobook] ${bookId}/${chapterFile} ready (${(sizeBytes/1024).toFixed(0)} KB, ${(durationMs/1000).toFixed(1)}s)${ratio}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export async function generateEntireBook(bookId: string, backend: string) {
  const book = await getBook(bookId);
  if (!book) throw new Error('book not found');

  const epub = await parseEpub(book.filePath);
  const chapterFiles = epub.htmlFiles.filter((f) => !/cover\.(x?html?)$/i.test(f));

  console.log(`[audiobook] Book ${bookId}: ${chapterFiles.length} chapters to generate with ${backend}`);
  await setBookAudiobookStatus(bookId, 'generating');

  let totalDurMs = 0;
  let firstError: string | null = null;
  let generatedCount = 0;
  let stoppedByUser = false;

  for (const chapterFile of chapterFiles) {
    // Check stop signal between chapters
    const fresh = await getBook(bookId);
    if (fresh && (fresh as { audiobookStatus?: string }).audiobookStatus === 'none') {
      console.log(`[audiobook] Book ${bookId}: stopped by user — halting after ${generatedCount} chapters`);
      stoppedByUser = true;
      break;
    }
    try {
      await generateOneChapter(bookId, chapterFile, backend);
      const row = await listChapters(bookId).then((rows) => rows.find((r) => r.chapterFile === chapterFile));
      if (row?.status === 'ready') {
        totalDurMs += row.durationMs ?? 0;
        generatedCount++;
      } else if (row?.errorMsg && !firstError) {
        firstError = row.errorMsg;
      }
    } catch (err) {
      console.error(`[audiobook] chapter ${chapterFile} threw:`, err);
    }
  }

  const summary = await getAudiobookSummary(bookId);
  let status: 'ready' | 'partial' | 'failed' | 'none' = 'ready';
  if (stoppedByUser) {
    status = summary.failed > 0 ? 'partial' : (summary.ready > 0 ? 'partial' : 'none');
  } else if (summary.ready === 0 && summary.failed > 0) {
    status = 'failed';
  } else if (summary.failed > 0) {
    status = 'partial';
  }

  await setBookAudiobookStatus(bookId, status, { durationMs: totalDurMs, generatedAt: new Date() });
  console.log(`[audiobook] Book ${bookId} done: ${generatedCount}/${chapterFiles.length} ready${stoppedByUser ? ' (stopped)' : ''}, ${(totalDurMs/60000).toFixed(1)} min`);
  if (firstError && status === 'failed') console.error(`[audiobook] first error: ${firstError}`);
}

// ── Start audiobook worker (call from index.ts or standalone) ─────────────
export async function startAudiobookWorker(): Promise<{ worker: Worker }> {
  const conn = new IORedis(redisConnection);

  const worker = new Worker(
    'ebook-audiobook',
    async (job: Job) => {
      const data = job.data as { bookId: string; chapterFile?: string; backend?: string };
      if (data.chapterFile) {
        await generateOneChapter(data.bookId, data.chapterFile, data.backend ?? 'vieneu', { force: (data as { force?: boolean }).force });
      } else {
        await generateEntireBook(data.bookId, data.backend ?? 'vieneu');
      }
    },
    { connection: conn, concurrency: 1, limiter: { max: 2, duration: 60_000 } },
  );

  worker.on('completed', (job) => console.log(`[audiobook-worker] ✓ ${job.id}`));
  worker.on('failed', (job, err) => console.error(`[audiobook-worker] ✗ ${job?.id}: ${err.message}`));

  process.on('SIGTERM', async () => { await worker.close(); });
  process.on('SIGINT',  async () => { await worker.close(); });

  console.log('[audiobook-worker] Listening on queue ebook-audiobook (concurrency=1)');
  return { worker };
}

// ── Standalone worker ──────────────────────────────────────────────────────
if (require.main === module) {
  startAudiobookWorker().catch((e) => {
    console.error('[audiobook-worker] failed to start:', e);
    process.exit(1);
  });
}

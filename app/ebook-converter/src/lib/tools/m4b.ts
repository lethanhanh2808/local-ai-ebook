// src/lib/tools/m4b.ts
//
// Phase 4.5 of docs/NEXT_UP_PLAN.md — concatenate per-chapter MP3s into a
// single .m4b file with chapter markers + embedded cover art. Apple Books
// / Voice / podcast apps use the .m4b extension + `covr` atom (cover) +
// `chpl` atom (chapters) for native recognition.
//
// Design notes:
//
//   1. Mirrors `convertToMp3` graceful-degradation at
//      src/worker/audiobook.ts:217-275 — typed errors via M4BExportError,
//      stderr tail for diagnostics, proc.on('error') catch for missing
//      binary. exportM4B rejects synchronously on missing-binary so callers
//      can surface a 503 with the install hint, matching the Calibre probe
//      pattern at src/lib/tools/calibre.ts.
//
//   2. Mirrors `CalibreConvertError` typed-error shape at
//      src/lib/tools/calibre.ts:187-206. Code variants:
//      - 'ENOENT'    ffmpeg binary missing OR input file not readable
//      - 'ETIMEOUT'  process killed by SIGTERM after timeoutMs
//      - 'ENONZERO'  ffmpeg exited with non-zero status
//      - 'ESAFEPATH' audioPath or coverPath failed assertWithinRoots
//      - 'EUNKNOWN'  anything else (rare; fallthrough)
//
//   3. Defense-in-depth path validation — even though the upstream route
//      validates audioPath / coverPath with assertWithinRoots, exportM4B
//      re-validates because ffmpeg will open ANY readable file via the
//      `-i file:'...'` argument. A path-traversal DB row pointing at
//      /etc/passwd becomes a read primitive as soon as you encode it.
//      Cost: microseconds per call. Cost of skipping: unbounded.
//
//   4. Per-book mutex via exportM4BOnce — double-clicking the Download
//      button would otherwise spawn two parallel ffmpeg processes
//      re-encoding the same 30 chapter MP3s (CPU waste). Second call
//      piggybacks on the first build (same Promise, same output file).
//
//   5. Chapter duration drift — `chapter.durationMs` is from a single
//      ffprobe at MP3 conversion time. ±50 ms drift × 30 chapters = ±1.5 s
//      cumulative misalignment in Apple Books chapter boundaries. The route
//      calls `getActualDurations()` batch ffprobe immediately before export
//      to refresh; exportM4B accepts the override via `durations`.
//
//   6. Cover embedding flag is `-map 2:v -c:v copy -disposition:v:0 attached_pic`,
//      NOT `-attach`. `-attach` creates a generic `attachment` atom that
//      most players ignore. Apple Books / Voice look for `covr` (a video
//      stream with `attached_pic` disposition).

import { spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { assertWithinRoots, pathRoots } from '@/lib/storage/safe-path';

export interface M4BChapterInput {
  /** Absolute path to the per-chapter MP3 (must be in audiobooks root). */
  audioPath: string;
  /** Chapter title (UTF-8 OK; preserved verbatim in FFMETADATA1). */
  title: string;
  /** Duration hint in ms. Override via `durations` when calling exportM4B. */
  durationMs: number;
}

export interface M4BExportOptions {
  /** Absolute path for the output .m4b file. */
  outputPath: string;
  /** Book title — written into the global FFMETADATA1 `title=` field. */
  bookTitle: string;
  /** Author — written into the global FFMETADATA1 `artist=` field. */
  author?: string;
  /** Ordered list of chapters (must match order in audiobook DB). */
  chapters: M4BChapterInput[];
  /** Optional cover art (must be in uploads or library root). */
  coverPath?: string;
  /**
   * Override durationMs for each chapter (1:1 with chapters[]). Pass the
   * output of getActualDurations() to fix cumulative drift.
   */
  durations?: number[];
  /** Temp dir for filelist.txt + metadata.txt. Callers choose. */
  tmpDir: string;
  /** Throttled stderr tail — called with the most recent stderr chunk. */
  onLog?: (chunk: string) => void;
  /** Hard timeout in ms. Default 300_000 (5 min). */
  timeoutMs?: number;
  /** Override the binary path (defaults to `ffmpeg` on PATH). */
  binaryPath?: string;
}

export interface M4BExportResult {
  outputPath: string;
  bytes: number;
  durationMs: number;
}

export class M4BExportError extends Error {
  constructor(
    message: string,
    public code: 'ENOENT' | 'ETIMEOUT' | 'ENONZERO' | 'ESAFEPATH' | 'EUNKNOWN',
    public stderr?: string,
  ) {
    super(message);
    this.name = 'M4BExportError';
  }
}

// ── Pure: FFMETADATA1 builder ────────────────────────────────────────────────

/** Escape a string for use as a value in an FFMETADATA1 file.
 *  Per the spec, the value side of `key=value` may contain any character
 *  EXCEPT `=`, `;`, `#`, `\` and a newline. Backslashes MUST be escaped
 *  first to avoid double-escaping the other escapes. */
function escapeMetadataValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')   // backslash first
    .replace(/=/g, '\\=')
    .replace(/;/g, '\\;')
    .replace(/#/g, '\\#')
    .replace(/\n/g, '\\\n');
}

/** Build the FFMETADATA1 file body. Pure — easy to unit-test.
 *  Throws on empty chapters (Apple Books rejects an M4B with no chapters). */
export function buildFfMetadata(opts: {
  title: string;
  artist?: string;
  chapters: Array<{ title: string; durationMs: number }>;
}): string {
  if (!opts.chapters || opts.chapters.length === 0) {
    throw new Error('buildFfMetadata: chapters array is empty');
  }
  const lines: string[] = [';FFMETADATA1', ''];
  lines.push(`title=${escapeMetadataValue(opts.title)}`);
  if (opts.artist) lines.push(`artist=${escapeMetadataValue(opts.artist)}`);
  lines.push('');

  let cursor = 0;
  for (const ch of opts.chapters) {
    if (!Number.isFinite(ch.durationMs) || ch.durationMs <= 0) {
      throw new Error(`buildFfMetadata: invalid durationMs ${ch.durationMs} for "${ch.title}"`);
    }
    const start = cursor;
    const end = cursor + Math.round(ch.durationMs);
    cursor = end;
    lines.push('[CHAPTER]');
    lines.push('TIMEBASE=1/1000');
    lines.push(`START=${start}`);
    lines.push(`END=${end}`);
    lines.push(`title=${escapeMetadataValue(ch.title)}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Path validation ─────────────────────────────────────────────────────────

/** Validate inputs and return a sanitized copy of opts with coverPath
 *  cleared if the cover FILE is missing on disk (the cover is optional,
 *  so a missing file silently falls back to an audio-only M4B). A
 *  cover path that escapes the allowed roots is NOT silently dropped
 *  — that would mask the same security event `ESAFEPATH` exists to
 *  surface for audio paths. */
function validateInputs(opts: M4BExportOptions): M4BExportOptions {
  const roots = pathRoots();
  const audioRoots = [roots.audiobooks];
  const coverRoots = [roots.uploads, roots.library];

  for (const ch of opts.chapters) {
    let safe: string;
    try {
      safe = assertWithinRoots(ch.audioPath, audioRoots);
    } catch (err) {
      if (err instanceof M4BExportError) throw err;
      throw new M4BExportError(
        `Chapter audio path outside audiobooks root: ${ch.audioPath}`,
        'ESAFEPATH',
      );
    }
    // Path is inside the root — check existence separately so the route
    // surfaces a 500 (data loss / race condition) rather than masking it
    // as a 500 ESAFEPATH (security/traversal). The path itself is NOT
    // echoed back to the client in the route handler.
    if (!existsSync(safe)) {
      throw new M4BExportError(
        `Chapter audio file not found on disk`,
        'EUNKNOWN',
      );
    }
  }

  let coverPath = opts.coverPath;
  if (coverPath) {
    let safe: string;
    try {
      safe = assertWithinRoots(coverPath, coverRoots);
    } catch (err) {
      if (err instanceof M4BExportError) throw err;
      throw new M4BExportError(
        `Cover path outside uploads/library root: ${coverPath}`,
        'ESAFEPATH',
      );
    }
    // Path is in-root; only a missing FILE is silent-stripped (the cover
    // is optional — audio still exports successfully).
    if (!existsSync(safe)) coverPath = undefined;
  }

  return { ...opts, coverPath };
}

// ── Spawn ────────────────────────────────────────────────────────────────────

/** Build the filelist (concat demuxer format) and run ffmpeg to produce the
 *  .m4b. Mirrors `convertWithCalibre` at src/lib/tools/calibre.ts:201-304. */
export async function exportM4B(opts: M4BExportOptions): Promise<M4BExportResult> {
  if (!opts.chapters || opts.chapters.length === 0) {
    throw new M4BExportError('Cannot export M4B: book has no chapters', 'EUNKNOWN');
  }
  if (!opts.tmpDir) {
    throw new M4BExportError('exportM4B: tmpDir is required', 'EUNKNOWN');
  }

  // validateInputs may strip coverPath if the cover file is missing on
  // disk (a path-traversal rejection for the cover now throws ESAFEPATH
  // synchronously rather than silently stripping — see validateInputs).
  // Use the returned sanitized copy from here on; do NOT mutate the
  // caller's opts (the route passes the same object elsewhere).
  const safe = validateInputs(opts);

  const binary = safe.binaryPath ?? 'ffmpeg';
  const timeoutMs = safe.timeoutMs ?? 300_000;

  // Use the override durations when provided (drift correction); otherwise
  // fall back to the per-chapter durationMs hints.
  const durations = safe.durations ?? safe.chapters.map((c) => c.durationMs);

  const metaBody = buildFfMetadata({
    title: safe.bookTitle,
    artist: safe.author,
    chapters: safe.chapters.map((ch, i) => ({
      title: ch.title || `Chương ${i + 1}`,
      durationMs: durations[i] ?? ch.durationMs,
    })),
  });
  const metaPath = `${safe.tmpDir}/metadata.txt`;
  writeFileSync(metaPath, metaBody, 'utf8');

  // Build concat demuxer filelist. Lines are `file 'absolute/path'`.
  // We escape single quotes per the concat demuxer spec.
  const fileLines = safe.chapters
    .map((ch) => {
      const esc = ch.audioPath.replace(/'/g, "'\\''");
      return `file '${esc}'`;
    })
    .join('\n');
  const listPath = `${safe.tmpDir}/filelist.txt`;
  writeFileSync(listPath, fileLines + '\n', 'utf8');

  // Build the ffmpeg arg set. The cover presence shifts the input indices
  // and the `-map` chain, so we branch entirely.
  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',                            // overwrite
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,                  // index 0: chapter audio
    '-i', metaPath,                  // index 1: chapter + global metadata
  ];
  if (safe.coverPath) {
    args.push('-i', safe.coverPath); // index 2: cover image
  }
  args.push('-map', '0:a');
  args.push('-map_metadata', '1');
  if (safe.coverPath) {
    args.push('-map', '2:v');
    args.push('-c:v', 'copy');
    args.push('-disposition:v:0', 'attached_pic');
  }
  args.push('-c:a', 'aac');
  args.push('-b:a', '96k');
  args.push('-ac', '1');
  args.push('-ar', '24000');
  args.push('-movflags', '+faststart');
  args.push(safe.outputPath);

  return new Promise<M4BExportResult>((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stderrTail = '';
    let settled = false;
    let lastLogTs = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new M4BExportError(
        `ffmpeg timed out after ${timeoutMs}ms`,
        'ETIMEOUT',
        stderrTail,
      ));
    }, timeoutMs);

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code: 'ENOENT' | 'EUNKNOWN' =
        (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ENOENT' : 'EUNKNOWN';
      reject(new M4BExportError(
        `Failed to spawn ffmpeg: ${err.message}`,
        code,
      ));
    });

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderrTail.length < 1024) {
        stderrTail = (stderrTail + text).slice(-1024);
      }
      const now = Date.now();
      if (safe.onLog && now - lastLogTs > 250) {
        lastLogTs = now;
        const lastLine = text.split('\n').filter(Boolean).pop() ?? text;
        safe.onLog(lastLine.slice(-200));
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new M4BExportError(
          `ffmpeg exited with code ${code}`,
          'ENONZERO',
          stderrTail,
        ));
        return;
      }
      try {
        const stat = statSync(safe.outputPath);
        const totalDurMs = durations.reduce((s, d) => s + d, 0);
        resolve({
          outputPath: safe.outputPath,
          bytes: stat.size,
          durationMs: totalDurMs,
        });
      } catch (err) {
        reject(new M4BExportError(
          `Output M4B missing after success: ${String(err)}`,
          'EUNKNOWN',
          stderrTail,
        ));
      }
    });
  });
}

// ── Drift correction: batch ffprobe ──────────────────────────────────────────

/** Probe each MP3's actual duration via a single ffprobe per file.
 *  Returns durations in ms, in the same order as `audioPaths`.
 *  Throws M4BExportError on missing binary; falls back to 0 for
 *  per-file probe failures (the caller can decide whether to retry). */
export async function getActualDurations(audioPaths: string[]): Promise<number[]> {
  return Promise.all(audioPaths.map((p) => probeOneDuration(p)));
}

function probeOneDuration(audioPath: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;

    proc.stdout?.on('data', (chunk) => { out += chunk.toString(); });
    proc.on('error', () => {
      if (settled) return;
      settled = true;
      // Missing ffprobe binary or per-file issue — fall back to 0 so the
      // build still proceeds (drift correction is best-effort).
      resolve(0);
    });
    proc.on('close', () => {
      if (settled) return;
      settled = true;
      const secs = parseFloat(out.trim());
      resolve(Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : 0);
    });
  });
}

// ── Per-book concurrency: piggyback ──────────────────────────────────────────

const _inflight = new Map<string, Promise<M4BExportResult>>();

/** Like exportM4B but de-duplicates concurrent calls for the same bookId.
 *  The first call runs the build; subsequent concurrent calls return the
 *  same Promise object. After the build settles, the entry is removed so
 *  the next click gets a fresh build. */
export async function exportM4BOnce(
  bookId: string,
  opts: M4BExportOptions,
): Promise<M4BExportResult> {
  const existing = _inflight.get(bookId);
  if (existing) return existing;
  const p = exportM4B(opts).finally(() => _inflight.delete(bookId));
  _inflight.set(bookId, p);
  return p;
}

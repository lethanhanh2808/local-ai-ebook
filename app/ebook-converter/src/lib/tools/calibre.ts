// src/lib/tools/calibre.ts
//
// Phase 4.3 of docs/NEXT_UP_PLAN.md — locate Calibre's `ebook-convert`
// binary and invoke it to pre-convert MOBI (and future PDF/DOCX/AZW3) to
// EPUB before the regular conversion pipeline runs.
//
// Design notes:
//
//   1. Single source of truth — both the upload route (UI surface) and the
//      worker (pre-step) call into `probeCalibre()`. Neither side does its
//      own binary resolution.
//
//   2. Mirrors `resolvePython()` at
//      src/app/api/library/[id]/characters/detect/route.ts:61-73: explicit
//      env override → candidate path chain → PATH fallback. We never shell
//      out to `which` / `command -v` because `spawn` doesn't carry the
//      standard PATH in containerized environments — fs.existsSync against
//      known locations is the codebase's house style.
//
//   3. Per-process in-memory cache (60 s TTL). No filesystem cache. The
//      upload route and worker are separate Node processes so each has its
//      own cache; we explicitly `force=true` in the worker pre-step so a
//      stale upload-route probe doesn't cause a doomed job to enqueue.
//
//   4. `convertWithCalibre()` mirrors the `convertToMp3` graceful-
//      degradation pattern at src/worker/audiobook.ts:217-275: attach a
//      `proc.on('error', err => ...)` handler so a missing binary surfaces
//      as a typed error rather than an unhandled exception. Cleans up the
//      staged output on failure so the uploads directory doesn't accumulate
//      half-written EPUBs.

import { spawn } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';

export interface CalibreProbeResult {
  ok: boolean;
  /** Absolute path to the ebook-convert binary. Null when ok=false. */
  path: string | null;
  /** Version string from `ebook-convert --version`, e.g. "calibre 7.19.0".
   *  Null when ok=false or the spawn failed before producing output. */
  version: string | null;
  /** Human-readable reason when ok=false. Null when ok=true. */
  error: string | null;
  /** When the probe was performed (epoch ms). */
  checkedAt: number;
}

export interface CalibreConvertOptions {
  /** Override the binary path (taken from probeCalibre by default). */
  binaryPath?: string;
  /** Throttled stderr tail — called with the most recent stderr chunk. */
  onLog?: (chunk: string) => void;
  /** Hard timeout in ms. Default 180_000 (3 min). */
  timeoutMs?: number;
  /** Extra CLI args appended after [input, output]. */
  extraArgs?: string[];
}

export interface CalibreConvertResult {
  outputPath: string;
  bytes: number;
  durationMs: number;
}

// ── Resolution chain ────────────────────────────────────────────────────────

/** Resolution order (first existing path wins). Env override takes priority.
 *  Order matches the comment block on resolvePython() at
 *  src/app/api/library/[id]/characters/detect/route.ts:61-73. */
const CANDIDATE_PATHS = [
  // Apple Silicon Homebrew
  '/opt/homebrew/bin/ebook-convert',
  // Intel Homebrew
  '/usr/local/bin/ebook-convert',
  // Debian/Ubuntu apt install calibre
  '/usr/bin/ebook-convert',
  // Manual /opt install
  '/opt/calibre/ebook-convert',
];

function resolveCandidatePath(): string | null {
  const envOverride = process.env.CALIBRE_EBOOK_CONVERT;
  if (envOverride && existsSync(envOverride)) return envOverride;
  for (const p of CANDIDATE_PATHS) {
    if (existsSync(p)) return p;
  }
  // PATH fallback — last resort. Return the bare name 'ebook-convert' so
  // probeCalibre() attempts the version spawn; if PATH doesn't have it,
  // spawn fails fast with ENOENT and we report ok=false. We deliberately
  // don't shell out to `which` because spawn doesn't carry the standard
  // PATH in containerized environments — fs.existsSync against known
  // locations is the codebase's house style (see resolvePython() in
  // src/app/api/library/[id]/characters/detect/route.ts:61-73).
  if (process.env.PATH && process.env.PATH.length > 0) {
    return 'ebook-convert';
  }
  return null;
}

// ── Probe ───────────────────────────────────────────────────────────────────

const CACHE_MS = 60_000;
let _cache: CalibreProbeResult | null = null;

/** Probe the host for `ebook-convert`. Cached per-process for CACHE_MS.
 *  Pass `force: true` to bypass the cache (used by the Settings "Re-check"
 *  button and by the worker pre-step so a stale upload-route probe doesn't
 *  doom a freshly-enqueued job). */
export async function probeCalibre(force = false): Promise<CalibreProbeResult> {
  const now = Date.now();
  if (!force && _cache && now - _cache.checkedAt < CACHE_MS) {
    return _cache;
  }

  const resolved = resolveCandidatePath();
  if (!resolved) {
    _cache = {
      ok: false,
      path: null,
      version: null,
      error: `ebook-convert not found. Searched: ${[
        process.env.CALIBRE_EBOOK_CONVERT,
        ...CANDIDATE_PATHS,
        'PATH',
      ]
        .filter(Boolean)
        .join(', ')}.`,
      checkedAt: now,
    };
    return _cache;
  }

  // For the absolute-path candidates we trust fs.existsSync; for the PATH
  // fallback we additionally spawn `--version` to confirm the binary is
  // actually callable (PATH may be empty inside the worker container). We
  // only do this on cold cache to keep the per-request cost to one spawn.
  if (resolved === 'ebook-convert') {
    try {
      const version = await spawnVersion(resolved);
      _cache = { ok: true, path: resolved, version, error: null, checkedAt: now };
    } catch (err) {
      _cache = {
        ok: false,
        path: null,
        version: null,
        error: `ebook-convert found on PATH but failed to run: ${String(err)}`,
        checkedAt: now,
      };
    }
    return _cache;
  }

  // Absolute-path candidate — confirm with a quick version probe so we
  // surface a friendly error message rather than failing at conversion time.
  try {
    const version = await spawnVersion(resolved);
    _cache = { ok: true, path: resolved, version, error: null, checkedAt: now };
  } catch (err) {
    _cache = {
      ok: false,
      path: null,
      version: null,
      error: `ebook-convert at ${resolved} failed to run: ${String(err)}`,
      checkedAt: now,
    };
  }
  return _cache;
}

function spawnVersion(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    proc.stdout?.on('data', (chunk) => {
      out += chunk.toString();
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && out.trim()) {
        resolve(out.trim().split('\n')[0]);
      } else {
        reject(new Error(`exit code ${code}`));
      }
    });
  });
}

// ── Convert ─────────────────────────────────────────────────────────────────

export class CalibreConvertError extends Error {
  constructor(
    message: string,
    public code: 'ENOENT' | 'ETIMEOUT' | 'ENONZERO' | 'EUNKNOWN',
    public stderr?: string,
  ) {
    super(message);
    this.name = 'CalibreConvertError';
  }
}

/** Convert `inputPath` (MOBI, or any format in CALIBRE_FORMATS) to EPUB at
 *  `outputPath`. Throws `CalibreConvertError` on failure. The half-written
 *  output is removed on failure so the uploads directory stays clean. */
export async function convertWithCalibre(
  inputPath: string,
  outputPath: string,
  opts: CalibreConvertOptions = {},
): Promise<CalibreConvertResult> {
  const probe = opts.binaryPath ? { ok: true as const, path: opts.binaryPath, version: null, error: null, checkedAt: Date.now() } : await probeCalibre();
  const binary = opts.binaryPath ?? probe.path;
  if (!binary) {
    throw new CalibreConvertError(
      probe.error ?? 'ebook-convert not available',
      'ENOENT',
    );
  }

  const timeoutMs = opts.timeoutMs ?? 180_000;
  const args = [inputPath, outputPath, ...(opts.extraArgs ?? [])];

  const t0 = Date.now();

  return new Promise<CalibreConvertResult>((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stderrTail = '';
    let settled = false;
    let lastLogTs = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      cleanupOutput();
      reject(new CalibreConvertError(
        `Calibre conversion timed out after ${timeoutMs}ms`,
        'ETIMEOUT',
        stderrTail,
      ));
    }, timeoutMs);

    function cleanupOutput() {
      try {
        if (existsSync(outputPath)) unlinkSync(outputPath);
      } catch { /* best-effort */ }
    }

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupOutput();
      reject(new CalibreConvertError(
        `Failed to spawn ebook-convert: ${err.message}`,
        'ENOENT',
      ));
    });

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Keep last 1 KB of stderr for diagnostics (avoids unbounded growth)
      if (stderrTail.length < 1024) {
        stderrTail = (stderrTail + text).slice(-1024);
      }
      // Throttle the onLog callback to 1/250 ms so we don't flood the log
      // file. Calibre writes progress lines at ~10 Hz on a typical MOBI.
      const now = Date.now();
      if (opts.onLog && now - lastLogTs > 250) {
        lastLogTs = now;
        // Trim to the last line so we log progress events, not arbitrary chunks.
        const lastLine = text.split('\n').filter(Boolean).pop() ?? text;
        opts.onLog(lastLine.slice(-200));
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        try {
          const stat = statSync(outputPath);
          resolve({
            outputPath,
            bytes: stat.size,
            durationMs: Date.now() - t0,
          });
        } catch (err) {
          cleanupOutput();
          reject(new CalibreConvertError(
            `Output EPUB missing after success: ${String(err)}`,
            'EUNKNOWN',
            stderrTail,
          ));
        }
      } else {
        cleanupOutput();
        reject(new CalibreConvertError(
          `ebook-convert exited with code ${code}`,
          'ENONZERO',
          stderrTail,
        ));
      }
    });
  });
}

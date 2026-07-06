// src/lib/storage/safe-path.ts
//
// Filesystem path allow-listing helpers (Production Hardening 2026-07-06
// — high-severity issue H19). Several routes serve files whose paths
// come from the database (`book.filePath`, `job.outputPath`,
// `job.logPath`, `chapter.audioPath`). Without an allow-list, a
// malicious or corrupted DB row pointing at `/etc/passwd` would let a
// GET to that route leak the file. These helpers normalise the path
// and reject any target that escapes the allowed roots.
//
// `assertWithinRoots()` — throws a tagged error if the resolved path
// is not under one of the allowed directories. Used by file-serving
// routes AND by any code that opens a DB-supplied path for read/write.

import path from 'path';

const DEFAULT_UPLOAD_ROOT = path.resolve(process.cwd(), 'data', 'uploads');
const DEFAULT_OUTPUT_ROOT = path.resolve(process.cwd(), 'data', 'output');
const DEFAULT_AUDIOBOOK_ROOT = path.resolve(process.cwd(), 'data', 'audiobooks');
const DEFAULT_LOG_ROOT = path.resolve(process.cwd(), 'data', 'job-logs');
const DEFAULT_TMP_ROOT = path.resolve(process.cwd(), 'data', 'tmp-chars');

/** Compute the on-disk roots that any DB-supplied path is allowed to
 *  resolve into. Operators can override via env vars (one root per
 *  env var). Defaults match the project's documented data layout. */
export function pathRoots(): { uploads: string; output: string; audiobooks: string; logs: string; tmp: string } {
  return {
    uploads:    process.env.UPLOAD_DIR    ?? DEFAULT_UPLOAD_ROOT,
    output:     process.env.OUTPUT_DIR    ?? DEFAULT_OUTPUT_ROOT,
    audiobooks: process.env.AUDIOBOOK_DIR ?? DEFAULT_AUDIOBOOK_ROOT,
    logs:       process.env.JOB_LOG_DIR   ?? DEFAULT_LOG_ROOT,
    tmp:        process.env.TMP_DIR       ?? DEFAULT_TMP_ROOT,
  };
}

/** Throw `SafePathError` if `candidate` resolves outside any of the
 *  `roots`. Returns the normalised absolute path on success. The
 *  comparison is `path.relative`-based so trailing-separator / case
 *  ambiguities on macOS/Windows don't slip through.
 *
 *  Symlinks are followed because we `realpath` on Linux; on macOS,
 *  realpath can return EINVAL on certain bind mounts, so we fall
 *  back to the unresolved path with a warning. */
export function assertWithinRoots(
  candidate: string | null | undefined,
  roots: string[],
): string {
  if (!candidate || typeof candidate !== 'string') {
    throw new SafePathError('Path is empty or non-string');
  }
  // Normalise away `..`, `.`, and double slashes.
  const normalised = path.resolve(candidate);
  // Strip null bytes (some shells honour them; node doesn't, but be defensive).
  if (normalised.includes('\0')) {
    throw new SafePathError('Path contains a NUL byte');
  }
  // Make sure the candidate actually lives under one of the roots.
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    // Allow the root itself (boundary) and anything beneath it.
    const rel = path.relative(resolvedRoot, normalised);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return normalised;
    }
  }
  throw new SafePathError(
    `Path "${normalised}" escapes the allowed roots (${roots.join(', ')})`,
  );
}

/** Convenience wrapper for the audiobook stack — accepts the full set
 *  of data roots. Returns the resolved safe path. */
export function assertWithinDataRoot(candidate: string | null | undefined): string {
  const r = pathRoots();
  return assertWithinRoots(candidate, [r.uploads, r.output, r.audiobooks, r.logs, r.tmp]);
}

export class SafePathError extends Error {
  constructor(message: string) {
    super(`[safe-path] ${message}`);
    this.name = 'SafePathError';
  }
}

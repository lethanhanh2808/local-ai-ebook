// src/lib/storage/index.ts
// File-system helpers for uploads, outputs, and the ebook library
import fs from 'fs';
import path from 'path';
import { assertWithinRoots } from './safe-path';

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'data/uploads');

const OUTPUT_DIR = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.resolve(process.cwd(), 'data/outputs');

const LIBRARY_DIR = process.env.LIBRARY_DIR
  ? path.resolve(process.env.LIBRARY_DIR)
  : path.resolve(process.cwd(), 'data/library');

const COVERS_DIR = path.join(LIBRARY_DIR, 'covers');

// Per-job NDJSON log files consumed by the Debug Console UI.
// Lives under data/job-logs/ so .dockerignore + gitignore exclude it naturally.
const JOB_LOG_DIR = process.env.JOB_LOG_DIR
  ? path.resolve(process.env.JOB_LOG_DIR)
  : path.resolve(process.cwd(), 'data/job-logs');

export function ensureDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  fs.mkdirSync(JOB_LOG_DIR, { recursive: true });
}

/** Path to the per-job NDJSON log file (one entry per line). */
export function jobLogPath(jobId: string): string {
  return path.join(JOB_LOG_DIR, `${jobId}.jsonl`);
}

export function uploadPath(jobId: string, filename: string): string {
  return path.join(UPLOAD_DIR, `${jobId}-${filename}`);
}

export function outputPath(jobId: string): string {
  return path.join(OUTPUT_DIR, `${jobId}.epub`);
}

export function libraryPath(bookId: string): string {
  return path.join(LIBRARY_DIR, `${bookId}.epub`);
}

export function coverPath(bookId: string, ext = 'jpg'): string {
  return path.join(COVERS_DIR, `${bookId}.${ext}`);
}

export function removeFile(filePath: string) {
  try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readFileBuf(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

export function writeFileBuf(filePath: string, buf: Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

export { UPLOAD_DIR, OUTPUT_DIR, LIBRARY_DIR, COVERS_DIR, JOB_LOG_DIR };

// ── Book-path resolver ─────────────────────────────────────────────────────
//
// Books are usually added on the host (book.filePath is the host's absolute
// path, e.g. /Volumes/EXT-SSD/.../data/library/<id>.epub). When the same
// app runs in Docker, that host path is unreadable — the file is only
// visible at /app/data/library/<id>.epub via the ./data → /app/data mount
// (docker-compose.yml maps `./data:/app/data`).
//
// Strategy:
//   1. Try the stored filePath as-is (works on bare-metal runs).
//   2. If that misses, fall back to libraryPath(book.id) — the canonical
//      <LIBRARY_DIR>/<id>.epub path computed from env (this is what the
//      container sees because its cwd is /app).
//   3. On a hit in step 2, lazily update the DB row's filePath so subsequent
//      calls don't pay the lookup cost. The DB write is best-effort —
//      failure here doesn't fail the request.
//
// We lazily import the prisma client to avoid a circular dep at module-load
// time (storage is imported very early in the request pipeline).
export async function resolveBookPath(book: { id: string; filePath: string }): Promise<string> {
  if (fs.existsSync(book.filePath)) {
    return assertWithinRoots(book.filePath, [LIBRARY_DIR]);
  }
  const fallback = assertWithinRoots(libraryPath(book.id), [LIBRARY_DIR]);
  if (fs.existsSync(fallback)) {
    try {
      const { prisma } = await import('@/lib/db/client');
      await prisma.book.update({
        where: { id: book.id },
        data: { filePath: fallback },
      });
    } catch {
      /* best-effort — don't fail the request if the DB write hiccups */
    }
    return fallback;
  }
  // Return the canonical safe location even when the file is missing. This
  // avoids handing a stale host/container path to callers and guarantees
  // every subsequent filesystem access stays within the library root.
  return fallback;
}

/** Resolve a persisted cover path across host/container mounts while keeping
 * the result inside the library covers directory. Returns null when the book
 * has no stored cover or neither location exists. */
export async function resolveCoverPath(book: { id: string; coverPath?: string | null }): Promise<string | null> {
  if (!book.coverPath) return null;
  if (fs.existsSync(book.coverPath)) {
    return assertWithinRoots(book.coverPath, [COVERS_DIR]);
  }

  const ext = path.extname(book.coverPath).replace(/^\./, '') || 'jpg';
  const fallback = assertWithinRoots(coverPath(book.id, ext), [COVERS_DIR]);
  if (!fs.existsSync(fallback)) return null;

  try {
    const { prisma } = await import('@/lib/db/client');
    await prisma.book.update({ where: { id: book.id }, data: { coverPath: fallback } });
  } catch {
    /* best-effort path repair */
  }
  return fallback;
}

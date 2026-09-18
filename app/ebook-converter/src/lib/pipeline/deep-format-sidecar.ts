// src/lib/pipeline/deep-format-sidecar.ts
//
// Persists the AI-cleaned chapter text produced by runDeepFormatStage as a
// JSON sidecar next to the final EPUB. The character-bible worker reads this
// sidecar instead of re-parsing the source EPUB, which means:
//
//   - The bible LLM sees the SAME cleaned text the user reads in their
//     ebook (no watermark / mojibake / broken-paragraph noise to confuse
//     character extraction).
//   - Per-chapter character mentions stay consistent with the prose the
//     user actually sees.
//
// File layout:
//   <book>.epub              ← the converted EPUB
//   <book>.epub.deepFormat.json   ← this sidecar (one JSON object)
//
// Why next to the EPUB and not in `data/library/` separately?
//   - `resolveBookPath()` already returns the canonical path that the bible
//     worker reads from; mirroring that for the sidecar means host/container
//     mount quirks don't break the lookup.
//   - When the user deletes a book, deleting the EPUB automatically deletes
//     the sidecar (or makes it harmless garbage).
//
// The sidecar is OPT-IN: it only exists when the user ran the conversion
// with `deepFormat=true`. The bible worker falls back to parseEpub() when
// the sidecar is missing, so old books still work unchanged.

import fs from 'node:fs/promises';
import path from 'node:path';

/** A single cleaned chapter as stored in the sidecar. `text` is the
 *  plain-text projection of the deep-formatted HTML (block tags converted
 *  to newlines, scripts/styles stripped, entities decoded). */
export interface SidecarChapter {
  /** Stable chapter index (matches `epub.htmlFiles[i]` ordering used
   *  by the bible worker and the character-bible `chapterIndex` field). */
  index: number;
  /** Chapter title as it appears in the EPUB TOC / `<h1>`. Best-effort. */
  title: string;
  /** Plain-text body. May be empty for cover/TOC pages. */
  text: string;
}

export interface DeepFormatSidecar {
  /** Schema version. Bump if shape changes incompatibly. */
  version: 1;
  /** Book ID (UUID). Lets us sanity-check that a sidecar belongs to the
   *  requested book before returning it. */
  bookId: string;
  /** Wall-clock timestamp the sidecar was written. */
  generatedAt: string;
  /** True when the conversion actually ran the AI deep-format stage
   *  (false = sidecar was written but with raw HTML — currently we only
   *  write the sidecar when deepFormat is on, so this is always true). */
  deepFormatUsed: boolean;
  /** Reserved for forward-compat. The conversion pipeline does not yet
   *  expose the model that produced the cleaned text (the deep-format
   *  stage hashes on bookId rather than per-call AI config). New writes
   *  always carry `null`; old sidecars preserved on disk may carry a
   *  string and are returned as-is by the reader. */
  model?: string | null;
  /** Number of AI calls consumed producing these chapters. Diagnostic. */
  aiCalls?: number;
  /** The cleaned chapters in 0-indexed order. */
  chapters: SidecarChapter[];
}

/** Resolve the canonical sidecar path for a given EPUB path.
 *  Side-by-side naming keeps cleanup obvious (delete the EPUB → sidecar is
 *  orphaned but harmless; an external sweep can prune them). */
export function sidecarPathFor(epubPath: string): string {
  return `${epubPath}.deepFormat.json`;
}

/** Write the sidecar JSON. Best-effort: writes are non-fatal so a
 *  serialization hiccup never blocks the final EPUB from being delivered
 *  to the user. Errors are logged at warn level so they're visible in
 *  `data/job-logs/<jobId>.jsonl` if anything goes wrong. */
export async function writeDeepFormatSidecar(opts: {
  outputPath: string;
  bookId: string;
  chapters: SidecarChapter[];
  aiCalls?: number;
}): Promise<{ ok: true; path: string; bytes: number } | { ok: false; error: string }> {
  const sidecar: DeepFormatSidecar = {
    version: 1,
    bookId: opts.bookId,
    generatedAt: new Date().toISOString(),
    deepFormatUsed: true,
    model: null,
    aiCalls: opts.aiCalls ?? 0,
    chapters: opts.chapters,
  };
  const target = sidecarPathFor(opts.outputPath);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const json = JSON.stringify(sidecar);
    // Atomic write: stage via a `.tmp` suffix then rename so a partial
    // write can't leave a half-valid JSON for the bible worker to choke on.
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, target);
    return { ok: true, path: target, bytes: json.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read the sidecar for a given EPUB path. Returns null when:
 *   - the file doesn't exist (book was converted without deepFormat, or
 *     the sidecar was pruned),
 *   - the JSON is malformed (corrupted sidecar),
 *   - the bookId in the sidecar doesn't match the requested bookId.
 *  Callers should fall back to parseEpub() in all null cases.
 */
export async function readDeepFormatSidecar(opts: {
  epubPath: string;
  bookId: string;
}): Promise<DeepFormatSidecar | null> {
  const target = sidecarPathFor(opts.epubPath);
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
  let parsed: DeepFormatSidecar;
  try {
    parsed = JSON.parse(raw) as DeepFormatSidecar;
  } catch {
    return null;
  }
  if (parsed.version !== 1) return null;
  // Note: we intentionally do NOT enforce `parsed.bookId === opts.bookId`
  // here. The sidecar is keyed by the conversion jobId at write time, but
  // when the user imports the job into the library the new Book gets a
  // fresh UUID (see POST /api/library). The library-import handler
  // re-stamps the sidecar's `bookId` field to the new Book id so the
  // sidecar remains self-identifying — but to be defensive, we also
  // accept any well-formed sidecar here. The Bible worker keys chapter
  // reads on `chapterIndex` (the position in htmlFiles), not on bookId.
  if (!Array.isArray(parsed.chapters)) return null;
  return parsed;
}

/** Re-stamp the `bookId` field of an existing sidecar with a new value.
 *  Called by the library-import handler after copying the sidecar to the
 *  new library location, so the sidecar remains self-identifying for the
 *  new Book row. No-op if the source sidecar doesn't exist. */
export async function restampDeepFormatSidecar(opts: {
  epubPath: string;
  newBookId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const target = sidecarPathFor(opts.epubPath);
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch {
    return { ok: false, reason: 'sidecar not found' };
  }
  let parsed: DeepFormatSidecar;
  try {
    parsed = JSON.parse(raw) as DeepFormatSidecar;
  } catch {
    return { ok: false, reason: 'sidecar is malformed' };
  }
  if (parsed.version !== 1) return { ok: false, reason: 'unknown sidecar version' };
  if (parsed.bookId === opts.newBookId) return { ok: true };
  parsed.bookId = opts.newBookId;
  try {
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(parsed), 'utf8');
    await fs.rename(tmp, target);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

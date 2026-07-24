// src/lib/db/watermark-memory.ts
// Cross-book watermark memory helpers.
//
// The conversion pipeline maintains a persistent catalog of phrases that have
// been stripped from previously-converted ebooks so that on subsequent
// uploads the phrases can be matched+removed without re-running the
// frequency scan over every chapter. User can also add phrases by hand
// (e.g. a known publisher footer) so the first upload of a brand-new book
// can still be cleaned in one pass.
import { prisma } from './client';

export type WatermarkSource = 'auto' | 'user' | 'imported';

export interface WatermarkMemoryRow {
  id: string;
  phrase: string;
  source: WatermarkSource;
  hitCount: number;
  lastSeenAt: Date;
  firstSeenAt: Date;
  createdAt: Date;
}

/** Normalize a phrase for storage + comparison.
 *  - Trim, collapse whitespace. Lowercase is handled implicitly by SQLite's
 *    default NOCASE collation on the unique index. */
function normalizePhrase(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Fetch all remembered phrases. Returns in display order (highest hitCount
 *  first, so the UI surfaces the most common watermarks). */
export async function listWatermarkMemory(): Promise<WatermarkMemoryRow[]> {
  const rows = await prisma.watermarkMemory.findMany({
    orderBy: [{ hitCount: 'desc' }, { lastSeenAt: 'desc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    phrase: r.phrase,
    source: r.source as WatermarkSource,
    hitCount: r.hitCount,
    lastSeenAt: r.lastSeenAt,
    firstSeenAt: r.firstSeenAt,
    createdAt: r.createdAt,
  }));
}

/** Read just the phrase strings — used by the conversion pipeline to seed
 *  its strip list.
 *
 *  Returns empty list on any failure (we never want a memory-read error
 *  to abort a conversion). However, the failure IS logged at `error`
 *  level now so a misconfigured / un-migrated DB surfaces in the worker's
 *  log file rather than silently producing unwatermarked output.
 *  Pass `{ silent: true }` to suppress the log for callers that have
 *  already handled the failure (e.g. batch scanners). */
export async function listWatermarkPhrases(opts?: { silent?: boolean }): Promise<string[]> {
  try {
    const rows = await prisma.watermarkMemory.findMany({
      select: { phrase: true },
    });
    return rows.map((r) => r.phrase);
  } catch (err) {
    if (!opts?.silent) {
      // Table not yet migrated? Surface that loudly — a silent fallback
      // here was producing unwatermarked output with no diagnostic trail.
      console.error(
        '[watermark-memory] read failed; falling back to no memory:',
        err instanceof Error ? err.message : String(err),
      );
    }
    return [];
  }
}

/** Add a single phrase to memory. Idempotent: if the same phrase is already
 *  in the table, increments hitCount + bumps lastSeenAt instead of inserting
 *  a duplicate. Returns the resulting row. */
export async function rememberWatermark(phrase: string, source: WatermarkSource = 'auto'): Promise<WatermarkMemoryRow | null> {
  const p = normalizePhrase(phrase);
  if (p.length < 4 || p.length > 200) return null;
  try {
    const existing = await prisma.watermarkMemory.findUnique({ where: { phrase: p } });
    if (existing) {
      const updated = await prisma.watermarkMemory.update({
        where: { phrase: p },
        data: { hitCount: { increment: 1 }, lastSeenAt: new Date() },
      });
      return rowFromPrisma(updated);
    }
    const created = await prisma.watermarkMemory.create({
      data: { phrase: p, source, hitCount: 1 },
    });
    return rowFromPrisma(created);
  } catch (err) {
    console.warn('[watermark-memory] remember failed for phrase:', p, err);
    return null;
  }
}

/** Bulk-add — used by the pipeline to persist everything it stripped. */
export async function rememberWatermarks(phrases: string[], source: WatermarkSource = 'auto'): Promise<number> {
  let count = 0;
  for (const phrase of phrases) {
    const ok = await rememberWatermark(phrase, source);
    if (ok) count++;
  }
  return count;
}

/** Bump hitCount + lastSeenAt for an existing phrase (no-op if the phrase
 *  isn't in memory yet). Called once per pipeline run for every phrase we
 *  stripped via the memory path so "seen in N books" reflects total strip
 *  events, not just first-detection events. */
export async function touchWatermark(phrase: string): Promise<void> {
  const p = normalizePhrase(phrase);
  try {
    await prisma.watermarkMemory.updateMany({
      where: { phrase: p },
      data: { hitCount: { increment: 1 }, lastSeenAt: new Date() },
    });
  } catch (err) {
    console.warn('[watermark-memory] touch failed for phrase:', p, err);
  }
}

/** Bulk-touch — used by the pipeline on every run to bump counters for
 *  phrases that came from memory (vs. phrases being inserted for the
 *  first time). */
export async function touchWatermarks(phrases: string[]): Promise<void> {
  for (const phrase of phrases) await touchWatermark(phrase);
}

/** Remove a phrase from memory. Returns true if a row was actually deleted. */
export async function forgetWatermark(phrase: string): Promise<boolean> {
  const p = normalizePhrase(phrase);
  try {
    const res = await prisma.watermarkMemory.deleteMany({ where: { phrase: p } });
    return res.count > 0;
  } catch {
    return false;
  }
}

/** Toggle active-state isn't part of the design — once a phrase is in
 *  memory it's always stripped on the next conversion. To "disable"
 *  temporarily the user just calls forgetWatermark(). */

function rowFromPrisma(r: any): WatermarkMemoryRow {
  return {
    id: r.id,
    phrase: r.phrase,
    source: r.source,
    hitCount: r.hitCount,
    lastSeenAt: r.lastSeenAt,
    firstSeenAt: r.firstSeenAt,
    createdAt: r.createdAt,
  };
}

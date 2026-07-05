// src/lib/db/chapter-attribution.ts
//
// Per-chapter speaker-attribution cache. Stores a JSON map of
// `paragraphIndex → { speaker, confidence, source }` keyed by (bookId,
// chapterIndex). Re-attribute only when the source chapter HTML mtime
// changes; otherwise serve from SQLite in O(1).
//
// The cache is shared between the Next.js API route (live read-aloud) and
// the BullMQ pre-generation worker (Tier 3b). Both call
// `getOrComputeAttribution()` with a `computeFn` argument that produces a
// fresh attribution map when the cache misses.
import { prisma } from './client';

export type AttributionSource = 'parser' | 'regex' | 'llm' | 'conversation' | 'default';

export interface AttributionEvidence {
  source: AttributionSource | 'scene' | 'history' | 'presence' | 'timeline' | 'pronoun';
  speaker?: string | null;
  weight: number;
  detail: string;
}

export interface ConversationStateSnapshot {
  sceneId: number;
  activeCharacters: string[];
  currentSpeaker: string | null;
  previousSpeaker: string | null;
  currentFocusCharacter: string | null;
  lastActionCharacter: string | null;
  lastMentionedCharacters: string[];
  dialogueHistory: Array<{ paragraphIndex: number; speaker: string }>;
}

export interface ParagraphAttribution {
  /** Lower-cased canonical character name (e.g. "y đằng ưu nhi"). Null when
   *  the speaker is unknown (falls back to default voice). */
  speaker: string | null;
  /** 0..1, higher = more confident. Used to break ties between layers
   *  (parser > regex > default). */
  confidence: number;
  /** Which layer produced the answer. */
  source: AttributionSource;
  /** Human-readable reason for debug views. Optional for older cache rows. */
  reason?: string;
  /** Weighted signals that contributed to the decision. Optional for older rows. */
  evidence?: AttributionEvidence[];
  /** Scene/conversation state snapshot at the time of attribution. */
  state?: ConversationStateSnapshot;
  /** 0-based scene id within the chapter. */
  sceneId?: number;
}

export interface ChapterAttributionMap {
  [paragraphIndex: number]: ParagraphAttribution;
}

export interface AttributionCacheRow {
  bookId: string;
  chapterIndex: number;
  payload: ChapterAttributionMap;
  sourceMtime: number;
  parserVersion: string;
  updatedAt: Date;
}

/** Read the cached attribution map for a chapter. Returns null if the row
 *  is missing or its sourceMtime is older than `currentMtime` (stale).
 *
 *  sourceMtime is stored as BigInt because modern filesystem mtime (in ms
 *  since epoch) overflows a 32-bit signed Int. We compare BigInts and
 *  return the value as a plain number for callers. */
export async function getCachedAttribution(
  bookId: string,
  chapterIndex: number,
  currentMtime: number,
  parserVersion?: string,
): Promise<AttributionCacheRow | null> {
  const row = await prisma.chapterAttribution.findUnique({
    where: { bookId_chapterIndex: { bookId, chapterIndex } },
  });
  if (!row) return null;
  // BigInt comparison: convert both to BigInt or both to number for equality.
  // row.sourceMtime is BigInt; currentMtime is number (mtimeMs).
  if (BigInt(row.sourceMtime) !== BigInt(currentMtime)) return null;  // stale
  if (parserVersion && row.parserVersion !== parserVersion) return null;
  let payload: ChapterAttributionMap;
  try {
    payload = JSON.parse(row.payload) as ChapterAttributionMap;
  } catch {
    return null;
  }
  return {
    bookId: row.bookId,
    chapterIndex: row.chapterIndex,
    payload,
    sourceMtime: Number(row.sourceMtime),
    parserVersion: row.parserVersion,
    updatedAt: row.updatedAt,
  };
}

/** Upsert the cached attribution map. Overwrites any existing row.
 *
 *  Prisma's BigInt input on SQLite accepts plain numbers — but to be safe
 *  we coerce the JS number to BigInt at the call site. (SQLite stores
 *  BigInt as INTEGER, so the precision is preserved.) */
export async function setCachedAttribution(
  bookId: string,
  chapterIndex: number,
  payload: ChapterAttributionMap,
  sourceMtime: number,
  parserVersion: string = 'conversation-v1+vncorenlp-1.2',
): Promise<void> {
  await prisma.chapterAttribution.upsert({
    where: { bookId_chapterIndex: { bookId, chapterIndex } },
    create: {
      bookId,
      chapterIndex,
      payload: JSON.stringify(payload),
      sourceMtime: BigInt(sourceMtime),
      parserVersion,
    },
    update: {
      payload: JSON.stringify(payload),
      sourceMtime: BigInt(sourceMtime),
      parserVersion,
    },
  });
}

/** Read-through cache: returns the cached map if fresh, otherwise calls
 *  `computeFn` to produce a fresh one and persists it. */
export async function getOrComputeAttribution(
  bookId: string,
  chapterIndex: number,
  currentMtime: number,
  computeFn: () => Promise<ChapterAttributionMap>,
  parserVersion: string = 'conversation-v1+vncorenlp-1.2',
): Promise<{ payload: ChapterAttributionMap; fromCache: boolean }> {
  const cached = await getCachedAttribution(bookId, chapterIndex, currentMtime, parserVersion);
  if (cached) {
    return { payload: cached.payload, fromCache: true };
  }
  const payload = await computeFn();
  // Persist best-effort — never fail the request because the DB write
  // hiccupped.
  try {
    await setCachedAttribution(
      bookId, chapterIndex, payload, currentMtime, parserVersion,
    );
  } catch (e) {
    console.error('[chapter-attribution] cache write failed:', e);
  }
  return { payload, fromCache: false };
}

/** Delete cached attribution for a chapter (used when the chapter HTML
 *  is re-uploaded and we want a forced re-attribute). */
export async function invalidateAttribution(
  bookId: string,
  chapterIndex: number,
): Promise<void> {
  await prisma.chapterAttribution.deleteMany({
    where: { bookId, chapterIndex },
  });
}

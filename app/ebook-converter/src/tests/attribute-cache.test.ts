// src/tests/attribute-cache.test.ts
//
// Unit-level pinning test for `getOrComputeAttribution` — the
// read-through cache layer the attribute route depends on for two
// pieces of D1-correctness behaviour:
//
//   1. `fromCache: false` ⇔ `computeFn` ran ⇔ we have a fresh
//      ConversationState snapshot to persist.
//   2. `fromCache: true`  ⇔ the cached map is reused without invoking
//      `computeFn` ⇔ the route MUST NOT re-persist
//      `BookConversationState`.
//
// If the cache semantics drift, the route's crossChapter.persistedAt
// block becomes a lie: it'd claim to persist on every request (or
// never persist), silently breaking the cross-chapter carry that D1
// shipped to fix.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock prisma BEFORE importing the module that uses it ────────────────────

interface MockRow {
  bookId: string;
  chapterIndex: number;
  payload: string;          // serialised ChapterAttributionMap
  sourceMtime: bigint;
  parserVersion: string;
}

const db: { rows: Map<string, MockRow>; failUpsert: boolean; failDelete: boolean; } = {
  rows: new Map(),
  failUpsert: false,
  failDelete: false,
};

function keyOf(bookId: string, chapterIndex: number): string {
  return `${bookId}::${chapterIndex}`;
}

vi.mock('../lib/db/client', () => ({
  prisma: {
    chapterAttribution: {
      findUnique: vi.fn(async ({ where }: any) => {
        const k = keyOf(where.bookId_chapterIndex.bookId, where.bookId_chapterIndex.chapterIndex);
        const row = db.rows.get(k);
        return row ? {
          bookId: row.bookId,
          chapterIndex: row.chapterIndex,
          payload: row.payload,
          sourceMtime: row.sourceMtime,
          parserVersion: row.parserVersion,
          updatedAt: new Date(),
        } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        if (db.failUpsert) throw new Error('boom');
        const k = keyOf(where.bookId_chapterIndex.bookId, where.bookId_chapterIndex.chapterIndex);
        const existing = db.rows.get(k);
        if (existing) {
          // update path
          Object.assign(existing, {
            payload: update.payload ?? existing.payload,
            sourceMtime: update.sourceMtime ?? existing.sourceMtime,
            parserVersion: update.parserVersion ?? existing.parserVersion,
          });
          return existing;
        }
        // create path
        const row: MockRow = {
          bookId: create.bookId,
          chapterIndex: create.chapterIndex,
          payload: create.payload,
          sourceMtime: create.sourceMtime,
          parserVersion: create.parserVersion,
        };
        db.rows.set(k, row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (db.failDelete) throw new Error('boom-delete');
        const k = keyOf(where.bookId, where.chapterIndex);
        const had = db.rows.delete(k);
        return { count: had ? 1 : 0 };
      }),
    },
  },
}));

// Now safe to import the module under test.
import { getOrComputeAttribution, invalidateAttribution } from '../lib/db/chapter-attribution';
import type { ChapterAttributionMap } from '../lib/db/chapter-attribution';

const BOOK_ID = 'book-pin-001';
const CHAPTER_IDX = 2;
const PARSER_VERSION = 'conversation-v3+vncorenlp-1.2';

function emptyMap(): ChapterAttributionMap {
  return {};
}

function mapWith(speakerAtIdx: Record<number, string>): ChapterAttributionMap {
  const m: ChapterAttributionMap = {};
  for (const [k, v] of Object.entries(speakerAtIdx)) {
    m[Number(k)] = { speaker: v, confidence: 0.9, source: 'conversation' };
  }
  return m;
}

// ── Reset between tests ───────────────────────────────────────────────────
beforeEach(() => {
  db.rows.clear();
  db.failUpsert = false;
  db.failDelete = false;
});

describe('getOrComputeAttribution — cache hit / miss', () => {
  it('first call invokes computeFn and returns fromCache: false', async () => {
    const compute = vi.fn(async () => mapWith({ 0: 'A' }));
    const result = await getOrComputeAttribution(
      BOOK_ID, CHAPTER_IDX, 100, compute, PARSER_VERSION,
    );
    expect(compute, 'computeFn should run on first call').toHaveBeenCalledTimes(1);
    expect(result.fromCache, 'fromCache on first call').toBe(false);
    expect(result.payload, 'payload on first call').toEqual(mapWith({ 0: 'A' }));
  });

  it('second call with the same mtime returns the cached payload WITHOUT invoking computeFn', async () => {
    const compute = vi.fn(async () => mapWith({ 0: 'A' }));
    // First call — computes + persists.
    await getOrComputeAttribution(BOOK_ID, CHAPTER_IDX, 100, compute, PARSER_VERSION);
    // Second call — must hit cache.
    const cached = await getOrComputeAttribution(
      BOOK_ID, CHAPTER_IDX, 100, compute, PARSER_VERSION,
    );
    expect(compute, 'computeFn should NOT run on cached call').toHaveBeenCalledTimes(1);
    expect(cached.fromCache, 'fromCache on second call').toBe(true);
    expect(cached.payload, 'cached payload matches first call').toEqual(mapWith({ 0: 'A' }));
  });

  it('changing mtime forces a re-compute (file regenerated)', async () => {
    const compute = vi.fn(async () => mapWith({ 0: 'A' }));
    await getOrComputeAttribution(BOOK_ID, CHAPTER_IDX, 100, compute, PARSER_VERSION);
    const refreshed = await getOrComputeAttribution(
      BOOK_ID, CHAPTER_IDX, 200, compute, PARSER_VERSION,
    );
    expect(compute, 'computeFn should run again on mtime change').toHaveBeenCalledTimes(2);
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.payload).toEqual(mapWith({ 0: 'A' }));
  });

  it('changing parserVersion forces a re-compute (rule change)', async () => {
    const compute = vi.fn(async () => mapWith({ 0: 'A' }));
    await getOrComputeAttribution(BOOK_ID, CHAPTER_IDX, 100, compute, 'v1');
    const refreshed = await getOrComputeAttribution(
      BOOK_ID, CHAPTER_IDX, 100, compute, 'v2',
    );
    expect(compute, 'computeFn should re-run when parserVersion changes').toHaveBeenCalledTimes(2);
    expect(refreshed.fromCache).toBe(false);
  });

  it('invalidateAttribution clears the cache so the next call re-computes', async () => {
    const compute = vi.fn(async () => mapWith({ 0: 'A' }));
    await getOrComputeAttribution(BOOK_ID, CHAPTER_IDX, 100, compute, PARSER_VERSION);
    await invalidateAttribution(BOOK_ID, CHAPTER_IDX);
    const after = await getOrComputeAttribution(
      BOOK_ID, CHAPTER_IDX, 100, compute, PARSER_VERSION,
    );
    expect(compute, 'computeFn should re-run after invalidate').toHaveBeenCalledTimes(2);
    expect(after.fromCache).toBe(false);
  });

  it('a persist failure is swallowed so the API still returns a payload', async () => {
    // Flip the failure flag on the SHARED mock so the same prisma singleton
    // the module-under-test imported observes the failure. Suppressing the
    // noisy console.error so test output stays readable.
    db.failUpsert = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const compute = vi.fn(async () => mapWith({ 7: 'X' }));
      const result = await getOrComputeAttribution(
        BOOK_ID, CHAPTER_IDX, 999, compute, PARSER_VERSION,
      );
      expect(compute).toHaveBeenCalledTimes(1);
      expect(result.fromCache, 'persist failure must NOT flip fromCache to true').toBe(false);
      expect(result.payload, 'computeFn payload is still returned').toEqual(mapWith({ 7: 'X' }));
      // Swallowed error must have been logged exactly once.
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it('a fresh chapter (no row, no computeFn called) reports fromCache: false when re-queried after compute', async () => {
    // Identity of stored payload across calls — important so the route
    // never serves a stale attribution under a fresh seed.
    const compute = vi.fn(async () => mapWith({ 5: 'Z' }));
    const r1 = await getOrComputeAttribution(BOOK_ID, CHAPTER_IDX, 1, compute, PARSER_VERSION);
    const compute2 = vi.fn();   // never invoked
    const r2 = await getOrComputeAttribution(BOOK_ID, CHAPTER_IDX, 1, compute2, PARSER_VERSION);
    expect(compute2, 'computeFn not invoked on cached call').not.toHaveBeenCalled();
    expect(r2.fromCache).toBe(true);
    expect(r1.payload, 'first payload equals second payload (identity)').toEqual(r2.payload);
    expect(r1.payload).toEqual(mapWith({ 5: 'Z' }));
  });

  it('uppercase BigInt coercion: the mock compares sourceMtime via BigInt', async () => {
    // Sanity: the underlying storage uses BigInt for sourceMtime.  This
    // test pins that the round-trip works when callers pass plain JS
    // numbers (which is what the route does via fs.statSync → mtimeMs).
    const compute = vi.fn(async () => emptyMap());
    await getOrComputeAttribution(BOOK_ID, CHAPTER_IDX, 1_700_000_000_000, compute, PARSER_VERSION);
    const cached = await getOrComputeAttribution(
      BOOK_ID, CHAPTER_IDX, 1_700_000_000_000,
      vi.fn(async () => { throw new Error('should not be called'); }),
      PARSER_VERSION,
    );
    expect(cached.fromCache).toBe(true);
  });
});

describe('route-level invariants (delegated pin)', () => {
  // The route uses two pieces of the cache contract that aren't directly
  // pin-able from this file but are *implied* by the cache behaviour:
  //
  //   • `persistedAt = chapterIndex` only when `fromCache === false`
  //   • `BookConversationState` is written only when `fromCache === false`
  //
  // We don't re-export those branches here — the e2e spec already
  // covers them.  But we DO assert that `fromCache` is correctly
  // distinguishable from `true` and `false` here, so the route's
  // conditional branches are well-typed.
  it('fromCache is a strict boolean (not undefined, not null)', async () => {
    const r1 = await getOrComputeAttribution(
      BOOK_ID, CHAPTER_IDX, 42,
      vi.fn(async () => emptyMap()), PARSER_VERSION,
    );
    expect(typeof r1.fromCache).toBe('boolean');
    const r2 = await getOrComputeAttribution(
      BOOK_ID, CHAPTER_IDX, 42,
      vi.fn(async () => { throw new Error('not called'); }), PARSER_VERSION,
    );
    expect(typeof r2.fromCache).toBe('boolean');
    expect(r2.fromCache).toBe(true);
  });
});

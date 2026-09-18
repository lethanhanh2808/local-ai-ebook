// src/tests/enqueue-bible-refresh-counter.test.ts
//
// Unit test for the Bible refresh fan-out helper. We mock the BullMQ
// queue because vitest cannot reach Redis; the test focuses on the
// count-classification logic (added vs deduped) and the payload shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type JobRecord = { name: string; data: unknown; opts: { jobId: string } };
type BulkResult = JobRecord & { timestamp: number };

// `vi.mock` is hoisted to the top of the file, before any imports —
// that means we cannot reference module-scope `vi.fn()`s from inside
// the mock factory directly. Wrap them with `vi.hoisted` so the
// references exist in time for the mock factory closure.
const { addBulkMock, getCharacterBibleQueueMock } = vi.hoisted(() => {
  const addBulkMock = vi.fn<(jobs: JobRecord[]) => Promise<BulkResult[]>>();
  const getCharacterBibleQueueMock = vi.fn(() => ({ addBulk: addBulkMock }));
  return { addBulkMock, getCharacterBibleQueueMock };
});

vi.mock('@/lib/queue', () => ({
  getCharacterBibleQueue: getCharacterBibleQueueMock,
}));

// Import AFTER mock setup so the module picks up the stub.
import { enqueueBibleRefreshForChapters } from '@/lib/ai/character-bible-enqueue';
import type { CharacterBibleJobData } from '@/lib/queue';

describe('enqueueBibleRefreshForChapters', () => {
  beforeEach(() => {
    addBulkMock.mockReset();
    getCharacterBibleQueueMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns zeros when no chapters are passed', async () => {
    const result = await enqueueBibleRefreshForChapters('book-1', []);
    expect(result).toEqual({ added: 0, deduped: 0 });
    expect(addBulkMock).not.toHaveBeenCalled();
  });

  it('classifies every returned job as "added" when timestamps are fresh', async () => {
    // Simulate BullMQ stamping freshly-inserted jobs with the current
    // wall-clock time.
    const before = Date.now() - 1;
    addBulkMock.mockImplementation(async (jobs) => jobs.map((j) => ({
      ...j,
      timestamp: Date.now(),
    })));
    const result = await enqueueBibleRefreshForChapters('book-1', [0, 1, 2], {
      reason: 'deep-format',
    });
    expect(result.added).toBe(3);
    expect(result.deduped).toBe(0);
    expect(addBulkMock).toHaveBeenCalledTimes(1);

    // Payload invariants (bespoke contract — caller relies on these):
    const passedJobs = addBulkMock.mock.calls[0][0] as JobRecord[];
    expect(passedJobs).toHaveLength(3);
    for (const job of passedJobs) {
      const data = job.data as CharacterBibleJobData;
      expect(data.bookId).toBe('book-1');
      expect(data.autoMerge).toBe(true);
      expect(data.reason).toBe('deep-format');
      expect(typeof data.chapterIndex).toBe('number');
      expect(job.opts.jobId).toBe(`bible:book-1:${data.chapterIndex}`);
    }
    expect(before).toBeLessThanOrEqual(Date.now());
  });

  it('classifies pre-existing jobs as "deduped" (#5 fix)', async () => {
    // Stamp every "returned" job with a timestamp well before the
    // helper's `before` cutoff, mimicking a BullMQ dedupe hit (the
    // pre-existing job keeps its original insert time).
    addBulkMock.mockImplementation(async (jobs) => jobs.map((j) => ({
      ...j,
      timestamp: 1_000_000, // way in the past
    })));
    const result = await enqueueBibleRefreshForChapters('book-2', [0, 1, 2], {
      reason: 'deep-format',
    });
    expect(result.added).toBe(0);
    expect(result.deduped).toBe(3);
  });

  it('splits a mixed batch into added/deduped by timestamp', async () => {
    // First job fresh (newly inserted), second job stale (dedupe hit).
    addBulkMock.mockImplementation(async (jobs) => jobs.map((j, i) => ({
      ...j,
      timestamp: i === 0 ? Date.now() : 1,
    })));
    const result = await enqueueBibleRefreshForChapters('book-3', [0, 1], {
      reason: 'deep-format',
    });
    expect(result.added).toBe(1);
    expect(result.deduped).toBe(1);
  });

  it('honors the caller-supplied reason when provided', async () => {
    addBulkMock.mockImplementation(async (jobs) => jobs.map((j) => ({
      ...j,
      timestamp: Date.now(),
    })));
    await enqueueBibleRefreshForChapters('book-4', [0], {
      reason: 'manual',
    });
    const passed = addBulkMock.mock.calls[0][0] as JobRecord[];
    expect((passed[0].data as CharacterBibleJobData).reason).toBe('manual');
  });
});

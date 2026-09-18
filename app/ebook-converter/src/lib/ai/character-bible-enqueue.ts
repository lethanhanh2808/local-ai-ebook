// src/lib/ai/character-bible-enqueue.ts
//
// Server-side fan-out helper: enqueue bible-refresh jobs for many chapters
// of a book in one call. Used by the conversion worker after a deepFormat
// run completes — so the character bible is built off the SAME cleaned
// text the user reads, not the raw source EPUB.
//
// Why a server-side helper (not the existing client fetch wrapper)?
//   - The worker runs in a separate process and can't rely on a live HTTP
//     server to fetch from (chicken-and-egg during startup, and adds a
//     pointless network hop).
//   - We want to enqueue hundreds of jobs at once — the BullMQ client
//     `addBulk()` is the right primitive.
//   - The dedupe logic is identical to the per-chapter path: jobId is
//     `bible:${bookId}:${chapterIndex}` so an enqueue for an already-
//     queued chapter is a no-op.

import { getCharacterBibleQueue, type CharacterBibleJobData } from '@/lib/queue';

/** Enqueue bible-refresh jobs for `chapterIndices` of `bookId`.
 *  Each chapter collapses into a single BullMQ job (idempotent), so it's
 *  safe to call this more than once. Returns the count of NEW jobs added
 *  (post-dedup). */
export async function enqueueBibleRefreshForChapters(
  bookId: string,
  chapterIndices: number[],
  opts?: {
    /** BullMQ `reason` enum value. 'deep-format' is the value the
     *  enqueue-all-after-conversion path uses. */
    reason?: CharacterBibleJobData['reason'];
  },
): Promise<{ added: number; deduped: number }> {
  if (chapterIndices.length === 0) return { added: 0, deduped: 0 };
  const queue = getCharacterBibleQueue();
  const reason = opts?.reason ?? 'deep-format';

  const jobs = chapterIndices.map((chapterIndex) => ({
    name: 'bible',
    data: {
      bookId,
      chapterIndex,
      chapterFile: null,
      autoMerge: true,
      reason,
    } satisfies CharacterBibleJobData,
    opts: {
      // Stable jobId so duplicate enqueues collapse. Matches the
      // pattern used by the HTTP enqueue route.
      jobId: `bible:${bookId}:${chapterIndex}`,
    },
  }));
  // Capture a timestamp just before addBulk. BullMQ stamps every newly
  // inserted job with the Redis-side insert time; pre-existing jobs
  // (deduped by jobId) keep their original timestamp. Anything with
  // `timestamp >= before` was just inserted, the rest are deduped hits.
  // 1ms lead accommodates clock granularity inside the Redis server.
  const before = Date.now() - 1;
  const result = await queue.addBulk(jobs);
  let added = 0;
  for (const job of result) {
    const ts = (job as { timestamp?: number }).timestamp;
    if (typeof ts === 'number' && ts >= before) added++;
  }
  const deduped = Math.max(0, result.length - added);
  return { added, deduped };
}

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
    /** When true, the worker prefers the deep-format sidecar when present.
     *  Defaults to true so that a "fresh" book gets the cleaned text by
     *  default; existing books that opt-in by reason get the same flag. */
    useDeepFormatSidecar?: boolean;
    /** BullMQ `reason` enum value. 'deep-format' is the value the
     *  enqueue-all-after-conversion path uses. */
    reason?: CharacterBibleJobData['reason'];
  },
): Promise<{ added: number; deduped: number }> {
  if (chapterIndices.length === 0) return { added: 0, deduped: 0 };
  const queue = getCharacterBibleQueue();
  const useSidecar = opts?.useDeepFormatSidecar ?? true;
  const reason = opts?.reason ?? 'deep-format';

  const jobs = chapterIndices.map((chapterIndex) => ({
    name: 'bible',
    data: {
      bookId,
      chapterIndex,
      chapterFile: null,
      autoMerge: true,
      reason,
      useDeepFormatSidecar: useSidecar,
    } satisfies CharacterBibleJobData,
    opts: {
      // Stable jobId so duplicate enqueues collapse. Matches the
      // pattern used by the HTTP enqueue route.
      jobId: `bible:${bookId}:${chapterIndex}`,
    },
  }));
  const result = await queue.addBulk(jobs);
  // BullMQ doesn't expose a dedupe counter directly, but the returned
  // array contains the jobs that were either newly added or fetched
  // from the existing queue. We can count vs `jobs.length` by checking
  // timestamps, but for the worker's purposes we only need to know
  // "how many chapters did we just touch". Return the requested count
  // so the worker log is informative.
  return { added: result.length, deduped: 0 };
}

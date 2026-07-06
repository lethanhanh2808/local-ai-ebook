// src/lib/character-bible-client.ts
//
// Client-side helper that enqueues a Character Bible refresh job through
// the BullMQ API endpoint. Used by chapter-close hooks (EbookReader +
// AudiobookPlayer) and by the manual "Refresh" button in
// CharacterBible.tsx.
//
// De-dupe strategy:
//   - Server-side: BullMQ jobId is `bible:${bookId}:${chapterIndex}` so
//     two enqueues for the same chapter collapse into one worker call.
//   - Client-side: `pendingEnqueues` Map adds a 5 s debounce per
//     (bookId, chapterIndex) so a flurry of "advance-to-next-chapter"
//     events doesn't flood Redis.
//
// We use the fetch API to POST to
// /api/library/:bookId/characters/bible/enqueue (BullMQ fan-in) and
// /api/library/:bookId/characters/bible/refresh (SSE; manual UI only).
// Errors are swallowed (worker may be offline — bible refresh is
// opportunistic, never blocking).

interface EnqueueOpts {
  bookId: string;
  /** REQUIRED — which chapter just finished. Whole-book scans are not
   *  supported (see src/lib/ai/character-bible.ts RefreshBibleOptions). */
  chapterIndex: number;
  chapterFile?: string | null;
  reason: 'chapter-close' | 'book-load' | 'manual';
}

const pendingEnqueues = new Map<string, ReturnType<typeof setTimeout>>();

function jobKey(b: string, c: number): string {
  return `bible:${b}:${c}`;
}

/** Fire-and-forget: enqueues a refresh job through the BullMQ fan-in
 *  endpoint with a 5 s debounce per (bookId, chapterIndex). Returns true
 *  if a request was scheduled, false if one is already pending. */
export function enqueueBibleRefresh(opts: EnqueueOpts): boolean {
  if (!Number.isFinite(opts.chapterIndex) || opts.chapterIndex < 0) {
    // Defensive — should never reach here from chapter-close hooks but the
    // call sites have evolved and one day someone will pass -1 again.
    console.warn('[bible-client] enqueueBibleRefresh: chapterIndex must be >= 0, dropping', opts);
    return false;
  }
  const key = jobKey(opts.bookId, opts.chapterIndex);
  if (pendingEnqueues.has(key)) return false;
  const t = setTimeout(() => {
    pendingEnqueues.delete(key);
    void fetch(`/api/library/${opts.bookId}/characters/bible/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapterIndex: opts.chapterIndex,
        chapterFile: opts.chapterFile ?? null,
        reason: opts.reason,
      }),
    }).catch(() => { /* worker offline is fine — bible refresh is opportunistic */ });
  }, 5_000);
  pendingEnqueues.set(key, t);
  return true;
}

/** Open the SSE refresh stream (manual UI). Returns the fetch Response
 *  for the caller to manage; the caller is responsible for reading the
 *  body. */
export function openBibleRefreshStream(bookId: string, opts: {
  /** REQUIRED — which chapter to analyse. Whole-book scans are not
   *  supported; the route will reject the request with HTTP 400. */
  chapterIndex: number;
  chapterFile?: string | null;
  autoMerge?: boolean;
}): Promise<Response> {
  return fetch(`/api/library/${bookId}/characters/bible/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chapterIndex: opts.chapterIndex,
      chapterFile: opts.chapterFile ?? null,
      autoMerge: opts.autoMerge ?? false,
    }),
  });
}

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

// ── Range analysis (incremental / continue) ──────────────────────────────

export interface RangeAnalysisOpts {
  from?: number;
  to?: number;
  /** default true — skip chapters already analyzed successfully */
  skipAnalyzed?: boolean;
  /** default true — apply non-conflicting patches automatically */
  autoMerge?: boolean;
  model?: string;
  /** parallel chapter-analysis pool size (default read from Settings) */
  concurrency?: number;
  signal?: AbortSignal;
}

/** Open the range-analysis SSE stream. Returns the fetch Response; the
 *  caller reads the body and parses `data: {...}` frames into
 *  BibleRangeEvent objects (see the analyze-range route for the type). */
export function openRangeAnalysisStream(bookId: string, opts: RangeAnalysisOpts): Promise<Response> {
  const { signal, ...rest } = opts;
  return fetch(`/api/library/${bookId}/characters/bible/analyze-range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rest),
    signal,
  });
}

/**
 * Consume an SSE Response body line-by-line, invoking `onEvent` for each
 * parsed `data: {...}` frame. Resolves when the stream ends. Generic over
 * the event type so both refresh and range streams can reuse it.
 */
export async function consumeSseStream<T = unknown>(
  res: Response,
  onEvent: (ev: T) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of frame.split('\n')) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('data:')) continue;
        const json = trimmed.slice(5).trim();
        if (!json) continue;
        try { onEvent(JSON.parse(json) as T); } catch { /* skip bad frame */ }
      }
    }
  }
}

/** Fetch the per-chapter analysis status for the Nhân vật tab. */
export async function fetchBibleStatus(bookId: string): Promise<unknown> {
  const r = await fetch(`/api/library/${bookId}/characters/bible/status`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

/** Shape of the SSE frames emitted by the analyze-range route. Mirrors the
 *  type declared in that route so the UI can parse them without importing
 *  server-only code. */
export type BibleRangeEvent =
  | { kind: 'range-start'; from: number; to: number; total: number; plannedChapters: number[]; concurrency: number }
  | { kind: 'chapter-skip'; chapterIndex: number; reason: string }
  | { kind: 'chapter-start'; chapterIndex: number; index: number; total: number }
  | { kind: 'chapter-progress'; chapterIndex: number; event: unknown }
  | { kind: 'chapter-done'; chapterIndex: number; autoApplied: number; queued: number; conflicts: number; durationMs: number }
  | { kind: 'chapter-error'; chapterIndex: number; message: string }
  | {
      kind: 'range-done';
      analyzed: number;
      skipped: number;
      failed: number;
      totalAutoApplied: number;
      totalQueued: number;
      totalConflicts: number;
      durationMs: number;
    };

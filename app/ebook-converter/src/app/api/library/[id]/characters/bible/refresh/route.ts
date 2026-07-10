// src/app/api/library/[id]/characters/bible/refresh/route.ts
// POST   /api/library/:id/characters/bible/refresh
//
// Streams BibleProgressEvent as `data: {...}\n\n` (Server-Sent Events).
// Used by:
//   - the manual Voices-tab "Refresh" button (autoMerge=false, requires chapterIndex)
//   - the BullMQ worker (autoMerge=true, requires chapterIndex)
//
// Request body:
//   {
//     chapterIndex: number,         // REQUIRED — which chapter to analyse
//     chapterFile?: string,
//     autoMerge?: boolean,
//     model?: string                // override user-selected model
//   }
//
// Whole-book scans are intentionally not supported: a single large chapter
// already pushes the prompt near the local model's context window, and
// a giant fan-in merge corrupts the bible when one chapter has a bad
// patch. Per-chapter accumulation + combination is the canonical path.
import { NextRequest } from 'next/server';
import { getBook } from '@/lib/db/books';
import { refreshBible, type BibleProgressEvent } from '@/lib/ai/character-bible';

export const dynamic = 'force-dynamic';
// Allow this SSE handler to run long enough for a LLM call.
export const maxDuration = 600; // 10 min

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse body. chapterIndex is REQUIRED (whole-book scans are disabled).
  let body: {
    chapterIndex?: number | null;
    chapterFile?: string | null;
    autoMerge?: boolean;
    model?: string;
    forceRerun?: boolean;
  } = {};
  try {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      body = await req.json() as typeof body;
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(await req.text());
      body = {
        chapterIndex: params.get('chapterIndex') ? Number(params.get('chapterIndex')) : undefined,
        chapterFile: params.get('chapterFile') ?? undefined,
        autoMerge: params.get('autoMerge') !== 'false',
      };
    }
  } catch {
    body = {};
  }

  // Validate chapterIndex before opening the SSE stream — easier to surface
  // a clean 400 here than to send a `kind: 'error'` event down a stream
  // the client already opened.
  if (
    body.chapterIndex == null ||
    typeof body.chapterIndex !== 'number' ||
    !Number.isInteger(body.chapterIndex) ||
    body.chapterIndex < 0
  ) {
    return new Response(
      JSON.stringify({
        error: 'chapterIndex is required and must be a non-negative integer. Whole-book scans are not supported — pass the index of one chapter to refresh.',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  let closed = false;

  const write = (controller: ReadableStreamDefaultController<Uint8Array>, ev: BibleProgressEvent) => {
    if (closed) return;
    const payload = `data: ${JSON.stringify(ev)}\n\n`;
    try { controller.enqueue(encoder.encode(payload)); }
    catch { closed = true; }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => { closed = true; };
      req.signal.addEventListener('abort', onAbort);
      try {
        const result = await refreshBible(params.id, {
          chapterIndex: body.chapterIndex as number,
          chapterFile: body.chapterFile ?? null,
          autoMerge: body.autoMerge ?? false,
          model: body.model,
          forceRerun: body.forceRerun,
          onProgress: async (ev) => write(controller, ev),
        });
        write(controller, { kind: 'done', autoApplied: result.autoApplied, queued: result.queued, conflicts: result.conflicts, durationMs: result.durationMs });
      } catch (e) {
        write(controller, { kind: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        try { controller.close(); } catch { /* */ }
        closed = true;
        req.signal.removeEventListener('abort', onAbort);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

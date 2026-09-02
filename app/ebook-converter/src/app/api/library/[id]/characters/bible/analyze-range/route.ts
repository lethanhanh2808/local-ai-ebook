// src/app/api/library/[id]/characters/bible/analyze-range/route.ts
// POST /api/library/:id/characters/bible/analyze-range   (Server-Sent Events)
//
// Orchestrates INCREMENTAL, RANGE-BASED character-bible analysis on top of the
// existing per-chapter refreshBible(). This is the "run 10 chapters at a time"
// + "continue analysis" primitive the Nhân vật tab drives.
//
// Request body:
//   {
//     from?: number,            // first chapterIndex (default 0)
//     to?: number,              // last chapterIndex inclusive (default last)
//     skipAnalyzed?: boolean,   // default true — don't re-run chapters that
//                               //   already have a successful BibleRefreshLog
//     autoMerge?: boolean,      // default true — apply non-conflicting patches
//     model?: string,           // override user-selected model
//   }
//
// Streams `BibleRangeEvent` as `data: {...}\n\n`:
//   { kind: 'range-start', from, to, total, plannedChapters:number[], concurrency:number }
//   { kind: 'chapter-skip', chapterIndex, reason:'already-analyzed' }
//   { kind: 'chapter-start', chapterIndex, index, total }
//   { kind: 'chapter-progress', chapterIndex, event: BibleProgressEvent }
//   { kind: 'chapter-done', chapterIndex, autoApplied, queued, conflicts, durationMs }
//   { kind: 'chapter-error', chapterIndex, message }
//   { kind: 'range-done', analyzed:number, skipped:number, failed:number,
//        totalAutoApplied:number, totalQueued:number, totalConflicts:number,
//        durationMs:number }
//
// Chapters run in a bounded parallel pool (size = `bibleConcurrency` from
// Settings, default 5). Each chapter is an independent LLM call that applies
// its own patches atomically, so running several at once is safe and saves
// wall-clock time on fast cloud providers. See the note on
// RefreshBibleOptions.chapterIndex in lib/ai/character-bible.ts.
import { NextRequest } from 'next/server';
import { getBook } from '@/lib/db/books';
import { prisma } from '@/lib/db/client';
import { refreshBible, type BibleProgressEvent } from '@/lib/ai/character-bible';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { resolveBookPath } from '@/lib/storage';
import { getSettings } from '@/lib/db/settings';
import fs from 'node:fs/promises';

export const dynamic = 'force-dynamic';
// A 10-chapter batch × a slow local LLM can take a while; allow plenty.
export const maxDuration = 3600; // 1 hour

export type BibleRangeEvent =
  | { kind: 'range-start'; from: number; to: number; total: number; plannedChapters: number[]; concurrency: number }
  | { kind: 'chapter-skip'; chapterIndex: number; reason: string }
  | { kind: 'chapter-start'; chapterIndex: number; index: number; total: number }
  | { kind: 'chapter-progress'; chapterIndex: number; event: BibleProgressEvent }
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

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: {
    from?: number;
    to?: number;
    skipAnalyzed?: boolean;
    autoMerge?: boolean;
    model?: string;
    concurrency?: number;
  } = {};
  try {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  // Resolve the chapter index space (raw htmlFiles, same as refreshBible).
  let totalChapters = 0;
  try {
    const bookPath = await resolveBookPath(book);
    await fs.access(bookPath);
    const epub = await parseEpub(bookPath);
    totalChapters = epub.htmlFiles.length;
  } catch {
    return new Response(JSON.stringify({ error: 'Cannot read book file' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (totalChapters === 0) {
    return new Response(JSON.stringify({ error: 'Book has no chapters' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const from = clampInt(body.from ?? 0, 0, totalChapters - 1);
  const to = clampInt(body.to ?? totalChapters - 1, from, totalChapters - 1);
  const skipAnalyzed = body.skipAnalyzed ?? true;
  const autoMerge = body.autoMerge ?? true;

  // Parallel pool size: explicit body override > Settings.bibleConcurrency
  // (default 5). Clamped to [1, 16] so a bad value can't exhaust the runtime.
  let concurrency = 5;
  try {
    const s = await getSettings();
    if (typeof s.bibleConcurrency === 'number' && Number.isFinite(s.bibleConcurrency)) {
      concurrency = s.bibleConcurrency;
    }
  } catch { /* fall back to default */ }
  if (typeof body.concurrency === 'number' && Number.isFinite(body.concurrency)) {
    concurrency = body.concurrency;
  }
  concurrency = Math.max(1, Math.min(16, Math.floor(concurrency)));

  // Which chapters in [from, to] have already been analyzed successfully?
  const analyzedLogs = await prisma.bibleRefreshLog.findMany({
    where: { bookId: params.id, chapterIndex: { gte: from, lte: to }, NOT: { status: 'failed' } },
    select: { chapterIndex: true },
  });
  const analyzedSet = new Set(analyzedLogs.map((l) => l.chapterIndex));

  const planned: number[] = [];
  for (let i = from; i <= to; i++) {
    if (skipAnalyzed && analyzedSet.has(i)) continue;
    planned.push(i);
  }

  const encoder = new TextEncoder();
  let closed = false;
  const write = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    ev: BibleRangeEvent,
  ) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
    } catch {
      closed = true;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => { closed = true; };
      req.signal.addEventListener('abort', onAbort);
      const t0 = Date.now();
      let analyzed = 0;
      let skipped = 0;
      let failed = 0;
      let totalAutoApplied = 0;
      let totalQueued = 0;
      let totalConflicts = 0;

      try {
        write(controller, { kind: 'range-start', from, to, total: planned.length, plannedChapters: planned, concurrency });

        // Emit skips for visibility (so the UI can flag them without re-run).
        if (skipAnalyzed) {
          for (let i = from; i <= to; i++) {
            if (analyzedSet.has(i)) {
              skipped++;
              write(controller, { kind: 'chapter-skip', chapterIndex: i, reason: 'already-analyzed' });
            }
          }
        }

        // Bounded parallel pool: run up to `concurrency` chapters at once.
        // Each chapter is an independent LLM call that applies its own patches
        // atomically, so a parallel fan-in is safe. We still emit per-chapter
        // start/done/error events in completion order for a live progress log.
        let nextIdx = 0;
        const runOne = async (): Promise<void> => {
          while (nextIdx < planned.length) {
            if (closed) return;
            const idx = nextIdx++;
            const chapterIndex = planned[idx];
            write(controller, { kind: 'chapter-start', chapterIndex, index: idx, total: planned.length });
            try {
              const result = await refreshBible(params.id, {
                chapterIndex,
                autoMerge,
                model: body.model,
                // If the user explicitly re-runs an analyzed chapter (skipAnalyzed
                // false), force past the idempotency guard so it actually re-scans.
                forceRerun: !skipAnalyzed,
                onProgress: async (event) =>
                  write(controller, { kind: 'chapter-progress', chapterIndex, event }),
              });
              analyzed++;
              totalAutoApplied += result.autoApplied;
              totalQueued += result.queued;
              totalConflicts += result.conflicts;
              write(controller, {
                kind: 'chapter-done',
                chapterIndex,
                autoApplied: result.autoApplied,
                queued: result.queued,
                conflicts: result.conflicts,
                durationMs: result.durationMs,
              });
            } catch (e) {
              failed++;
              write(controller, {
                kind: 'chapter-error',
                chapterIndex,
                message: e instanceof Error ? e.message : String(e),
              });
            }
          }
        };
        const workers = Array.from({ length: Math.min(concurrency, planned.length) }, () => runOne());
        await Promise.all(workers);

        write(controller, {
          kind: 'range-done',
          analyzed,
          skipped,
          failed,
          totalAutoApplied,
          totalQueued,
          totalConflicts,
          durationMs: Date.now() - t0,
        });
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
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

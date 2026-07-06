// src/app/api/library/[id]/characters/bible/enqueue/route.ts
// POST   /api/library/:id/characters/bible/enqueue
//
// Fire-and-forget enqueue to the ebook-character-bible BullMQ queue. The
// worker calls refreshBible() and applies non-conflicting patches
// automatically. Conflicts land in PendingBibleDiff for user review.
//
// jobId is `bible:${bookId}:${chapterIndex}` so duplicate enqueues for
// the same chapter collapse into one worker invocation.
//
// Body:
//   { chapterIndex: number,                // REQUIRED (whole-book not supported)
//     chapterFile?: string|null,
//     reason?: 'chapter-close'|'book-load'|'manual' }
//
// Used by:
//   - src/lib/character-bible-client.ts (chapter-close + book-load hooks)
//   - the manual UI button calls /refresh instead (which streams SSE)
import { NextRequest, NextResponse } from 'next/server';
import { getCharacterBibleQueue, type CharacterBibleJobData } from '@/lib/queue';
import { getBook } from '@/lib/db/books';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: {
    chapterIndex?: number | null;
    chapterFile?: string | null;
    reason?: CharacterBibleJobData['reason'];
  } = {};
  try {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      body = await req.json() as typeof body;
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(await req.text());
      body = {
        chapterIndex: params.get('chapterIndex') ? Number(params.get('chapterIndex')) : null,
        chapterFile: params.get('chapterFile'),
        reason: (params.get('reason') as CharacterBibleJobData['reason']) ?? 'chapter-close',
      };
    }
  } catch {
    body = {};
  }

  // chapterIndex is REQUIRED — whole-book scans are not supported
  // (see src/lib/ai/character-bible.ts RefreshBibleOptions).
  if (
    body.chapterIndex == null ||
    typeof body.chapterIndex !== 'number' ||
    !Number.isFinite(body.chapterIndex) ||
    body.chapterIndex < 0
  ) {
    return NextResponse.json(
      { error: 'chapterIndex is required and must be a non-negative integer. Whole-book scans are not supported.' },
      { status: 400 },
    );
  }

  const chapterIndex = body.chapterIndex;
  const jobId = `bible:${params.id}:${chapterIndex}`;
  const jobData: CharacterBibleJobData = {
    bookId: params.id,
    chapterIndex,
    chapterFile: body.chapterFile ?? null,
    autoMerge: true,
    reason: body.reason ?? 'chapter-close',
  };
  try {
    const queue = getCharacterBibleQueue();
    const job = await queue.add(jobId, jobData, { jobId });
    return NextResponse.json({ ok: true, jobId: job.id, deduped: false });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

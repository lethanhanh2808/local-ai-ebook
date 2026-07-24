// src/app/api/library/[id]/audiobook/m4b/route.ts
// GET /api/library/[id]/audiobook/m4b — concatenate per-chapter MP3s into a
// single .m4b with chapter markers + embedded cover art.
//
// Phase 4.5 of docs/NEXT_UP_PLAN.md.
//
// v1 scope: synchronous on-request. A typical 15-30 chapter Vietnamese novel
// encodes in 30-90s. The user is already waiting on the click — adding BullMQ
// here would be premature. A future v2 can add Book.m4bPath + invalidation
// tied to configHash; the deferred path is documented in the CHANGELOG.
//
// Status gating (order matters — cheaper / more informative first):
//   1. 404 book not found
//   2. 409 audiobook currently generating — prevents ffmpeg encode competing
//      with TTS synthesis for the same cores (worker concurrency: 1 at
//      src/worker/audiobook.ts:596)
//   3. 409 not all chapters ready — UI can show "Đợi X chương nữa"
//   4. 503 ffmpeg missing — matches the install-hint pattern used by the
//      Calibre probe at src/lib/tools/calibre.ts
//   5. Build + stream

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBook } from '@/lib/db/books';
import { getAudiobookSummary, listChapters } from '@/lib/db/audiobook';
import { resolveCoverPath } from '@/lib/storage';
import { assertWithinRoots, pathRoots } from '@/lib/storage/safe-path';
import { exportM4BOnce, getActualDurations, M4BExportError } from '@/lib/tools/m4b';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const bookId = params.id;

  const book = await getBook(bookId);
  if (!book) {
    return NextResponse.json({ error: 'Sách không tồn tại' }, { status: 404 });
  }

  const audiobookStatus = (book as { audiobookStatus?: string }).audiobookStatus ?? 'none';
  if (audiobookStatus === 'generating') {
    return NextResponse.json(
      {
        error: 'Đang tạo audio, thử lại sau khi hoàn thành',
        status: 'generating',
      },
      { status: 409 },
    );
  }

  const summary = await getAudiobookSummary(bookId);
  // Reject when ANY chapter is failed — a failed chapter means the concat
  // would have a gap. The user must reset + regenerate to clear failures
  // before an M4B export can succeed.
  if (summary.total === 0 || summary.failed > 0 || summary.ready !== summary.total) {
    return NextResponse.json(
      {
        error: 'Chưa đủ chương để xuất M4B',
        ready: summary.ready,
        failed: summary.failed,
        total: summary.total,
        missing: summary.total - summary.ready,
      },
      { status: 409 },
    );
  }

  // Pull ordered chapter rows so the chapter list in the M4B matches the
  // book order. Each row carries chapterFile, chapterTitle, audioPath,
  // durationMs. We defense-in-depth the audioPath against the audiobooks
  // root even though `getBook`/`listChapters` already comes from the DB.
  const chapters = await listChapters(bookId);
  const readyChapters = chapters.filter((c) => c.status === 'ready' && c.audioPath);
  if (readyChapters.length === 0 || readyChapters.length !== summary.total) {
    return NextResponse.json({ error: 'Chưa đủ chương để xuất M4B' }, { status: 409 });
  }

  const audioRoots = [pathRoots().audiobooks];
  const inputs = readyChapters.map((ch) => {
    const audioPath = assertWithinRoots(ch.audioPath, audioRoots);
    return {
      audioPath,
      title: ch.chapterTitle ?? path.basename(ch.chapterFile, '.xhtml'),
      durationMs: ch.durationMs ?? 0,
    };
  });

  // Cover art is optional — covers live in LIBRARY_DIR/covers/<bookId>.<ext>
  // (see src/lib/storage/index.ts:coverPath). Reuse the existing helper so
  // we honour the same cross-mount fallback + path repair that the rest of
  // the app uses.
  const coverPath = await resolveCoverPath({ id: book.id, coverPath: (book as { coverPath?: string | null }).coverPath ?? null });

  // Output lives in audiobooks dir under the book id so it's discoverable.
  const outputPath = path.join(pathRoots().audiobooks, bookId, `${bookId}.m4b`);
  try {
    assertWithinRoots(outputPath, audioRoots);
  } catch {
    // Should never happen — audiobooks root always contains audiobooks dir.
    // Surface as 500 so we don't serve a traversal result.
    return NextResponse.json({ error: 'Output path rejected' }, { status: 500 });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4b-'));
  try {
    // Drift correction: re-probe the chapter MP3s immediately before export
    // so the FFMETADATA1 cumulative START/END math is accurate (±50ms × 30ch).
    const durations = await getActualDurations(inputs.map((i) => i.audioPath));
    const filtered = durations.map((d, i) => (d > 0 ? d : inputs[i]!.durationMs));

    const result = await exportM4BOnce(bookId, {
      outputPath,
      bookTitle: book.title,
      ...(book.author ? { author: book.author } : {}),
      chapters: inputs.map((i) => ({ audioPath: i.audioPath, title: i.title, durationMs: i.durationMs })),
      ...(coverPath ? { coverPath } : {}),
      durations: filtered,
      tmpDir,
    });

    const stat = fs.statSync(result.outputPath);
    const stream = fs.createReadStream(result.outputPath);

    // Clean up the tempdir once the response stream finishes. attach it to
    // stream.on('close') rather than waiting for the Promise chain — Next.js
    // hands the response to the runtime, then waits for the client.
    stream.on('close', () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });
    stream.on('error', () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    const safe = (book.title || `book-${bookId}`)
      .replace(/[^\x20-\x7E]/g, '_')
      .slice(0, 80);

    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mp4',
        'Content-Length': String(stat.size),
        'Content-Disposition': `attachment; filename="${safe}.m4b"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

    if (err instanceof M4BExportError) {
      if (err.code === 'ENOENT') {
        return NextResponse.json(
          {
            error: 'ffmpeg chưa được cài đặt trên máy chủ',
            installHint: 'brew install ffmpeg',
          },
          { status: 503 },
        );
      }
      if (err.code === 'ESAFEPATH') {
        // Path-traversal attempt or DB row pointing outside audiobooks.
        // Surface as 500 without leaking the offending path.
        console.error(`[m4b] unsafe path rejected for book=${bookId}: ${err.message}`);
        return NextResponse.json({ error: 'Xuất M4B thất bại' }, { status: 500 });
      }
      // ETIMEOUT / ENONZERO / EUNKNOWN — return a short stderr tail.
      console.error(`[m4b] export failed for book=${bookId} code=${err.code}: ${err.stderr ?? ''}`);
      return NextResponse.json(
        {
          error: 'Xuất M4B thất bại',
          detail: (err.stderr ?? '').slice(-200),
        },
        { status: 500 },
      );
    }
    console.error(`[m4b] unexpected error for book=${bookId}:`, err);
    return NextResponse.json({ error: 'Xuất M4B thất bại' }, { status: 500 });
  }
}

// POST /api/watermarks/rerun-all
//
// Walk every book in the library and re-run the watermark detection + strip
// pass against the on-disk EPUB. This is the "fix existing library in one
// shot" affordance, surfaced in /settings (Watermarks tab) and in the
// Per-book WatermarksPanel "Apply to library" shortcut. Sequential per-book
// processing keeps I/O bounded and avoids concurrent SQLite writes; the
// HTTP response is delayed until all books finish, but the user can poll
// a small status endpoint if they need a heartbeat for very large libraries.
//
// Body schema (all optional):
//   {
//     "onlyMissingWatermarks"?: boolean, // skip books that already have
//                                       // saved phrases
//     "autoDetect"?: boolean,           // default true
//     "persistToMemory"?: boolean       // default true
//   }
//
// Response:
//   {
//     "ok": true,
//     "booksScanned": N,
//     "booksStripped": N,
//     "totalHits": N,
//     "totalBytesChanged": N,
//     "durationMs": N,
//     "perBook": [{ bookId, title, ok, error?, phrases?, totalHits?, … }]
//   }

import { NextRequest, NextResponse } from 'next/server';
import { listBooks } from '@/lib/db/books';
import { getBookWatermarks } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PerBookSummary {
  bookId: string;
  title: string;
  ok: boolean;
  error?: string;
  phrases?: number;
  totalHits?: number;
  bytesChanged?: number;
  chaptersStripped?: number;
  durationMs?: number;
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      onlyMissingWatermarks?: boolean;
      autoDetect?: boolean;
      persistToMemory?: boolean;
    };
    const onlyMissing = body.onlyMissingWatermarks === true;

    const books = await listBooks({ limit: 500 });
    if (books.length === 0) {
      return NextResponse.json({
        ok: true,
        booksScanned: 0,
        booksStripped: 0,
        totalHits: 0,
        totalBytesChanged: 0,
        durationMs: Date.now() - t0,
        perBook: [],
      });
    }

    // Filter before doing I/O work.
    const targets = onlyMissing
      ? await Promise.all(books.map(async (b) => {
          const w = await getBookWatermarks(b.id);
          return { b, hasSavedPhrases: w.length > 0 };
        })).then((arr) => arr.filter((x) => !x.hasSavedPhrases).map((x) => x.b))
      : books;

    // Sequential so we don't hammer SQLite + filesystem in parallel.
    const results: PerBookSummary[] = [];
    let booksStripped = 0;
    let totalHits = 0;
    let totalBytesChanged = 0;

    for (const book of targets) {
      try {
        // Reuse the per-book endpoint via in-process call to avoid
        // round-tripping through fetch — saves a few hundred ms per book.
        const { POST: rerunOne } = await import('@/app/api/library/[id]/watermarks/rerun/route');
        const innerReq = new NextRequest(
          new URL(`http://internal/library/${book.id}/watermarks/rerun`, req.url),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              autoDetect: body.autoDetect !== false,
              persistToMemory: body.persistToMemory !== false,
            }),
          },
        );
        const innerRes = await rerunOne(innerReq, {
          params: Promise.resolve({ id: book.id }),
        });
        const data = await innerRes.json();
        if (innerRes.ok && data?.ok) {
          booksStripped++;
          totalHits += data.totalHits ?? 0;
          totalBytesChanged += data.bytesChanged ?? 0;
          results.push({
            bookId: book.id,
            title: book.title,
            ok: true,
            phrases: Array.isArray(data.phrases) ? data.phrases.length : 0,
            totalHits: data.totalHits ?? 0,
            bytesChanged: data.bytesChanged ?? 0,
            chaptersStripped: data.chaptersStripped ?? 0,
            durationMs: data.durationMs ?? 0,
          });
        } else {
          results.push({
            bookId: book.id,
            title: book.title,
            ok: false,
            error: data?.error ?? `HTTP ${innerRes.status}`,
          });
        }
      } catch (err) {
        results.push({
          bookId: book.id,
          title: book.title,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      booksScanned: targets.length,
      booksStripped,
      totalHits,
      totalBytesChanged,
      durationMs: Date.now() - t0,
      perBook: results,
    });
  } catch (err) {
    console.error('[watermarks/rerun-all]', err);
    return NextResponse.json(
      { error: 'Rerun-all failed: ' + (err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

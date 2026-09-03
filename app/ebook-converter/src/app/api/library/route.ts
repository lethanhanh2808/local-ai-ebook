// src/app/api/library/route.ts
// GET /api/library      – list all books (optional ?search= and ?language=)
// POST /api/library     – add a completed job's output to the library
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { listBooks, createBook } from '@/lib/db/books';
import { getJob } from '@/lib/db/jobs';
import { libraryPath, coverPath, ensureDirs } from '@/lib/storage';
import { extractCoverFromEpub } from '@/lib/pipeline/epub-cover';
import { restampDeepFormatSidecar } from '@/lib/pipeline/deep-format-sidecar';
import { assertWithinRoots, pathRoots, SafePathError } from '@/lib/storage/safe-path';

/** Convert a filename stem to a human-readable title.
 *  e.g. "bat-dau-100-trieu-nam-tu-vi" → "Bat Dau 100 Trieu Nam Tu Vi"
 */
function filenameToTitle(filename: string): string {
  const stem = path.basename(filename, path.extname(filename));
  return stem
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get('search') ?? undefined;
  const language = req.nextUrl.searchParams.get('language') ?? undefined;
  const series = req.nextUrl.searchParams.get('series') ?? undefined;
  const readStatus = req.nextUrl.searchParams.get('readStatus') ?? undefined;
  const isFavorite = req.nextUrl.searchParams.get('isFavorite') === 'true' ? true : undefined;
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam ? Math.min(500, Math.max(1, parseInt(limitParam, 10) || 200)) : undefined;
  try {
    const books = await listBooks({ search, language, series, readStatus, isFavorite, limit });
    return NextResponse.json(books);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      jobId: string;
      tags?: string[];
      notes?: string;
    };

    if (!body.jobId) {
      return NextResponse.json({ error: 'jobId required' }, { status: 400 });
    }

    const job = await getJob(body.jobId);
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (job.status !== 'completed') {
      return NextResponse.json({ error: 'Job has not completed yet' }, { status: 400 });
    }
    if (!job.outputPath) {
      return NextResponse.json({ error: 'Output file not found' }, { status: 404 });
    }
    let jobOutputPath: string;
    try {
      jobOutputPath = assertWithinRoots(job.outputPath, [pathRoots().output]);
    } catch (error) {
      if (error instanceof SafePathError) {
        return NextResponse.json({ error: 'Output file not found' }, { status: 404 });
      }
      throw error;
    }
    if (!fs.existsSync(jobOutputPath)) {
      return NextResponse.json({ error: 'Output file not found' }, { status: 404 });
    }

    ensureDirs();
    const bookId = uuid();
    const dest = libraryPath(bookId);

    // Copy output EPUB to library directory
    fs.copyFileSync(jobOutputPath, dest);
    const fileSize = fs.statSync(dest).size;

    // ── Carry over the deep-format sidecar (if any) ────────────────
    // When the conversion ran with deepFormat=true the worker wrote a
    // `<jobOutputPath>.deepFormat.json` next to the EPUB. The character-
    // bible worker reads this sidecar instead of re-parsing the source,
    // so we MUST copy it alongside the new library file — otherwise the
    // user's expensive AI cleanup is invisible to the bible pipeline.
    // Best-effort: a missing sidecar just means the bible worker falls
    // back to the raw EPUB (the existing behavior).
    let deepFormatSidecar: { path: string; bytes: number } | null = null;
    try {
      const sidecarSrc = `${jobOutputPath}.deepFormat.json`;
      if (fs.existsSync(sidecarSrc)) {
        const sidecarDest = `${dest}.deepFormat.json`;
        fs.copyFileSync(sidecarSrc, sidecarDest);
        const sb = fs.statSync(sidecarDest).size;
        deepFormatSidecar = { path: sidecarDest, bytes: sb };
        // Re-stamp the sidecar's bookId field with the new Book UUID so
        // the sidecar remains self-identifying for downstream consumers.
        // (Read-side tolerates mismatched ids; this just keeps things
        // clean if the user inspects the file directly.)
        await restampDeepFormatSidecar({ epubPath: dest, newBookId: bookId })
          .catch((err) => console.warn('[library-import] sidecar restamp failed:', err));
      }
    } catch (err) {
      console.warn('[library-import] deep-format sidecar copy failed:', err);
    }

    // Extract cover image from EPUB (best-effort)
    let cover: string | undefined;
    try {
      const coverDest = coverPath(bookId);
      const extracted = await extractCoverFromEpub(dest, coverDest);
      if (extracted) cover = coverDest;
    } catch { /* no cover — fine */ }

    const meta = (job.metadata as Record<string, string> | null) ?? {};
    const book = await createBook({
      id: bookId,
      title:           meta.title            || filenameToTitle(job.filename),
      author:          meta.author           ?? 'Unknown',
      language:        meta.language         ?? 'vi',
      description:     meta.description,
      publisher:       meta.publisher,
      publishDate:     meta.date,
      identifier:      meta.identifier,
      coverPath:       cover,
      filePath:        dest,
      fileSize,
      originalFilename: job.filename,
      tags:  body.tags  ?? [],
      notes: body.notes,
    });

    return NextResponse.json(
      { ...book, deepFormatSidecar },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

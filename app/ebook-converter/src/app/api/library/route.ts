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

    return NextResponse.json(book, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

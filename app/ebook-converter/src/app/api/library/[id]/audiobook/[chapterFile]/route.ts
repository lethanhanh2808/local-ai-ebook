// src/app/api/library/[id]/audiobook/[chapterFile]/route.ts
// GET /api/library/[id]/audiobook/[chapterFile] – stream the pre-generated audio
// Supports both WAV (legacy) and MP3 (new, ~7.7× smaller) formats.
// Range requests supported for HTML5 audio seek.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { getChapter } from '@/lib/db/audiobook';
import { assertWithinRoots, pathRoots, SafePathError } from '@/lib/storage/safe-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterFile: string }> }
) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const chapterFile = decodeURIComponent(params.chapterFile);
  const row = await getChapter(params.id, chapterFile);
  if (!row || row.status !== 'ready' || !row.audioPath) {
    return NextResponse.json({ error: 'Audio not generated yet', status: row?.status ?? 'missing' }, { status: 404 });
  }

  let audioPath: string;
  try {
    audioPath = assertWithinRoots(row.audioPath, [pathRoots().audiobooks]);
  } catch (error) {
    if (error instanceof SafePathError) {
      return NextResponse.json({ error: 'Audio not generated yet', status: 'missing' }, { status: 404 });
    }
    throw error;
  }
  if (!fs.existsSync(audioPath)) {
    return NextResponse.json({ error: 'Audio not generated yet', status: 'missing' }, { status: 404 });
  }

  const stat = fs.statSync(audioPath);
  const total = stat.size;
  const range = req.headers.get('range');
  const ext = path.extname(audioPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  const baseName = `${book.title} – ${row.chapterTitle ?? path.basename(chapterFile, '.xhtml')}`
    .replace(/[^\x20-\x7E]/g, '_');
  const filename = `${baseName}${ext}`;

  if (range) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (!m) return NextResponse.json({ error: 'bad range' }, { status: 416 });
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (start >= total || end >= total || end < start) {
      return NextResponse.json(
        { error: 'range out of bounds' },
        { status: 416, headers: { 'Content-Range': `bytes */${total}` } },
      );
    }
    const chunk = end - start + 1;
    const stream = fs.createReadStream(audioPath, { start, end });
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(chunk),
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // Full file
  const stream = fs.createReadStream(audioPath);
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

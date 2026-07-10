// src/app/api/library/[id]/download/route.ts
// GET /api/library/:id/download – stream the EPUB file
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { resolveBookPath } from '@/lib/storage';
import { assertWithinRoots, pathRoots, SafePathError } from '@/lib/storage/safe-path';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  let filePath: string;
  try {
    filePath = assertWithinRoots(await resolveBookPath(book), [pathRoots().library]);
  } catch (error) {
    if (error instanceof SafePathError) {
      return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
    }
    throw error;
  }
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  // Build a safe ASCII fallback plus RFC 5987 UTF-8 encoded name
  const rawName = `${book.title} - ${book.author}.epub`;
  const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/[/\\?%*:|"<>]/g, '-').trim();
  const encodedName = encodeURIComponent(rawName);

  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'private, no-store',
    },
  });
}

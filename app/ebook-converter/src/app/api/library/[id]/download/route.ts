// src/app/api/library/[id]/download/route.ts
// GET /api/library/:id/download – stream the EPUB file
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { resolveBookPath } from '@/lib/storage';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const filePath = await resolveBookPath(book);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  const buf = fs.readFileSync(filePath);
  // Build a safe ASCII fallback plus RFC 5987 UTF-8 encoded name
  const rawName = `${book.title} - ${book.author}.epub`;
  const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/[/\\?%*:|"<>]/g, '-').trim();
  const encodedName = encodeURIComponent(rawName);

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': String(buf.length),
    },
  });
}

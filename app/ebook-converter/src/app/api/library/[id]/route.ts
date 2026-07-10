// src/app/api/library/[id]/route.ts
// GET    /api/library/:id  – book details
// PATCH  /api/library/:id  – update tags/notes/readProgress
// DELETE /api/library/:id  – remove from library (file stays on disk unless purge=1)
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getBook, updateBook, deleteBook } from '@/lib/db/books';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(book);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json() as {
    title?: string;
    /** Override title used by the cover generator. Pass null to fall
     *  back to the stored `title`. */
    titleVi?: string | null;
    author?: string;
    language?: string;
    description?: string;
    publisher?: string;
    publishDate?: string;
    identifier?: string;
    series?: string;
    seriesIndex?: number;
    rating?: number;
    tags?: string[];
    notes?: string;
    readProgress?: number;
    readStatus?: string;
    isFavorite?: boolean;
    lastRead?: string;
  };

  const updated = await updateBook(params.id, {
    ...body,
    lastRead: body.lastRead ? new Date(body.lastRead) : undefined,
  });
  return NextResponse.json(updated);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const purge = req.nextUrl.searchParams.get('purge') === '1';
  if (purge && fs.existsSync(book.filePath)) {
    fs.unlinkSync(book.filePath);
  }
  if (book.coverPath && fs.existsSync(book.coverPath)) {
    try { fs.unlinkSync(book.coverPath); } catch { /* ok */ }
  }

  await deleteBook(params.id);
  return NextResponse.json({ ok: true });
}

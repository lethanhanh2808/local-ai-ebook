// POST /api/shelves/[id]/books – add book to shelf
// DELETE /api/shelves/[id]/books?bookId=xxx – remove book from shelf
import { NextRequest, NextResponse } from 'next/server';
import { addBookToShelf, getBook, getShelf, removeBookFromShelf } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { bookId } = await req.json().catch(() => ({})) as { bookId?: unknown };
  if (typeof bookId !== 'string' || !bookId) return NextResponse.json({ error: 'bookId required' }, { status: 400 });
  const [shelf, book] = await Promise.all([getShelf(params.id), getBook(bookId)]);
  if (!shelf) return NextResponse.json({ error: 'Shelf not found' }, { status: 404 });
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  await addBookToShelf(params.id, bookId);
  return new NextResponse(null, { status: 204 });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const bookId = req.nextUrl.searchParams.get('bookId');
  if (!bookId) return NextResponse.json({ error: 'bookId required' }, { status: 400 });
  await removeBookFromShelf(params.id, bookId);
  return new NextResponse(null, { status: 204 });
}

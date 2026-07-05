// POST /api/shelves/[id]/books – add book to shelf
// DELETE /api/shelves/[id]/books?bookId=xxx – remove book from shelf
import { NextRequest, NextResponse } from 'next/server';
import { addBookToShelf, removeBookFromShelf } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { bookId } = await req.json() as { bookId: string };
  if (!bookId) return NextResponse.json({ error: 'bookId required' }, { status: 400 });
  await addBookToShelf(params.id, bookId);
  return new NextResponse(null, { status: 204 });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const bookId = req.nextUrl.searchParams.get('bookId');
  if (!bookId) return NextResponse.json({ error: 'bookId required' }, { status: 400 });
  await removeBookFromShelf(params.id, bookId);
  return new NextResponse(null, { status: 204 });
}

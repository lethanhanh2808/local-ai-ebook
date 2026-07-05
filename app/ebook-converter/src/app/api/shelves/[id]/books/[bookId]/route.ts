// DELETE /api/shelves/[id]/books/[bookId] – remove a specific book from a shelf
import { NextRequest, NextResponse } from 'next/server';
import { removeBookFromShelf } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; bookId: string } },
) {
  await removeBookFromShelf(params.id, params.bookId);
  return new NextResponse(null, { status: 204 });
}

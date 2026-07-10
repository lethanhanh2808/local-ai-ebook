// DELETE /api/shelves/[id]/books/[bookId] – remove a specific book from a shelf
import { NextRequest, NextResponse } from 'next/server';
import { removeBookFromShelf } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ id: string; bookId: string }> }
) {
  const params = await props.params;
  await removeBookFromShelf(params.id, params.bookId);
  return new NextResponse(null, { status: 204 });
}

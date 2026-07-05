// GET /api/shelves/[id] – get shelf with books
// PATCH /api/shelves/[id] – update shelf
// DELETE /api/shelves/[id] – delete shelf
import { NextRequest, NextResponse } from 'next/server';
import { getShelf, updateShelf, deleteShelf, addBookToShelf, removeBookFromShelf } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const shelf = await getShelf(params.id);
  if (!shelf) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(shelf);
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json() as { name?: string; description?: string; isPublic?: boolean; sortOrder?: number };
  const shelf = await updateShelf(params.id, body);
  return NextResponse.json(shelf);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteShelf(params.id);
  return new NextResponse(null, { status: 204 });
}

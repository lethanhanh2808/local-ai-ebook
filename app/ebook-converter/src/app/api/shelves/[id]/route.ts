// GET /api/shelves/[id] – get shelf with books
// PATCH /api/shelves/[id] – update shelf
// DELETE /api/shelves/[id] – delete shelf
import { NextRequest, NextResponse } from 'next/server';
import { getShelf, updateShelf, deleteShelf } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const shelf = await getShelf(params.id);
  if (!shelf) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(shelf);
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const existing = await getShelf(params.id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const data: Parameters<typeof updateShelf>[1] = {};
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }
    if (body.name.trim().length > 200) {
      return NextResponse.json({ error: 'Name is too long' }, { status: 400 });
    }
    data.name = body.name.trim();
  }
  if ('description' in body) {
    if (typeof body.description !== 'string') {
      return NextResponse.json({ error: 'Description must be a string' }, { status: 400 });
    }
    data.description = body.description.trim().slice(0, 2_000);
  }
  if ('isPublic' in body) {
    if (typeof body.isPublic !== 'boolean') {
      return NextResponse.json({ error: 'isPublic must be a boolean' }, { status: 400 });
    }
    data.isPublic = body.isPublic;
  }
  if ('sortOrder' in body) {
    if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
      return NextResponse.json({ error: 'sortOrder must be a number' }, { status: 400 });
    }
    data.sortOrder = Math.max(-100_000, Math.min(100_000, Math.trunc(body.sortOrder)));
  }
  const shelf = await updateShelf(params.id, data);
  return NextResponse.json(shelf);
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const existing = await getShelf(params.id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await deleteShelf(params.id);
  return new NextResponse(null, { status: 204 });
}

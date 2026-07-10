// GET /api/shelves – list all shelves
// POST /api/shelves – create a shelf
import { NextRequest, NextResponse } from 'next/server';
import { listShelves, createShelf } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const shelves = await listShelves();
  return NextResponse.json(shelves);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { name?: unknown; description?: unknown; isPublic?: unknown } | null;
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }
  if (body.name.trim().length > 200) {
    return NextResponse.json({ error: 'Name is too long' }, { status: 400 });
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return NextResponse.json({ error: 'Description must be a string' }, { status: 400 });
  }
  if (body.isPublic !== undefined && typeof body.isPublic !== 'boolean') {
    return NextResponse.json({ error: 'isPublic must be a boolean' }, { status: 400 });
  }
  const description = typeof body.description === 'string'
    ? body.description.trim().slice(0, 2_000) || undefined
    : undefined;
  const shelf = await createShelf({
    name: body.name.trim(),
    description,
    isPublic: body.isPublic ?? false,
  });
  return NextResponse.json(shelf, { status: 201 });
}

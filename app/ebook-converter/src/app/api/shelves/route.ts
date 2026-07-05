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
  const body = await req.json() as { name: string; description?: string; isPublic?: boolean };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }
  const shelf = await createShelf({ name: body.name.trim(), description: body.description, isPublic: body.isPublic ?? false });
  return NextResponse.json(shelf, { status: 201 });
}

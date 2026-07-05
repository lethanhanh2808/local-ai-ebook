// GET /api/stats – library statistics
import { NextResponse } from 'next/server';
import { getLibraryStats } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stats = await getLibraryStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error('[/api/stats] error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

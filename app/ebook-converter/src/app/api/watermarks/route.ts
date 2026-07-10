// src/app/api/watermarks/route.ts
// GET   /api/watermarks   – list remembered watermark phrases
// POST  /api/watermarks   – add a phrase manually (source = 'user')
//
// DELETE lives in ./[phrase]/route.ts so the URL pattern mirrors the
// canonical ".../resource/{id}" convention.
import { NextRequest, NextResponse } from 'next/server';
import { listWatermarkMemory, rememberWatermark } from '@/lib/db/watermark-memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await listWatermarkMemory();
    return NextResponse.json({ phrases: rows });
  } catch (err) {
    console.error('[api/watermarks] GET failed:', err);
    return NextResponse.json({ error: 'Failed to list watermarks' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { phrase?: string };
    const phrase = typeof body.phrase === 'string' ? body.phrase : '';
    if (phrase.trim().length < 4) {
      return NextResponse.json(
        { error: 'Phrase must be at least 4 characters' },
        { status: 400 },
      );
    }
    if (phrase.length > 200) {
      return NextResponse.json(
        { error: 'Phrase too long (max 200 chars)' },
        { status: 400 },
      );
    }
    const row = await rememberWatermark(phrase, 'user');
    if (!row) {
      return NextResponse.json(
        { error: 'Phrase rejected (normalization failed)' },
        { status: 400 },
      );
    }
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error('[api/watermarks] POST failed:', err);
    return NextResponse.json({ error: 'Failed to add watermark' }, { status: 500 });
  }
}

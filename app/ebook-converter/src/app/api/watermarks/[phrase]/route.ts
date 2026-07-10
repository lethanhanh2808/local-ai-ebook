// src/app/api/watermarks/[phrase]/route.ts
// DELETE /api/watermarks/[phrase] – remove a phrase from memory
//
// The `phrase` URL segment is just the literal phrase; we use encodeURIComponent
// on the client side. Empty segment or non-string is rejected at the route
// matcher (Next 14 dynamic segments do not accept the empty string).
import { NextRequest, NextResponse } from 'next/server';
import { forgetWatermark } from '@/lib/db/watermark-memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, props: { params: Promise<{ phrase: string }> }) {
  const params = await props.params;
  try {
    const ok = await forgetWatermark(decodeURIComponent(params.phrase));
    if (!ok) {
      return NextResponse.json(
        { error: 'Phrase not found in memory' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/watermarks] DELETE failed:', err);
    return NextResponse.json({ error: 'Failed to delete watermark' }, { status: 500 });
  }
}

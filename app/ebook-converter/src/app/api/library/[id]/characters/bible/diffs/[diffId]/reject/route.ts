// src/app/api/library/[id]/characters/bible/diffs/[diffId]/reject/route.ts
// POST   /api/library/:id/characters/bible/diffs/:diffId/reject
//
// Flip a pending diff to 'rejected' status. Idempotent — the UI may retry
// without producing stale rows.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ id: string; diffId: string }> }
) {
  const params = await props.params;
  const { id: bookId, diffId } = params;
  const diff = await prisma.pendingBibleDiff.findUnique({ where: { id: diffId } });
  if (!diff) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (diff.bookId !== bookId) {
    return NextResponse.json({ error: 'Diff belongs to a different book' }, { status: 403 });
  }
  if (diff.status !== 'pending') {
    return NextResponse.json({ ok: true, alreadyHandled: true, status: diff.status });
  }
  await prisma.pendingBibleDiff.update({
    where: { id: diffId },
    data: { status: 'rejected' },
  });
  return NextResponse.json({ ok: true, diffId });
}

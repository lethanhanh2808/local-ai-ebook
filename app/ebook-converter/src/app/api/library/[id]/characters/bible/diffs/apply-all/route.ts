// src/app/api/library/[id]/characters/bible/diffs/apply-all/route.ts
// POST   /api/library/:id/characters/bible/diffs/apply-all
//
// Bulk-apply every pending diff whose `autoReason` does NOT begin with
// "conflict-". Conflicting diffs remain pending so the user must decide
// per row. Returns counts + the applied diff ids.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { applyAcceptedBiblePatch } from '@/lib/ai/character-bible';
import type { BibleDiffPatch } from '@/lib/db/character-bible';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const rows = await prisma.pendingBibleDiff.findMany({
    where: { bookId: params.id, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
  const appliedIds: string[] = [];
  let skipped = 0;
  const errors: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    let patch: BibleDiffPatch;
    try { patch = JSON.parse(row.patch) as BibleDiffPatch; }
    catch {
      skipped++;
      errors.push({ id: row.id, reason: 'malformed-patch' });
      continue;
    }
    // User-edit conflicts remain individual decisions. Other review-only
    // proposals are safe to accept in bulk, but must be committed before
    // their status changes.
    if (patch.autoReason === 'conflict-with-user-edit') {
      skipped++;
      continue;
    }
    const result = await applyAcceptedBiblePatch(params.id, patch);
    if (!result.applied) {
      skipped++;
      errors.push({ id: row.id, reason: result.reason ?? 'apply-failed' });
      continue;
    }
    await prisma.pendingBibleDiff.update({
      where: { id: row.id },
      data: { status: 'applied' },
    });
    appliedIds.push(row.id);
  }
  return NextResponse.json({
    ok: true,
    appliedIds,
    skipped,
    errors,
  });
}

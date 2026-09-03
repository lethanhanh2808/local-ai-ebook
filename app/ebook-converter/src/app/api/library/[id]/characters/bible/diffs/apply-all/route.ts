// src/app/api/library/[id]/characters/bible/diffs/apply-all/route.ts
// POST   /api/library/:id/characters/bible/diffs/apply-all
//
// Bulk-apply EVERY pending diff for a book. Used by the "Áp dụng tất cả"
// button in the Đề xuất chờ duyệt panel — clicking that button is the
// user's explicit consent to apply every suggestion, INCLUDING any that
// conflict with their prior edits (which would otherwise stay queued
// forever and break the bulk-apply UX).
//
// The previous version skipped `conflict-with-user-edit` rows on the
// assumption that conflicts need per-row review. That was correct as a
// safety policy but it left the "Áp dụng tất cả" button useless for any
// book where every suggestion happened to conflict with the user's
// manual edits (the common case after a long edit session followed by a
// refresh). The fix keeps per-row review as the *default* flow (the
// single-diff Áp dụng button stays red/destructive on conflicts) while
// letting bulk apply actually do what it says.
//
// Returns appliedIds (all), conflictAppliedIds (subset that overwrote
// user edits) and skipped (rows that errored).
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
  const conflictAppliedIds: string[] = [];
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
    const isConflict = patch.autoReason === 'conflict-with-user-edit';
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
    if (isConflict) conflictAppliedIds.push(row.id);
  }
  return NextResponse.json({
    ok: true,
    appliedIds,
    conflictAppliedIds,
    skipped,
    errors,
  });
}

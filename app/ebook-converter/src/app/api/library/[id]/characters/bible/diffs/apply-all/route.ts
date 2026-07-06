// src/app/api/library/[id]/characters/bible/diffs/apply-all/route.ts
// POST   /api/library/:id/characters/bible/diffs/apply-all
//
// Bulk-apply every pending diff whose `autoReason` does NOT begin with
// "conflict-". Conflicting diffs remain pending so the user must decide
// per row. Returns counts + the applied diff ids.
import { NextRequest, NextResponse } from 'next/server';
import { applyAllNonConflictingDiff } from '@/lib/db/character-bible';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const result = await applyAllNonConflictingDiff(params.id);
  return NextResponse.json({
    ok: true,
    appliedIds: result.appliedIds,
    skipped: result.skipped,
  });
}

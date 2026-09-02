// src/app/api/library/[id]/characters/bible/diffs/[diffId]/apply/route.ts
// POST   /api/library/:id/characters/bible/diffs/:diffId/apply
//
// Apply a single pending bible diff. The diff was queued by either a
// manual refresh or an auto-refresh that hit a `source='user'` field.
// This route writes the patch (overriding the user-lock check on
// relationship rows and silently upgrading `source` to 'user' on profile
// rows) and flips PendingBibleDiff.status='applied'.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { applyAcceptedBiblePatch } from '@/lib/ai/character-bible';
import type { BibleDiffPatch } from '@/lib/db/character-bible';

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
    return NextResponse.json({ error: `Diff status is ${diff.status}` }, { status: 409 });
  }

  let body: { merged?: Partial<{ description: string; personality: string; speechStyle: string; visualDescription: string }> } = {};
  try { body = (await _req.json()) as typeof body; } catch { /* no body is fine */ }

  let patch: BibleDiffPatch;
  try { patch = JSON.parse(diff.patch) as BibleDiffPatch; }
  catch { return NextResponse.json({ error: 'Diff patch is malformed' }, { status: 500 }); }

  // When the UI sends an AI-merged value set, override the proposed fields
  // with the merged ones before applying (so "merge" decisions actually
  // combine current + proposed instead of just accepting the proposal).
  if (body.merged && patch.kind === 'update' && patch.updateFields) {
    const m = body.merged;
    patch = {
      ...patch,
      updateFields: {
        ...patch.updateFields,
        ...(m.description !== undefined ? { description: m.description } : {}),
        ...(m.personality !== undefined ? { personality: m.personality } : {}),
        ...(m.speechStyle !== undefined ? { speechStyle: m.speechStyle } : {}),
        ...(m.visualDescription !== undefined ? { visualDescription: m.visualDescription } : {}),
      },
    };
  }

  const result = await applyAcceptedBiblePatch(bookId, patch);
  if (!result.applied) {
    return NextResponse.json(
      { error: result.reason ?? 'Diff could not be applied' },
      { status: 422 },
    );
  }

  await prisma.pendingBibleDiff.update({
    where: { id: diffId },
    data: { status: 'applied' },
  });

  return NextResponse.json({ ok: true, diffId });
}

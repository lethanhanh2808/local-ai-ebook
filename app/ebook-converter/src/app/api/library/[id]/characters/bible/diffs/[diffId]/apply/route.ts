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
import { applyBiblePatch } from '@/lib/ai/character-bible';
import type { BibleDiffPatch } from '@/lib/db/character-bible';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string; diffId: string } },
) {
  const { id: bookId, diffId } = params;
  const diff = await prisma.pendingBibleDiff.findUnique({ where: { id: diffId } });
  if (!diff) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (diff.bookId !== bookId) {
    return NextResponse.json({ error: 'Diff belongs to a different book' }, { status: 403 });
  }
  if (diff.status !== 'pending') {
    return NextResponse.json({ error: `Diff status is ${diff.status}` }, { status: 409 });
  }

  let patch: BibleDiffPatch;
  try { patch = JSON.parse(diff.patch) as BibleDiffPatch; }
  catch { return NextResponse.json({ error: 'Diff patch is malformed' }, { status: 500 }); }

  // For an explicit user apply we honour the LLM's proposed value and
  // overwrite any existing row, upgrading `source` to 'user' so the next
  // auto-refresh doesn't undo it.
  const patched = patch;
  if (patched.kind === 'update' && patched.characterId && patched.updateFields) {
    await prisma.characterProfile.upsert({
      where: { characterId: patched.characterId },
      create: {
        characterId: patched.characterId,
        description: patched.updateFields.description ?? null,
        personality: patched.updateFields.personality ?? null,
        speechStyle: patched.updateFields.speechStyle ?? null,
        visualDescription: patched.updateFields.visualDescription ?? null,
        visualSource: patched.updateFields.visualDescription != null ? 'user' : null,
        source: 'user',
        version: 1,
      },
      update: {
        description: patched.updateFields.description ?? undefined,
        personality: patched.updateFields.personality ?? undefined,
        speechStyle: patched.updateFields.speechStyle ?? undefined,
        visualDescription: patched.updateFields.visualDescription ?? undefined,
        source: 'user',
      },
    });
  } else if (patched.kind === 'relationship' && patched.relationship?.relationship) {
    const r = patched.relationship;
    if (!r.fromCharId || !r.toCharId) {
      return NextResponse.json({ error: 'Relationship diff is missing character ids' }, { status: 422 });
    }
    await prisma.characterRelationship.upsert({
      where: {
        bookId_fromCharId_toCharId_relationship: {
          bookId,
          fromCharId: r.fromCharId,
          toCharId: r.toCharId,
          relationship: r.relationship,
        },
      },
      create: {
        bookId,
        fromCharId: r.fromCharId,
        toCharId: r.toCharId,
        relationship: r.relationship,
        asOfChapterIdx: r.asOfChapterIdx ?? null,
        notes: r.notes ?? null,
        source: 'user',
      },
      update: {
        asOfChapterIdx: r.asOfChapterIdx ?? null,
        notes: r.notes ?? null,
        source: 'user',
      },
    });
  } else {
    // kind='new' / 'appearance' / etc. — route through the unified applier.
    await applyBiblePatch(bookId, { ...patched }, false);
  }

  await prisma.pendingBibleDiff.update({
    where: { id: diffId },
    data: { status: 'applied' },
  });

  return NextResponse.json({ ok: true, diffId });
}

// src/app/api/library/[id]/characters/[characterId]/profile/route.ts
// PATCH  /api/library/:id/characters/:characterId/profile
//
// User-authoritative profile edit. Always sets `source='user'` so the LLM
// refresh will treat the field as locked and queue any future
// conflict-with-user-edit patches for review.
//
// Body (any combination; null clears the field):
//   { description?: string|null, personality?: string|null, speechStyle?: string|null,
//     visualDescription?: string|null }
//
// The character MUST belong to the book in :id; otherwise 404.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { setUserProfile } from '@/lib/ai/character-bible';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; characterId: string } },
) {
  const character = await prisma.character.findUnique({
    where: { id: params.characterId },
    select: { id: true, bookId: true },
  });
  if (!character || character.bookId !== params.id) {
    return NextResponse.json({ error: 'Character not found' }, { status: 404 });
  }

  let body: {
    description?: string | null;
    personality?: string | null;
    speechStyle?: string | null;
    visualDescription?: string | null;
  } = {};
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const allowed = ['description', 'personality', 'speechStyle', 'visualDescription'] as const;
  const touched: Array<keyof typeof body> = [];
  for (const k of allowed) if (k in body) touched.push(k);
  if (touched.length === 0) {
    return NextResponse.json({ error: 'No fields supplied' }, { status: 400 });
  }

  await setUserProfile({
    characterId: params.characterId,
    description: body.description,
    personality: body.personality,
    speechStyle: body.speechStyle,
    visualDescription: body.visualDescription,
  });

  const updated = await prisma.characterProfile.findUnique({
    where: { characterId: params.characterId },
  });
  return NextResponse.json({
    ok: true,
    characterId: params.characterId,
    profile: updated,
    touchedFields: touched,
  });
}

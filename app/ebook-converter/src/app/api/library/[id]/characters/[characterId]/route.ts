// src/app/api/library/[id]/characters/[characterId]/route.ts
// PATCH /api/library/[id]/characters/[characterId]
//
// Per-character voice customization (speed/emotion). Stored on the Character
// row (NOT the shared Voice) so two characters that happen to share the same
// voiceId keep independent settings — fixing the bug where editing one card's
// speed silently changed another card's speed.
//
// Body (any combination; null clears the field):
//   { defaultSpeed?: number|null, defaultEmotion?: string|null }
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { clampSpeechSpeed } from '@/lib/tts/speech-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; characterId: string }> },
) {
  const params = await props.params;
  const character = await prisma.character.findUnique({
    where: { id: params.characterId },
    select: { id: true, bookId: true },
  });
  if (!character || character.bookId !== params.id) {
    return NextResponse.json({ error: 'Character not found' }, { status: 404 });
  }

  let body: { defaultSpeed?: number | null; defaultEmotion?: string | null };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const data: { defaultSpeed?: number | null; defaultEmotion?: string | null } = {};
  if ('defaultSpeed' in body) {
    if (body.defaultSpeed === null) data.defaultSpeed = null;
    else if (typeof body.defaultSpeed === 'number' && Number.isFinite(body.defaultSpeed)) {
      data.defaultSpeed = clampSpeechSpeed(body.defaultSpeed);
    } else {
      return NextResponse.json({ error: 'defaultSpeed must be a finite number or null' }, { status: 400 });
    }
  }
  if ('defaultEmotion' in body) {
    if (body.defaultEmotion === null) data.defaultEmotion = null;
    else if (typeof body.defaultEmotion === 'string') {
      data.defaultEmotion = body.defaultEmotion.trim().slice(0, 40) || null;
    } else {
      return NextResponse.json({ error: 'defaultEmotion must be a string or null' }, { status: 400 });
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No fields supplied' }, { status: 400 });
  }

  try {
    const updated = await prisma.character.update({
      where: { id: params.characterId },
      data,
    });
    return NextResponse.json({ character: updated });
  } catch (err: any) {
    console.error('[characters/[characterId]] PATCH error:', err);
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}

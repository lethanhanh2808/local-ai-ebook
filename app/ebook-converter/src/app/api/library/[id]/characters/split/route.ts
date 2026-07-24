// src/app/api/library/[id]/characters/split/route.ts
// POST /api/library/[id]/characters/split
//
// Phase 4.4 of docs/NEXT_UP_PLAN.md — splits a character into two by
// moving a subset of aliases onto a new character row.
// Body: { characterId, aliasesToMove, newName, newRole?, newVoiceName? }
//
// Behavior: a new Character row is created; the named aliases are moved
// to it (with source='user' — a manual split is a user-authoritative
// action). Chapter appearances are NOT moved (they're tracked by
// characterId and a split is a roster change, not a chapter-reassignment).
// The response includes `appearancesMoved: false` so the UI can warn.

import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import { splitCharacter } from '@/lib/db/characters';
import { createVoice, listVoices } from '@/lib/db/voices';
import { setBookAudiobookStatus } from '@/lib/db/audiobook';
import { BUILTIN_VIENEU_NAMES } from '@/lib/tts/vieneu-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUILTIN_VIENEU = new Set(BUILTIN_VIENEU_NAMES);

const VALID_ROLES = new Set(['main', 'supporting', 'minor', 'crowd']);

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as {
    characterId?: unknown;
    aliasesToMove?: unknown;
    newName?: unknown;
    newRole?: unknown;
    newVoiceName?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  if (typeof body.characterId !== 'string' || !body.characterId) {
    return NextResponse.json({ error: 'characterId (string) is required' }, { status: 400 });
  }
  if (!Array.isArray(body.aliasesToMove) || body.aliasesToMove.length === 0) {
    return NextResponse.json({ error: 'aliasesToMove (non-empty array) is required' }, { status: 400 });
  }
  if (body.aliasesToMove.some((a) => typeof a !== 'string' || !a)) {
    return NextResponse.json({ error: 'Every entry of aliasesToMove must be a non-empty string' }, { status: 400 });
  }
  if (typeof body.newName !== 'string' || !body.newName.trim()) {
    return NextResponse.json({ error: 'newName (non-empty string) is required' }, { status: 400 });
  }
  let newRole: 'main' | 'supporting' | 'minor' | 'crowd' | undefined;
  if (body.newRole !== undefined) {
    if (typeof body.newRole !== 'string' || !VALID_ROLES.has(body.newRole)) {
      return NextResponse.json({ error: 'newRole must be one of main | supporting | minor | crowd' }, { status: 400 });
    }
    newRole = body.newRole as 'main' | 'supporting' | 'minor' | 'crowd';
  }
  let newVoiceName: string | undefined;
  if (body.newVoiceName !== undefined) {
    if (typeof body.newVoiceName !== 'string' || !body.newVoiceName) {
      return NextResponse.json({ error: 'newVoiceName must be a non-empty string' }, { status: 400 });
    }
    if (!BUILTIN_VIENEU.has(body.newVoiceName)) {
      return NextResponse.json({ error: `newVoiceName must be a built-in VieNeu voice (got "${body.newVoiceName}")` }, { status: 400 });
    }
    newVoiceName = body.newVoiceName;
  }

  const result = await splitCharacter(params.id, {
    characterId: body.characterId,
    aliasesToMove: body.aliasesToMove as string[],
    newName: body.newName,
    newRole,
    newVoiceName,
  });

  if (!result.ok) {
    switch (result.error.kind) {
      case 'empty-aliases':
        return NextResponse.json({ error: 'aliasesToMove must be non-empty' }, { status: 400 });
      case 'survivor-not-found':
        return NextResponse.json({ error: 'Source character not found or one of the requested aliases does not belong to it' }, { status: 404 });
      case 'cross-book':
        return NextResponse.json({ error: 'Character does not belong to this book' }, { status: 404 });
      case 'name-collision':
        return NextResponse.json(
          { error: `A character named "${body.newName}" already exists in this book`, existingCharacterId: result.error.existingCharacterId },
          { status: 409 },
        );
    }
  }

  // Optional: assign a built-in voice to the new character if requested.
  if (newVoiceName && result.ok) {
    const existing = await listVoices(params.id);
    let voice = existing.find((v) => v.name === newVoiceName);
    if (!voice) {
      voice = await createVoice({
        bookId: params.id,
        name: newVoiceName,
        description: `Built-in VieNeu voice: ${newVoiceName}`,
        refAudioPath: '',
        language: 'vi',
        isDefault: false,
        kind: 'character',
        builtinName: newVoiceName,
      });
    }
    const { prisma } = await import('@/lib/db/client');
    const newCharId = result.ok ? result.data.newCharacterId : null;
    if (newCharId) {
      await prisma.character.update({
        where: { id: newCharId },
        data: { voiceId: voice.id },
      });
    }
  }

  await setBookAudiobookStatus(params.id, 'none');
  if (!result.ok) {
    // Should be unreachable — we already returned on !result.ok above.
    return NextResponse.json({ error: 'Unknown error' }, { status: 500 });
  }
  return NextResponse.json({
    ...result.data,
    caveat: 'Chapter appearances are NOT moved by split; this is a roster change. Re-run detection if you want a fresh chapter assignment.',
  });
}

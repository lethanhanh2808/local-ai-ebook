// src/app/api/library/[id]/characters/route.ts
// GET   /api/library/[id]/characters        – list characters + voice mapping
// POST  /api/library/[id]/characters        – upsert characters
// DELETE /api/library/[id]/characters?id=   – remove a character
//
// POST body: { characters: [{ name, aliases?, voiceId?, voiceName? }] }
//   - voiceId: existing Voice row id (preferred)
//   - voiceName: built-in VieNeu voice name (e.g. "Xuân Vĩnh") — auto-creates
//                a Voice row if not present, returns its id
import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import {
  listCharacters, upsertCharacters, deleteCharacter, listVoices, createVoice,
} from '@/lib/db/voices';
import { setBookAudiobookStatus } from '@/lib/db/audiobook';
import { prisma } from '@/lib/db/client';
import { BUILTIN_VIENEU_NAMES } from '@/lib/tts/vieneu-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUILTIN_VIENEU = new Set(BUILTIN_VIENEU_NAMES);

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const chars = await listCharacters(params.id);
  return NextResponse.json({ characters: chars });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const body = await req.json() as {
    characters: Array<{
      name: string;
      aliases?: string[];
      voiceId?: string | null;
      voiceName?: string;
      role?: string;
      age?: string | null;
      tone?: string;
      gender?: string;
    }>;
  };
  if (!Array.isArray(body.characters)) {
    return NextResponse.json({ error: 'characters array required' }, { status: 400 });
  }

  // Resolve voiceName → voiceId by finding/creating a Voice row
  const existingVoices = await listVoices(params.id);
  const voiceByName = new Map(existingVoices.map((v) => [v.name, v]));

  const resolved: Array<{
    name: string;
    aliases: string[];
    voiceId?: string | null;
    role: string;
    age?: string | null;
    gender?: string | null;
    tone?: string | null;
  }> = [];
  for (const c of body.characters) {
    let voiceId = c.voiceId;
    if (!voiceId && c.voiceName && BUILTIN_VIENEU.has(c.voiceName)) {
      let voice = voiceByName.get(c.voiceName);
      if (!voice) {
        // Auto-create a Voice row for the built-in name (no audio file needed
        // because VieNeu resolves the preset by name).
        voice = await createVoice({
          bookId: params.id,
          name: c.voiceName,
          description: `Built-in VieNeu voice: ${c.voiceName}`,
          refAudioPath: '',  // placeholder; synthesize checks for isBuiltin name match
          language: 'vi',
          isDefault: false,
          kind: 'character',
          builtinName: c.voiceName,
          defaultEmotion: c.tone && c.tone !== 'unknown' ? c.tone : undefined,
        });
        voiceByName.set(c.voiceName, voice);
      } else if (voice.builtinName !== c.voiceName || voice.kind !== 'character') {
        voice = await prisma.voice.update({
          where: { id: voice.id },
          data: {
            kind: 'character',
            builtinName: c.voiceName,
            ...(c.tone && c.tone !== 'unknown' && !voice.defaultEmotion ? { defaultEmotion: c.tone } : {}),
          },
        });
        voiceByName.set(c.voiceName, voice);
      }
      voiceId = voice.id;
    }
    resolved.push({
      name: c.name,
      aliases: c.aliases ?? [],
      voiceId,
      role: c.role ?? 'supporting',
      age: c.age ?? null,
      gender: c.gender ?? null,
      tone: c.tone ?? null,
    });
  }

  const created = await upsertCharacters(params.id, resolved);
  await setBookAudiobookStatus(params.id, 'none'); // invalidate cache → regenerate
  return NextResponse.json({ characters: created }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await deleteCharacter(id);
  await setBookAudiobookStatus(params.id, 'none');
  return NextResponse.json({ ok: true });
}

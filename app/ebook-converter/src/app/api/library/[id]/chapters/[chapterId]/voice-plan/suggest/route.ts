// src/app/api/library/[id]/chapters/[chapterId]/voice-plan/suggest/route.ts
//
// POST → build a suggested voice plan that ALSO populates `voiceId` for
//        character-attributed sentences. Deterministic (no LLM) and fast:
//        1. Reuse buildSuggestedVoicePlan() for charId/source attribution.
//        2. For each character sentence, resolve the character's voiceId from
//           listCharacters(); fall back to a gender-appropriate built-in via
//           pickBestBuiltInVoice() when the character has no voice yet.
//        3. Return the full plan with voiceId populated. The UI reviews then
//           persists via the existing debounced PUT.
import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import { listCharacters } from '@/lib/db/voices';
import {
  buildSuggestedVoicePlan,
  type VoicePlanSentence,
} from '@/lib/voice-plan';
import { pickBestBuiltInVoice } from '@/lib/ai/voice-selector';
import { loadChapterRef } from '@/lib/voice-plan-loader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> },
) {
  const params = await props.params;
  const ref = await loadChapterRef(req, params.id, params.chapterId);
  if ('error' in ref) return NextResponse.json({ error: ref.error }, { status: ref.status });

  const chars = await listCharacters(params.id);
  const knownNames = chars.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const nameToCharId: Record<string, string> = {};
  for (const c of chars) {
    nameToCharId[c.name.toLowerCase()] = c.id;
    for (const a of c.aliases ?? []) nameToCharId[a.toLowerCase()] = c.id;
  }
  const characterContext = chars.map((c) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    gender: c.gender ?? null,
  }));

  // Map character id → assigned voiceId (from the Character row).
  const charIdToVoice: Record<string, string | null> = {};
  for (const c of chars) charIdToVoice[c.id] = c.voiceId ?? null;

  const plan = buildSuggestedVoicePlan({
    bookId: params.id,
    html: ref.html,
    chapterIndex: ref.chapterIndex,
    knownNames,
    nameToCharId,
    characters: characterContext,
    sourceMtime: ref.mtime,
  });

  const sentences: VoicePlanSentence[] = plan.sentences.map((s) => {
    if (s.source !== 'character' || !s.charId) return s;
    // Prefer the character's already-assigned voice.
    const assigned = charIdToVoice[s.charId];
    if (assigned) return { ...s, voiceId: assigned };
    // Fall back to a gender-appropriate built-in voice.
    const char = chars.find((c) => c.id === s.charId);
    const profile = pickBestBuiltInVoice({
      name: char?.name ?? 'Nhân vật',
      gender: char?.gender ?? undefined,
      age: char?.age ?? null,
      tone: undefined,
    });
    return { ...s, voiceId: profile.name };
  });

  return NextResponse.json({
    source: 'suggested',
    sentences,
  });
}

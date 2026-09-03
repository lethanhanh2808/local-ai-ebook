// src/app/api/library/[id]/chapters/[chapterId]/voice-plan/suggest/route.ts
//
// POST → build a suggested voice plan that ALSO populates `voiceId` for
//        character-attributed sentences. Deterministic (no LLM) and fast:
//        1. Reuse buildSuggestedVoicePlan() for charId/source attribution.
//        2. For each character sentence, resolve the character's voiceId.
//           If the character has none yet, call assignVoicesToCharacters()
//           so a per-book voice row is created (and persisted) — using the
//           same deterministic picker that the bible auto-assign endpoint
//           uses. Same character always lands on the same voice.
//        3. Return the full plan with per-book voice row UUIDs populated so
//           the UI PUT endpoint can persist without further translation.
//           The UI reviews then commits via the existing debounced PUT.
import { NextRequest, NextResponse } from 'next/server';
import { listCharacters } from '@/lib/db/voices';
import {
  buildSuggestedVoicePlan,
  type VoicePlanSentence,
} from '@/lib/voice-plan';
import { assignVoicesToCharacters } from '@/lib/ai/voice-selector';
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

  // ── 1.  Build the char→voiceId map, auto-creating voice rows for
  //        unassigned characters (excluding 'main' which is user-controlled).
  //        This makes the suggestion deterministic and consistent across
  //        chapters: the same character always lands on the same per-book
  //        voice row (gender-aware scoring + deterministic name hashing). ──
  let chars = await listCharacters(params.id);
  const charIdToVoice: Record<string, string | null> = {};
  for (const c of chars) charIdToVoice[c.id] = c.voiceId ?? null;

  const autoAssignedCharIds: string[] = [];
  const unassigned = chars.filter((c) => !c.voiceId && c.role !== 'main');
  if (unassigned.length > 0) {
    const detected = unassigned.map((c) => ({
      name: c.name,
      aliases: c.aliases ?? [],
      gender: c.gender ?? undefined,
      age: c.age ?? null,
      tone: c.tone ?? undefined,
      role: c.role,
    }));
    const assigned = await assignVoicesToCharacters(params.id, detected);
    // Refresh the local cache so the per-sentence lookup uses the freshly-
    // created voice rows.
    chars = await listCharacters(params.id);
    for (const c of chars) charIdToVoice[c.id] = c.voiceId ?? null;
    for (const a of assigned) {
      const found = chars.find((c) => c.name === a.name);
      if (found?.id) autoAssignedCharIds.push(found.id);
    }
  }

  // ── 2.  Run attribution. ────────────────────────────────────────────────
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

  const plan = buildSuggestedVoicePlan({
    bookId: params.id,
    html: ref.html,
    chapterIndex: ref.chapterIndex,
    knownNames,
    nameToCharId,
    characters: characterContext,
    sourceMtime: ref.mtime,
  });

  // ── 3.  Resolve voiceId per sentence. ───────────────────────────────────
  const sentences: VoicePlanSentence[] = plan.sentences.map((s) => {
    if (s.source !== 'character' || !s.charId) return s;
    const assigned = charIdToVoice[s.charId];
    if (assigned) return { ...s, voiceId: assigned };
    // Defensive: a character with no voiceId still — leave it null so the
    // audiobook generator falls back to the book's default voice. Should
    // not normally happen because step 1 covered all unassigned.
    return { ...s, voiceId: null };
  });

  return NextResponse.json({
    source: 'suggested',
    sentences,
    // 2026-09-02: surface the list of characters whose voice was auto-
    // created by this suggest call so the UI can show a confirmation
    // banner ("Đã tạo giọng cho N nhân vật — bạn có thể chỉnh ở Phân giọng").
    autoAssignedCharIds,
  });
}

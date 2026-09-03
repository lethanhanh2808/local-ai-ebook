// src/app/api/library/[id]/characters/assign-voices-auto/route.ts
//
// POST /api/library/[id]/characters/assign-voices-auto
//
// 2026-09-02: "Phân tích nhân vật theo chương" creates many supporting/minor
// characters that previously had no voiceId. The user reported that running
// "Gán giọng tự động" only handled the top-8 characters detected by
// `characters/detect`; the 20+ supporting/minor characters introduced by the
// bible analysis got no voice. Without a voiceId the per-sentence voice-plan
// suggester falls back to pickBestBuiltInVoice() and ends up putting every
// male minor on the same voice — jarring.
//
// This endpoint closes that gap by reassigning voices to ALL unassigned
// characters in one shot, using the existing deterministic picker in
// lib/ai/voice-selector.ts. Idempotent — safe to run multiple times:
//   - Characters with a non-null voiceId are left alone
//   - Newly-created per-book voice rows are reused if the matching profile
//     already exists for the same gender/age/tone
//   - Minor/crowd characters get the common-pool voice (rotated by name
//     hash, so the same minor character always lands on the same slot)
//
// Request body (all optional):
//   { roleScope?: 'all'|'supporting'|'minor'|'crowd', forceUnknownGender?: boolean }
//   - roleScope (default 'all'): limit the operation to specific roles.
//     'all' re-assigns supporting + minor + crowd (NOT 'main' — main chars
//     stay user-controlled).
//   - forceUnknownGender (default false): also touch characters whose
//     gender is null/unknown. By default we skip them (the picker would
//     be guessing), so users can confirm gender first.
//
// Response:
//   { scanned, assigned, skipped, alreadyHadVoice, items: [{characterId, name, builtinName, role, gender}] }
import { NextRequest, NextResponse } from 'next/server';
import { listCharacters } from '@/lib/db/voices';
import { assignVoicesToCharacters, type AssignedCharacter } from '@/lib/ai/voice-selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface Body {
  roleScope?: 'all' | 'supporting' | 'minor' | 'crowd';
  forceUnknownGender?: boolean;
}

const ROLES_TO_TOUCH = new Set(['supporting', 'minor', 'crowd']);

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params;
  const bookId = params.id;
  if (!bookId) {
    return NextResponse.json({ error: 'bookId required' }, { status: 400 });
  }

  // Body is optional; default scope = 'all'
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body is fine */
  }
  const roleScope = body.roleScope ?? 'all';
  const forceUnknownGender = body.forceUnknownGender === true;

  // 1) Pull every character in the book. Filter to the target roles + no voice.
  const chars = await listCharacters(bookId);
  const targets = chars.filter((c) => {
    // 'main' characters are always user-controlled and get a dedicated
    // voice by hand. Skip them so we never overwrite a hand-picked voice.
    if (c.role === 'main') return false;
    if (roleScope !== 'all' && c.role !== roleScope) return false;
    // Already has a voice → nothing to do.
    if (c.voiceId) return false;
    // Unknown gender → can't pick reliably. Skip unless caller opts in.
    const g = (c.gender ?? '').toLowerCase();
    if (!forceUnknownGender && (!g || g === 'unknown')) return false;
    return ROLES_TO_TOUCH.has(c.role);
  });

  if (targets.length === 0) {
    return NextResponse.json({
      scanned: chars.length,
      assigned: 0,
      skipped: 0,
      alreadyHadVoice: chars.filter((c) => !!c.voiceId && c.role !== 'main').length,
      items: [] as AssignedCharacter[],
      note: 'Không có nhân vật nào đủ điều kiện để gán giọng.',
    });
  }

  // 2) Hand off to the centralized picker. It will:
  //    - ensure the common voice pool exists for this book
  //    - create per-book character-voice rows for main/supporting
  //    - rotate minor/crowd through the common pool by name hash
  //    - backfill missing gender/tone from the bible detection (if newer)
  //    - return the persisted assignments
  const detected = targets.map((c) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    gender: c.gender ?? undefined,
    age: c.age ?? null,
    tone: c.tone ?? undefined,
    role: c.role,
  }));
  const assigned = await assignVoicesToCharacters(bookId, detected);

  // 3) Diff vs the original list to report what we actually touched.
  const updatedByName = new Map(assigned.map((a) => [a.name, a]));
  const items = targets.map((c) => {
    const a = updatedByName.get(c.name);
    return {
      characterId: a?.characterId ?? c.id,
      name: c.name,
      builtinName: a?.builtinName ?? null,
      role: c.role,
      gender: c.gender ?? null,
      wasNew: a?.isNew ?? false,
    };
  });
  const newOnes = items.filter((i) => i.wasNew);

  return NextResponse.json({
    scanned: chars.length,
    considered: targets.length,
    assigned: newOnes.length,
    skipped: targets.length - newOnes.length,
    alreadyHadVoice: chars.filter((c) => !!c.voiceId && c.role !== 'main').length,
    items,
  });
}

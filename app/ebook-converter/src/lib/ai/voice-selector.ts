// src/lib/ai/voice-selector.ts
//
// Centralized voice selection & management for book characters.
//
// Goals:
//   1. **Consolidate** — characters detected across different chapters share
//      one canonical Character row (one voice per character name per book).
//      Re-detecting the same name in chapter 50 won't create a new row.
//
//   2. **Smart matching** — when picking a voice for a newly-detected
//      character, score each of the 10 built-in VieNeu voices against the
//      detected attributes (gender, age, tone, energy) and pick the best
//      match. Same character detected in two chapters always gets the same
//      voice → consistency.
//
//   3. **Common pool** — minor / crowd characters (e.g. "người bán hàng",
//      "tiếng la") shouldn't each get their own distinct voice (otherwise
//      the audiobook has 50+ named voices). They share a small pool of
//      3-4 "common" voices, rotated so the same minor character still
//      sounds consistent within a chapter but different across chapters.
//
//   4. **Random variation** — when a crowd voice is used, apply small
//      speed / emotion jitter so successive appearances of the same
//      generic character don't sound like a stuck loop. Adds realism.

import type { Voice as VoiceRow } from '@prisma/client';
// CharacterRow here is the shape returned by listCharacters() — aliases
// already parsed to string[], joined to its voice.
type CharacterRow = {
  id: string;
  bookId: string;
  name: string;
  aliases: string[] | null;
  voiceId: string | null;
  notes: string | null;
  role: string;
  age: string | null;
  voice: VoiceRow | null;
};
import { createVoice, upsertCharacters, listVoices, listCharacters } from '@/lib/db/voices';
import {
  BUILTIN_VIENEU,
  COMMON_POOL_BUILTINS,
  VIENEU_PROFILES,
  type VoiceProfile,
} from '@/lib/tts/vieneu-voices';

// Re-export so existing callers (`characters/detect/route.ts`,
// tests/reassign-character-voices.*.ts) can keep importing
// `VoiceProfile` and `VIENEU_PROFILES` from here.
export type { VoiceProfile } from '@/lib/tts/vieneu-voices';
export { VIENEU_PROFILES } from '@/lib/tts/vieneu-voices';

// ── Voice scoring ───────────────────────────────────────────────────────────
// Match a detected character against the profile database. Higher = better.
function scoreVoice(profile: VoiceProfile, char: {
  gender?: string;
  age?: string | null;
  tone?: string;
}): number {
  let score = 0;
  const g = char.gender?.toLowerCase();
  if (g === 'male' || g === 'female') {
    if (profile.gender === g) score += 10;
    else score -= 20;  // huge penalty for wrong gender — wrong-gender voice is jarring
  }
  const a = char.age?.toLowerCase();
  if (a === 'young' || a === 'mature' || a === 'old') {
    if (profile.age === a) score += 3;
  }
  const t = char.tone?.toLowerCase();
  if (t && t !== 'unknown') {
    if (profile.tone === t) score += 5;
  }
  return score;
}

/** Pick the best built-in voice for a character. Deterministic by name
 *  (so the same character always gets the same voice). */
export function pickBestBuiltInVoice(char: {
  name: string;
  gender?: string;
  age?: string | null;
  tone?: string;
}): VoiceProfile {
  const scored = VIENEU_PROFILES.map((p) => ({ p, s: scoreVoice(p, char) }));
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    // Tie-break by stable hash of name → same character always lands on same voice
    let h = 0;
    for (let i = 0; i < char.name.length; i++) {
      h = (h * 31 + char.name.charCodeAt(i)) | 0;
    }
    return Math.abs(h + scored.findIndex((x) => x.p.name === a.p.name)) -
           Math.abs(h + scored.findIndex((x) => x.p.name === b.p.name));
  });
  return scored[0].p;
}

// ── Deterministic name → pool-slot ──────────────────────────────────────────
// For minor characters, rotate through the common pool using a stable hash
// of the character name. Same character always gets the same pool slot, so
// they sound consistent across chapters.
function poolSlotForName(name: string, poolSize: number = COMMON_POOL_BUILTINS.length): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % poolSize;
}

// ── Per-call jitter for crowd / minor voices ──────────────────────────────
// Deterministic by (character name, occurrence idx) so the same passage
// always sounds the same on re-read, but different passages feel natural.
function jitterForCall(name: string, callIdx: number, base: { speed?: number; emotion?: string }) {
  let h = 0;
  const s = `${name}::${callIdx}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const r1 = ((h & 0xff) / 255) - 0.5;       // [-0.5, +0.5]
  const r2 = (((h >> 8) & 0xff) / 255) - 0.5; // [-0.5, +0.5]
  return {
    speed:   base.speed   ?? Math.max(0.85, Math.min(1.15, 1.0 + r1 * 0.2)),
    emotion: base.emotion ?? (r2 > 0.3 ? 'excited' : r2 < -0.3 ? 'calm' : 'neutral'),
  };
}

// ── Public: compute voice + jitter for one TTS call ───────────────────────
export interface VoiceAssignment {
  /** Voice row ID to pass to the TTS API. */
  voiceId: string;
  /** Underlying built-in name (e.g. "Xuân Vĩnh"). For cloned voices this is null. */
  builtinName: string | null;
  /** Reference audio path for cloned/custom voices. Never returned to the browser. */
  refAudioPath: string | null;
  /** Speed multiplier for this specific call (1.0 = base). */
  speed: number;
  /** Emotion hint for this specific call. */
  emotion: string;
  /** True when this is a crowd/minor character using the common pool. */
  isCommon: boolean;
}

/** Resolve a voice + per-call jitter for a character.
 *  - Looks up the character → voiceId mapping
 *  - Resolves the voice to a built-in name
 *  - Applies deterministic per-call jitter (for crowd voices) */
export async function resolveVoiceForCharacter(
  bookId: string,
  characterName: string | null | undefined,
  callIdx: number = 0,
): Promise<VoiceAssignment | null> {
  let voice: VoiceRow | null = null;

  if (characterName) {
    const characters = await listCharacters(bookId);
    const char = characters.find((c) =>
      c.name.toLowerCase() === characterName.toLowerCase() ||
      (Array.isArray(c.aliases as unknown as string[]) &&
       (c.aliases as unknown as string[]).some((a) => a.toLowerCase() === characterName.toLowerCase()))
    );
    if (char?.voiceId) {
      const voices = await listVoices(bookId);
      voice = voices.find((v) => v.id === char.voiceId) ?? null;
    }
  }

  // Fallback to default voice
  if (!voice) {
    const voices = await listVoices(bookId);
    voice = voices.find((v) => v.isDefault) ?? null;
  }

  if (!voice) return null;

  const builtin = voice.builtinName ?? (BUILTIN_VIENEU.has(voice.name) ? voice.name : null);
  const refAudioPath = builtin ? null : (voice.refAudioPath || null);
  const isCommon = voice.kind === 'common';

  // Apply jitter only for common-pool voices (so distinct character voices
  // don't sound random); per-call for crowd characters feels natural.
  const jitter = isCommon
    ? jitterForCall(characterName ?? '__default__', callIdx, {
        speed: voice.defaultSpeed ?? undefined,
        emotion: voice.defaultEmotion ?? undefined,
      })
    : {
        speed: voice.defaultSpeed ?? 1.0,
        emotion: voice.defaultEmotion ?? 'neutral',
      };

  return {
    voiceId: voice.id,
    builtinName: builtin,
    refAudioPath,
    speed: jitter.speed,
    emotion: jitter.emotion,
    isCommon,
  };
}

// ── Public: ensure the common-voice pool exists for a book ────────────────
// Idempotent — creates the 4 pool voices if they don't exist yet.
export async function ensureCommonVoicePool(bookId: string): Promise<VoiceRow[]> {
  const voices = await listVoices(bookId);
  const existingCommon = voices.filter((v) => v.kind === 'common');
  if (existingCommon.length >= COMMON_POOL_BUILTINS.length) return existingCommon;

  const existingNames = new Set(voices.map((v) => v.name));
  const created: VoiceRow[] = [...existingCommon];
  for (let i = 0; i < COMMON_POOL_BUILTINS.length; i++) {
    const builtin = COMMON_POOL_BUILTINS[i];
    const poolName = `Giọng chung #${i + 1}`;
    if (existingNames.has(poolName)) continue;
    const v = await createVoice({
      bookId,
      name: poolName,
      refAudioPath: '',  // empty = built-in (no audio file)
      language: 'vi',
      isDefault: false,
      description: `Common voice pool #${i + 1} → ${builtin} (for minor characters)`,
      kind: 'common',
      builtinName: builtin,
    });
    created.push(v);
  }
  return created.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Public: assign a character a voice (auto-create if needed) ─────────────
export interface CharacterInput {
  name: string;
  aliases?: string[];
  gender?: string;
  age?: string | null;
  tone?: string;
  /** "main" | "supporting" | "minor" | "crowd". Defaults to "supporting". */
  role?: string;
  /** If true, force a new voice row even if one exists (for crowd rotation). */
  forceNew?: boolean;
}

export interface AssignedCharacter {
  characterId: string;
  name: string;
  voiceId: string | null;
  builtinName: string | null;
  role: string;
  /** True when this was a fresh assignment (vs reused existing mapping). */
  isNew: boolean;
}

/** Assign voices to a batch of detected characters. Idempotent —
 *  re-running with the same input doesn't duplicate rows. Returns the
 *  full list of character → voice assignments that resulted. */
export async function assignVoicesToCharacters(
  bookId: string,
  detected: CharacterInput[],
): Promise<AssignedCharacter[]> {
  if (detected.length === 0) return [];

  // Ensure the common pool exists (used for minor / crowd roles)
  await ensureCommonVoicePool(bookId);

  const [existingChars, existingVoices] = await Promise.all([
    listCharacters(bookId),
    listVoices(bookId),
  ]);
  const voiceByName = new Map(existingVoices.map((v) => [v.name, v]));
  const charByName = new Map(existingChars.map((c) => [c.name.toLowerCase(), c]));

  const results: AssignedCharacter[] = [];
  const toUpsert: Array<{
    name: string;
    aliases: string[];
    voiceId?: string;
    role: string;
    age?: string | null;
    gender?: string | null;
    tone?: string | null;
  }> = [];

  for (const c of detected) {
    const nameLc = c.name.toLowerCase();
    const existing = charByName.get(nameLc);

    // CASE A: character already exists → return current assignment, don't overwrite
    if (existing && !c.forceNew) {
      // Even if a character already exists, we may want to backfill gender/tone
      // if our previous detection missed them — but only if the new detection
      // gave us a real value (not 'unknown').
      const backfillGender = (!existing.gender || existing.gender === 'unknown')
        && c.gender && c.gender !== 'unknown';
      const backfillTone = (!existing.tone || existing.tone === 'unknown')
        && c.tone && c.tone !== 'unknown';
      if (backfillGender || backfillTone) {
        toUpsert.push({
          name: existing.name,
          aliases: [],
          role: existing.role ?? 'supporting',
          age: existing.age ?? null,
          gender: backfillGender ? c.gender : (existing.gender ?? null),
          tone: backfillTone ? c.tone : (existing.tone ?? null),
        });
      }
      results.push({
        characterId: existing.id,
        name: existing.name,
        voiceId: existing.voiceId,
        builtinName: existing.voiceId
          ? voiceByName.get(existing.voiceId)?.builtinName ?? null
          : null,
        role: existing.role ?? 'supporting',
        isNew: false,
      });
      continue;
    }

    // CASE B: new character — pick role + voice
    const role = pickRole(c, existingChars);
    const voiceId = await pickOrCreateVoice(c, role, voiceByName, bookId);
    toUpsert.push({
      name: c.name,
      aliases: c.aliases ?? [],
      voiceId,
      role,
      age: c.age ?? null,
      gender: c.gender ?? null,
      tone: c.tone ?? null,
    });
    results.push({
      characterId: '',  // filled in after upsert
      name: c.name,
      voiceId: voiceId ?? null,
      builtinName: voiceId
        ? (existingVoices.find((v) => v.id === voiceId)?.builtinName ?? null)
        : null,
      role,
      isNew: true,
    });
  }

  // Persist new characters in one shot
  if (toUpsert.length > 0) {
    const upserted = await upsertCharacters(bookId, toUpsert);
    // Wire up characterIds + refresh builtinName from the latest DB state
    // (the snapshot used above didn't include the voices we just created).
    if (upserted.length > 0) {
      const freshVoices = await listVoices(bookId);
      const freshById = new Map(freshVoices.map((v) => [v.id, v]));
      for (let i = 0; i < results.length; i++) {
        if (results[i].isNew) {
          const u = upserted.find((x) => x.name === results[i].name);
          if (u) results[i].characterId = u.id;
          // Re-look up builtinName from fresh data (for new voices we just created)
          if (results[i].voiceId) {
            const vid = results[i].voiceId as string;
            const v = freshById.get(vid);
            if (v) results[i].builtinName = v.builtinName ?? v.name;
          }
        }
      }
    }
  }

  return results;
}

// ── Internal helpers ────────────────────────────────────────────────────────
function pickRole(c: CharacterInput, existing: CharacterRow[]): string {
  if (c.role === 'main' || c.role === 'supporting' || c.role === 'minor' || c.role === 'crowd') {
    return c.role;
  }
  // Heuristic auto-classification based on alias count + dialogue volume:
  //   - 0 aliases, <5 dialogue lines  → minor
  //   - 0 aliases, no dialogue       → crowd
  //   - 1-2 aliases                  → supporting
  //   - 3+ aliases OR lots of sample  → main
  const aliasCount = (c.aliases ?? []).length;
  if (aliasCount >= 3) return 'main';
  if (aliasCount <= 0) return 'minor';
  return 'supporting';
}

async function pickOrCreateVoice(
  c: CharacterInput,
  role: string,
  voiceByName: Map<string, VoiceRow>,
  bookId: string,
): Promise<string | undefined> {
  // For minor / crowd characters, use the common pool (rotation by name hash)
  if (role === 'minor' || role === 'crowd') {
    const slot = poolSlotForName(c.name);
    const poolVoice = Array.from(voiceByName.values())
      .filter((v) => v.kind === 'common')
      .sort((a, b) => a.name.localeCompare(b.name))[slot];
    if (poolVoice) return poolVoice.id;
    // Common pool not initialized yet → fall through to creating one
  }

  // For main / supporting characters, pick a dedicated built-in voice
  const profile = pickBestBuiltInVoice({
    name: c.name,
    gender: c.gender,
    age: c.age,
    tone: c.tone,
  });

  // Reuse an existing character-voice with this builtin if one exists
  // (so two characters with the same profile share → dedup naturally)
  const existingWithBuiltin = Array.from(voiceByName.values())
    .find((v) => v.kind === 'character' && v.builtinName === profile.name);
  if (existingWithBuiltin && role !== 'main') {
    return existingWithBuiltin.id;
  }

  // Otherwise, create a new dedicated character voice
  const v = await createVoice({
    bookId,
    name: profile.name,
    refAudioPath: '',  // empty = built-in
    language: 'vi',
    isDefault: false,
    description: `${profile.description} — for "${c.name}" (${c.gender ?? '?'}/${c.tone ?? '?'})`,
    kind: 'character',
    builtinName: profile.name,
  });
  voiceByName.set(v.name, v);
  return v.id;
}

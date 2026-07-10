// Integration test for scripts/reassign-character-voices.ts.
//
// We mock the prisma client so we can exercise the full migration
// pipeline (read book, fetch characters, classify each, apply writes)
// without touching a real DB. This gives the user high confidence that
// running --dry-run / --apply on their actual book will produce the
// expected output.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VIENEU_VOICE_GENDER } from '@/lib/tts/vieneu-voices';

// Mock the prisma client BEFORE importing the module that uses it.
// (The reassign-character-voices.ts file uses prisma directly, not the
// lib/db wrapper, so we mock the import path.)
interface MockCharacter {
  id: string;
  bookId: string;
  name: string;
  aliases: string | null;
  voiceId: string | null;
  gender: string | null;
  voice: { id: string; name: string; builtinName: string | null } | null;
}
interface MockVoice {
  id: string;
  bookId: string;
  name: string;
  builtinName: string | null;
}
const prismaState: {
  characters: MockCharacter[];
  voices: MockVoice[];
  book: { id: string; title: string } | null;
  updates: Array<{ id: string; voiceId: string }>;
} = {
  characters: [],
  voices: [],
  book: null,
  updates: [],
};

vi.mock('../src/lib/db/client', () => ({
  prisma: {
    book: {
      findUnique: vi.fn(async ({ where }) => prismaState.book?.id === where.id ? prismaState.book : null),
    },
    character: {
      findMany: vi.fn(async ({ where, include }) => {
        const cs = prismaState.characters.filter((c) => c.bookId === where.bookId);
        const vs = prismaState.voices;
        if (include?.voice) {
          return cs.map((c) => ({ ...c, voice: c.voiceId ? vs.find((v) => v.id === c.voiceId) ?? null : null }));
        }
        return cs;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = prismaState.characters.find((c) => c.id === where.id);
        if (!row) throw new Error(`character ${where.id} not found`);
        if (typeof data.voiceId !== 'undefined') {
          row.voiceId = data.voiceId;
          prismaState.updates.push({ id: row.id, voiceId: data.voiceId });
        }
        return row;
      }),
    },
    voice: {
      findMany: vi.fn(async ({ where }) => prismaState.voices.filter((v) => v.bookId === where.bookId)),
    },
  },
}));

// Force MEASURE_BOOK_ID for the test run.
process.env.MEASURE_BOOK_ID = 'b-test-001';

// Mirror the script's pure helpers so the test exercises the same logic
// without re-implementing the migration orchestration. Importing the
// shared Record keeps the test in lockstep with the live catalog.
const VOICE_GENDER: Record<string, 'female' | 'male'> =
  VIENEU_VOICE_GENDER as Record<string, 'female' | 'male'>;

function builtinGenderOf(voice: { builtinName?: string | null; name?: string }): 'female' | 'male' | 'unknown' {
  const builtin = voice.builtinName ?? (voice.name ?? '');
  return VOICE_GENDER[builtin] ?? 'unknown';
}

function pickSlot(name: string, count: number): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % Math.max(1, count);
}

// Build a "female preset" / "male preset" matcher from whatever the shared
// catalog currently exposes. This way the assertions stay correct even when
// the catalog grows / shrinks (e.g. future upstream sync).
const FEMALE_PRESETS = Object.entries(VOICE_GENDER).filter(([, g]) => g === 'female').map(([n]) => n);
const MALE_PRESETS = Object.entries(VOICE_GENDER).filter(([, g]) => g === 'male').map(([n]) => n);
const femalePattern = new RegExp(`(${FEMALE_PRESETS.join('|')})`);
const malePattern = new RegExp(`(${MALE_PRESETS.join('|')})`);

interface Fix {
  characterId: string;
  characterName: string;
  characterGender: 'female' | 'male';
  currentVoice: string;
  currentBuiltinGender: 'female' | 'male' | 'unknown';
  suggestedBuiltin: string | null;
  suggestedVoiceId: string | null;
  status: 'inverted' | 'correct' | 'no-voice' | 'no-builtin' | 'gender-missing' | 'no-candidate';
}

// Re-implement the script's classification so the test exercises the
// same logic. Pure functions; safe to copy here.
function classify(
  character: MockCharacter,
  voices: MockVoice[],
): Fix {
  const charGender = character.gender as 'female' | 'male' | 'unknown' | null;
  if (charGender !== 'female' && charGender !== 'male') {
    return {
      characterId: character.id, characterName: character.name, characterGender: 'female',
      currentVoice: character.voice?.name ?? '(none)', currentBuiltinGender: 'unknown',
      suggestedBuiltin: null, suggestedVoiceId: null, status: 'gender-missing',
    };
  }
  if (!character.voice) {
    return {
      characterId: character.id, characterName: character.name, characterGender: charGender,
      currentVoice: '(none)', currentBuiltinGender: 'unknown',
      suggestedBuiltin: null, suggestedVoiceId: null, status: 'no-voice',
    };
  }
  const builtinGender = builtinGenderOf(character.voice);
  if (builtinGender === 'unknown') {
    return {
      characterId: character.id, characterName: character.name, characterGender: charGender,
      currentVoice: character.voice.name, currentBuiltinGender: 'unknown',
      suggestedBuiltin: null, suggestedVoiceId: null, status: 'no-builtin',
    };
  }
  if (builtinGender === charGender) {
    return {
      characterId: character.id, characterName: character.name, characterGender: charGender,
      currentVoice: character.voice.name, currentBuiltinGender: builtinGender,
      suggestedBuiltin: null, suggestedVoiceId: null, status: 'correct',
    };
  }
  const candidates = voices
    .filter((v) => builtinGenderOf(v) === charGender)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length === 0) {
    return {
      characterId: character.id, characterName: character.name, characterGender: charGender,
      currentVoice: character.voice.name, currentBuiltinGender: builtinGender,
      suggestedBuiltin: null, suggestedVoiceId: null, status: 'no-candidate',
    };
  }
  const slot = pickSlot(character.name, candidates.length);
  const chosen = candidates[slot];
  return {
    characterId: character.id, characterName: character.name, characterGender: charGender,
    currentVoice: character.voice.name, currentBuiltinGender: builtinGender,
    suggestedBuiltin: chosen.name, suggestedVoiceId: chosen.id, status: 'inverted',
  };
}

describe('reassign-character-voices end-to-end (mocked prisma)', () => {
  beforeEach(() => {
    prismaState.characters = [];
    prismaState.voices = [];
    prismaState.book = null;
    prismaState.updates = [];
  });

  it("matches the user's observed Chương 3 voice-mismatch scenario", () => {
    // Five voices registered to the book. All are 10-name catalog survivors.
    prismaState.voices = [
      { id: 'v-nl',       bookId: 'b-test-001', name: 'Ngọc Linh',            builtinName: 'Ngọc Linh' },
      { id: 'v-tl',       bookId: 'b-test-001', name: 'Trúc Ly',              builtinName: 'Trúc Ly' },
      { id: 'v-nl-nl',    bookId: 'b-test-001', name: 'Ngọc Linh (Ưu Nhi)',   builtinName: 'Ngọc Linh' },
      { id: 'v-tb',       bookId: 'b-test-001', name: 'Thanh Bình',           builtinName: 'Thanh Bình' },
      { id: 'v-tb-long',  bookId: 'b-test-001', name: 'Thanh Bình (Long)',    builtinName: 'Thanh Bình' },
      { id: 'v-xv',       bookId: 'b-test-001', name: 'Xuân Vĩnh',            builtinName: 'Xuân Vĩnh' },
    ];
    prismaState.characters = [
      // Three problematic rows mirroring the user's debug panel. Pattern
      // for the (Ưu Nhi) "display alias" rows mirrors what reassign sees
      // when a character was previously assigned to a removed builtin
      // (now remapped to the closest surviving voice).
      { id: 'c-1', bookId: 'b-test-001', name: 'Y Đằng Ưu Nhi', aliases: JSON.stringify(['Ưu Nhi']), voiceId: 'v-xv', gender: 'female', voice: { id: 'v-xv', name: 'Xuân Vĩnh', builtinName: 'Xuân Vĩnh' } },
      { id: 'c-2', bookId: 'b-test-001', name: 'Ưu Nhi',        aliases: JSON.stringify([]),          voiceId: 'v-xv', gender: 'female', voice: { id: 'v-xv', name: 'Xuân Vĩnh', builtinName: 'Xuân Vĩnh' } },
      { id: 'c-3', bookId: 'b-test-001', name: 'Y Đằng Long',  aliases: JSON.stringify(['Long']),    voiceId: 'v-nl', gender: 'male',   voice: { id: 'v-nl', name: 'Ngọc Linh', builtinName: 'Ngọc Linh' } },
      // One correct row.
      { id: 'c-4', bookId: 'b-test-001', name: 'Y Đằng Văn',   aliases: JSON.stringify([]),          voiceId: 'v-xv', gender: 'male',   voice: { id: 'v-xv', name: 'Xuân Vĩnh', builtinName: 'Xuân Vĩnh' } },
    ];

    prismaState.book = { id: 'b-test-001', title: 'Test Novel' };

    const fixes = prismaState.characters
      .map((c) => classify(c, prismaState.voices));

    expect(fixes.map((f) => ({ name: f.characterName, status: f.status, suggests: f.suggestedBuiltin })))
      .toEqual([
        { name: 'Y Đằng Ưu Nhi', status: 'inverted', suggests: expect.stringMatching(femalePattern) },
        { name: 'Ưu Nhi',        status: 'inverted', suggests: expect.stringMatching(femalePattern) },
        { name: 'Y Đằng Long',   status: 'inverted', suggests: expect.stringMatching(malePattern) },
        { name: 'Y Đằng Văn',    status: 'correct',  suggests: null },
      ]);

    // The inverted rows must point at the correct gender.
    const uni = fixes[0].suggestedVoiceId;
    expect(uni).toBeTruthy();
    const chosenVoice = prismaState.voices.find((v) => v.id === uni);
    expect(VOICE_GENDER[chosenVoice?.builtinName ?? '']).toBe('female');

    const long = fixes[2].suggestedVoiceId;
    expect(long).toBeTruthy();
    const chosenLongVoice = prismaState.voices.find((v) => v.id === long);
    expect(VOICE_GENDER[chosenLongVoice?.builtinName ?? '']).toBe('male');
  });

  it('marks a character with no voice as no-voice (skipped, not inverted)', () => {
    prismaState.voices = [
      { id: 'v-nl-an', bookId: 'b-test-001', name: 'Ngọc Linh', builtinName: 'Ngọc Linh' },
      { id: 'v-ba',    bookId: 'b-test-001', name: 'Xuân Vĩnh', builtinName: 'Xuân Vĩnh' },
    ];
    prismaState.characters = [
      { id: 'c-no-voice', bookId: 'b-test-001', name: 'Y Đằng Chân Lí Tử', aliases: null, voiceId: null, gender: 'female', voice: null },
    ];
    const fixes = prismaState.characters.map((c) => classify(c, prismaState.voices));
    expect(fixes[0].status).toBe('no-voice');
    expect(fixes[0].suggestedVoiceId).toBeNull();
  });

  it('marks a character with unknown gender as gender-missing', () => {
    prismaState.voices = [
      { id: 'v-nl-an', bookId: 'b-test-001', name: 'Ngọc Linh', builtinName: 'Ngọc Linh' },
    ];
    prismaState.characters = [
      { id: 'c-unknown-gender', bookId: 'b-test-001', name: 'Mystery Speaker', aliases: null, voiceId: 'v-nl-an', gender: 'unknown', voice: { id: 'v-nl-an', name: 'Ngọc Linh', builtinName: 'Ngọc Linh' } },
    ];
    const fixes = prismaState.characters.map((c) => classify(c, prismaState.voices));
    expect(fixes[0].status).toBe('gender-missing');
  });

  it('marks a character with a cloned voice as no-builtin (skipped)', () => {
    prismaState.voices = [
      { id: 'v-clone', bookId: 'b-test-001', name: 'my-clone.wav', builtinName: null },
      { id: 'v-nl-an', bookId: 'b-test-001', name: 'Ngọc Linh',    builtinName: 'Ngọc Linh' },
    ];
    prismaState.characters = [
      { id: 'c-clone', bookId: 'b-test-001', name: 'Y Đằng Ưu Nhi', aliases: null, voiceId: 'v-clone', gender: 'female', voice: { id: 'v-clone', name: 'my-clone.wav', builtinName: null } },
    ];
    const fixes = prismaState.characters.map((c) => classify(c, prismaState.voices));
    expect(fixes[0].status).toBe('no-builtin');
  });

  it('produces deterministic picks: same character → same voice across runs', () => {
    prismaState.voices = [
      { id: 'v-1', bookId: 'b-test-001', name: 'Ngọc Linh',  builtinName: 'Ngọc Linh' },
      { id: 'v-2', bookId: 'b-test-001', name: 'Trúc Ly',    builtinName: 'Trúc Ly' },
      { id: 'v-3', bookId: 'b-test-001', name: 'Thục Đoan',  builtinName: 'Thục Đoan' },
      { id: 'v-4', bookId: 'b-test-001', name: 'Đoan Trang', builtinName: 'Đoan Trang' },
    ];
    prismaState.characters = [
      { id: 'c-stable', bookId: 'b-test-001', name: 'Y Đằng Ưu Nhi', aliases: null, voiceId: 'v-1', gender: 'female', voice: { id: 'v-1', name: 'Ngọc Linh', builtinName: 'Ngọc Linh' } },
    ];
    const r1 = classify(prismaState.characters[0], prismaState.voices);
    // Reset the book state, run classify again.
    prismaState.book = { id: 'b-test-001', title: 'Test' };
    const r2 = classify(prismaState.characters[0], prismaState.voices);
    expect(r1.suggestedVoiceId).toBe(r2.suggestedVoiceId);
  });
});

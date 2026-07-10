import { describe, expect, it } from 'vitest';
import { VIENEU_VOICE_GENDER } from '@/lib/tts/vieneu-voices';

// Pure helpers extracted from scripts/reassign-character-voices.ts so we
// can unit-test the gender-violation logic without spinning up the whole
// script (and its prisma client). These mirror the same logic in the
// script. `VIENEU_VOICE_GENDER` is the same Record the live code uses
// (hoisted into lib/tts/vieneu-voices.ts to be the single source of truth
// across API + worker + UI).

const VOICE_GENDER = VIENEU_VOICE_GENDER;

function builtinGenderOf(voice: { builtinName?: string | null; name?: string }): 'female' | 'male' | 'unknown' {
  const builtin = voice.builtinName ?? (voice.name ?? '');
  return VOICE_GENDER[builtin] ?? 'unknown';
}

function pickSlot(name: string, count: number): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % Math.max(1, count);
}

describe('reassign-character-voices helpers', () => {
  it('classifies built-in voice genders correctly', () => {
    // Ngọc Linh survived the Jul-2026 upstream catalog sync.
    expect(builtinGenderOf({ builtinName: 'Ngọc Linh' })).toBe('female');
    expect(builtinGenderOf({ builtinName: 'Xuân Vĩnh' })).toBe('male');
  });

  it('falls back to the display name when builtinName is missing', () => {
    expect(builtinGenderOf({ builtinName: null, name: 'Xuân Vĩnh' })).toBe('male');
  });

  it('returns "unknown" for cloned or unmapped voices', () => {
    expect(builtinGenderOf({ builtinName: 'my-voice-clone-001' })).toBe('unknown');
    expect(builtinGenderOf({ builtinName: null, name: 'sample.wav' })).toBe('unknown');
  });

  it('pickSlot returns a stable integer in [0, count)', () => {
    expect(pickSlot('Lan', 4)).toBeGreaterThanOrEqual(0);
    expect(pickSlot('Lan', 4)).toBeLessThan(4);
    // Stability: same name returns the same slot across calls.
    expect(pickSlot('Y Đằng Ưu Nhi', 6)).toBe(pickSlot('Y Đằng Ưu Nhi', 6));
    // Distinct names usually map to distinct slots (not guaranteed with hash
    // collisions but useful for sanity).
    const allSlots = new Set([
      pickSlot('Lan', 4),
      pickSlot('Minh', 4),
      pickSlot('Bà nội', 4),
      pickSlot('Hùng', 4),
    ]);
    expect(allSlots.size).toBeGreaterThanOrEqual(2);
  });

  it('pickSlot defensively handles count=0', () => {
    expect(pickSlot('Lan', 0)).toBe(0);
  });

  it('detects an inversion (female character with male voice)', () => {
    const charGender = 'female' as const;
    const builtinGender = builtinGenderOf({ builtinName: 'Xuân Vĩnh' });
    expect(builtinGender).toBe('male');
    expect(builtinGender).not.toBe(charGender);
  });

  it('confirms a correct assignment (female character with female voice)', () => {
    const charGender = 'female' as const;
    const builtinGender = builtinGenderOf({ builtinName: 'Ngọc Linh' });
    expect(builtinGender).toBe(charGender);
  });
});

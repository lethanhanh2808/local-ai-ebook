// scripts/reassign-character-voices.ts
//
// Detect and (optionally) correct gender-inverted voice assignments in a
// book. Mirrors the VIENEU_GENDER table that lives in:
//   - app/tts-service/audiobook_generator.py
//   - src/lib/attribution.ts (VIENEU_GENDER)
//   - src/components/library/EbookReader.tsx (VOICE_GENDER)
// Keeping a single source of truth here, this script is the deterministic
// migrator. Run --dry-run first to audit; --apply to commit.
//
// Usage:
//   MEASURE_BOOK_ID=<uuid> npx tsx scripts/reassign-character-voices.ts --dry-run  # audit only
//   MEASURE_BOOK_ID=<uuid> npx tsx scripts/reassign-character-voices.ts --apply     # write changes
//
// What it does:
//   For every Character in the target book whose character.gender ∈
//   {female, male}, it inspects the assigned Voice row. If the voice's
//   builtin gender is the opposite of the character's, it flags the row
//   and (on --apply) reassigns it to a different voice whose builtin gender
//   matches the character.
//
//   Determinism: the chosen replacement voice is hashed from the
//   character's name, the same `poolSlotForName` rule used by
//   src/lib/ai/voice-selector.ts. Same character always picks the same
//   replacement voice, across runs.
//
//   Skipped cases (no auto-fix, but reported):
//     * Character.gender is null / unknown.
//     * Voice has no builtInName (cloned / uploaded voice; can't auto-pick).
//     * No voice in the book matches the target gender — the script
//       reports it but does not create a new Voice row. Manual creation
//       is a one-click action in VoicePanel.

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

import { prisma } from '../src/lib/db/client';

// Mirror of the gender tables in audiobook_generator.py / EbookReader.tsx.
const VOICE_GENDER: Record<string, 'female' | 'male'> = {
  // Female
  'Ngọc Linh': 'female',
  'Ngọc Lan': 'female',
  'Mỹ Duyên': 'female',
  'Trúc Ly': 'female',
  // Male
  'Bình An': 'male',
  'Gia Bảo': 'male',
  'Đức Trí': 'male',
  'Thái Sơn': 'male',
  'Trọng Hữu': 'male',
  'Xuân Vĩnh': 'male',
};

function builtinGenderOf(voice: { builtinName?: string | null; name?: string }): 'female' | 'male' | 'unknown' {
  const builtin = voice.builtinName ?? (voice.name ?? '');
  return VOICE_GENDER[builtin] ?? 'unknown';
}

/** Stable hash matching src/lib/ai/voice-selector.ts::poolSlotForName. */
function pickSlot(name: string, count: number): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % Math.max(1, count);
}

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

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  const bookId = process.env.MEASURE_BOOK_ID;

  if (!bookId) {
    console.error('Set MEASURE_BOOK_ID=<uuid> before running.');
    process.exitCode = 2;
    return;
  }

  const book = await prisma.book.findUnique({ where: { id: bookId } });
  if (!book) {
    console.error(`Book not found: ${bookId}`);
    process.exitCode = 2;
    return;
  }

  const characters = await prisma.character.findMany({
    where: { bookId },
    include: { voice: true },
    orderBy: { name: 'asc' },
  });
  const voices = await prisma.voice.findMany({
    where: { bookId },
    orderBy: { name: 'asc' },
  });

  const fixes: Fix[] = [];
  for (const ch of characters) {
    const charGender = ch.gender as 'female' | 'male' | 'unknown' | null;
    if (charGender !== 'female' && charGender !== 'male') {
      fixes.push({
        characterId: ch.id,
        characterName: ch.name,
        characterGender: 'female',
        currentVoice: ch.voice?.name ?? '(none)',
        currentBuiltinGender: 'unknown',
        suggestedBuiltin: null,
        suggestedVoiceId: null,
        status: 'gender-missing',
      });
      continue;
    }

    if (!ch.voice) {
      fixes.push({
        characterId: ch.id,
        characterName: ch.name,
        characterGender: charGender,
        currentVoice: '(none)',
        currentBuiltinGender: 'unknown',
        suggestedBuiltin: null,
        suggestedVoiceId: null,
        status: 'no-voice',
      });
      continue;
    }

    const builtinGender = builtinGenderOf(ch.voice);
    if (builtinGender === 'unknown') {
      // Cloned / uploaded voice — can't auto-detect mismatch.
      fixes.push({
        characterId: ch.id,
        characterName: ch.name,
        characterGender: charGender,
        currentVoice: ch.voice.name,
        currentBuiltinGender: 'unknown',
        suggestedBuiltin: null,
        suggestedVoiceId: null,
        status: 'no-builtin',
      });
      continue;
    }

    if (builtinGender === charGender) {
      fixes.push({
        characterId: ch.id,
        characterName: ch.name,
        characterGender: charGender,
        currentVoice: ch.voice.name,
        currentBuiltinGender: builtinGender,
        suggestedBuiltin: null,
        suggestedVoiceId: null,
        status: 'correct',
      });
      continue;
    }

    // Inverted — find a replacement voice of the correct gender.
    const candidates = voices
      .filter((v) => builtinGenderOf(v) === charGender)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (candidates.length === 0) {
      fixes.push({
        characterId: ch.id,
        characterName: ch.name,
        characterGender: charGender,
        currentVoice: ch.voice.name,
        currentBuiltinGender: builtinGender,
        suggestedBuiltin: null,
        suggestedVoiceId: null,
        status: 'no-candidate',
      });
      continue;
    }

    const slot = pickSlot(ch.name, candidates.length);
    const chosen = candidates[slot];
    fixes.push({
      characterId: ch.id,
      characterName: ch.name,
      characterGender: charGender,
      currentVoice: ch.voice.name,
      currentBuiltinGender: builtinGender,
      suggestedBuiltin: chosen.name,
      suggestedVoiceId: chosen.id,
      status: 'inverted',
    });
  }

  // Report
  console.log(`Book: ${book.title} (${book.id})`);
  console.log(`Characters inspected: ${fixes.length}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY (writes to DB)'}`);
  console.log('');

  const inverted = fixes.filter((f) => f.status === 'inverted');
  const correct = fixes.filter((f) => f.status === 'correct');
  const skipped = fixes.filter((f) => f.status !== 'correct' && f.status !== 'inverted');

  console.log(`Already-correct: ${correct.length}`);
  console.log(`Gender-inverted (auto-fixable): ${inverted.length}`);
  console.log(`Skipped (need manual fix):`);
  for (const f of skipped) {
    console.log(`  - [${f.status}] ${f.characterName} (gender=${f.characterGender}) → voice=${f.currentVoice}`);
  }
  console.log('');

  if (inverted.length > 0) {
    console.log('Inversions to fix:');
    console.table(
      inverted.map((f) => ({
        character: f.characterName,
        gender: f.characterGender,
        was: f.currentVoice,
        builtinOfCurrent: f.currentBuiltinGender,
        becomes: f.suggestedBuiltin,
      })),
    );
  }

  if (!dryRun && inverted.length > 0) {
    for (const f of inverted) {
      if (!f.suggestedVoiceId) continue;
      await prisma.character.update({
        where: { id: f.characterId },
        data: { voiceId: f.suggestedVoiceId },
      });
    }
    console.log(`✓ Wrote ${inverted.length} reassignment(s).`);
    console.log('Note: the AudiobookChapter rows for this book will need to be regenerated');
    console.log('(their configHash changed). Run the BullMQ worker or click "Reset" in');
    console.log('AudiobookPanel to invalidate.');
  } else if (inverted.length > 0) {
    console.log(`Re-run with --apply to commit ${inverted.length} reassignment(s).`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

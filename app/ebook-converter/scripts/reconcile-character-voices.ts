// scripts/reconcile-character-voices.ts
//
// One-shot reconciliation for per-character Voice rows that point at
// builtins removed in the Jul-2026 upstream VieNeu-TTS sync.
//
// Companion to `reconcile-common-pool.ts`:
//   - reconcile-common-pool.ts rewrites `kind === 'common'` rows (round-robin
//     from the 2F + 2M shared pool). Done.
//   - This script rewrites `kind === 'character'` and `kind === 'narrator'`
//     rows whose `builtinName` is in the removed set.
//
// Without this fix, /api/tts for a character whose Voice row points at
// "Ngọc Lan" (etc.) hits the unified TTS server with `voice: 'Ngọc Lan'`,
// which the new catalog rejects with:
//   "Voice 'Ngọc Lan' not found. Available: ['Trúc Ly', ...]"
// The 502 cascades up into EbookReader as
//   [tts] prefetchParagraph FAILED — first paragraph will be silent.
//
// Replacement strategy (gender + age/style match):
//
//   Removed (gender, age/style)         →  Replacement
//   ─────────────────────────────────────────────────────
//   Ngọc Lan     (female, calm/mature)  →  Ngọc Linh
//   Mỹ Duyên     (female, calm/mature)  →  Thục Đoan
//   Bình An      (male,   calm/mature)  →  Thanh Bình
//   Trọng Hữu    (male,   calm/mature)  →  Thái Sơn
//   Đức Trí      (male,   calm/mature)  →  Minh Đức
//   Gia Bảo      (male,   mature)       →  Xuân Vĩnh  (round-robin slot)
//
// We round-robin among the 4 male calm/serious replacements (Thanh Bình /
// Thái Sơn / Minh Đức / Xuân Vĩnh) so identical male characters don't all
// land on Thanh Bình. Round-robin counter is per-bookId, so each book's
// narrator gets a different fallback if multiple removed builtins are
// present.
//
// The script also updates Voice.name so the UI label matches the new
// builtin (otherwise the picker would show "Ngọc Lan" while the server
// sees Ngọc Linh — confusing for the user).
//
// Usage:
//   npx tsx scripts/reconcile-character-voices.ts                # dry-run
//   npx tsx scripts/reconcile-character-voices.ts --apply        # write
//   npx tsx scripts/reconcile-character-voices.ts --apply --book <id>
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

import { prisma } from '../src/lib/db/client';
import { BUILTIN_VIENEU_NAMES } from '../src/lib/tts/vieneu-voices';

// ── Removed builtins ────────────────────────────────────────────────────────
// Names the Jul-2026 upstream sync removed from the server catalog. Any
// Voice row (regardless of kind) with builtinName in this list is broken.
const REMOVED_BUILTINS = new Set([
  'Ngọc Lan', 'Bình An', 'Gia Bảo', 'Đức Trí', 'Mỹ Duyên', 'Trọng Hữu',
]);

// ── Replacement table ──────────────────────────────────────────────────────
// Static, gender-matched equivalents in the new catalog. The male calm/
// serious replacements are listed in round-robin order; we pop from this
// list per-bookId to spread identical male characters across all four.
const FEMALE_REPLACEMENTS: Record<string, string> = {
  'Ngọc Lan': 'Ngọc Linh',
  'Mỹ Duyên': 'Thục Đoan',
};

const MALE_REPLACEMENTS_ROTATION = ['Thanh Bình', 'Thái Sơn', 'Minh Đức', 'Xuân Vĩnh'];

function pickMaleReplacement(bookId: string): string {
  // Cheap stable hash → index. Avoids needing a counter reset between
  // invocations but still spreads books across the 4 male voices.
  let hash = 0;
  for (let i = 0; i < bookId.length; i++) hash = (hash * 31 + bookId.charCodeAt(i)) >>> 0;
  return MALE_REPLACEMENTS_ROTATION[hash % MALE_REPLACEMENTS_ROTATION.length];
}

interface Rewrite {
  voiceId: string;
  bookId: string;
  characterId: string | null;
  characterName: string | null;
  voiceName: string;
  from: string;
  to: string;
}

async function gatherStale(bookFilter?: string): Promise<Rewrite[]> {
  const voices = await prisma.voice.findMany({
    where: {
      // common rows are handled by reconcile-common-pool.ts; skip them here.
      kind: { not: 'common' },
      builtinName: { in: Array.from(REMOVED_BUILTINS) },
      ...(bookFilter ? { bookId: bookFilter } : {}),
    },
    select: {
      id: true, bookId: true, name: true, builtinName: true,
      characters: { select: { id: true, name: true }, take: 1 },
    },
    orderBy: [{ bookId: 'asc' }, { createdAt: 'asc' }],
  });

  // Track which male replacement slot we've used per-bookId so we don't
  // dump all identical male characters into the first slot.
  const maleSlotByBook = new Map<string, number>();

  const rewrites: Rewrite[] = [];
  for (const v of voices) {
    const from = v.builtinName!;
    let to: string;
    if (FEMALE_REPLACEMENTS[from]) {
      to = FEMALE_REPLACEMENTS[from];
    } else {
      // Male removed → round-robin across the 4 male replacements.
      const slot = maleSlotByBook.get(v.bookId) ?? 0;
      to = MALE_REPLACEMENTS_ROTATION[slot % MALE_REPLACEMENTS_ROTATION.length];
      maleSlotByBook.set(v.bookId, slot + 1);
    }
    rewrites.push({
      voiceId: v.id,
      bookId: v.bookId,
      characterId: v.characters[0]?.id ?? null,
      characterName: v.characters[0]?.name ?? null,
      voiceName: v.name,
      from,
      to,
    });
  }
  return rewrites;
}

function fmtRow(r: Rewrite): string {
  const char = r.characterName ? `  char="${r.characterName}"` : '';
  return `  - book=${r.bookId.slice(0, 8)}  voice="${r.voiceName}"${char}  ${r.from} → ${r.to}`;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const bookIdx = args.indexOf('--book');
  const bookFilter = bookIdx >= 0 ? args[bookIdx + 1] : undefined;

  if (bookFilter && !/^[0-9a-f-]{8,}$/i.test(bookFilter)) {
    console.error(`--book expects a book id (uuid), got "${bookFilter}"`);
    process.exit(1);
  }

  const rewrites = await gatherStale(bookFilter);

  if (rewrites.length === 0) {
    console.log('Found 0 stale character-voice rows; nothing to do.');
    return;
  }

  console.log(`Found ${rewrites.length} stale character-voice row(s):`);
  for (const r of rewrites) console.log(fmtRow(r));

  if (!apply) {
    console.log(`\nDry-run only. Pass --apply to commit.`);
    return;
  }

  // Sanity-check the replacements are valid builtins (defence against typos).
  for (const r of rewrites) {
    if (!BUILTIN_VIENEU_NAMES.includes(r.to)) {
      console.error(`Refusing to write invalid builtin "${r.to}" (not in BUILTIN_VIENEU_NAMES).`);
      process.exit(2);
    }
  }

  let written = 0;
  for (const r of rewrites) {
    // Update builtinName AND name so the UI label matches what the server
    // receives. Without this, the picker shows "Ngọc Lan" while synthesis
    // uses Ngọc Linh — confusing in VoicePanel.
    await prisma.voice.update({
      where: { id: r.voiceId },
      data: { builtinName: r.to, name: r.to },
    });
    written++;
  }

  // Bump audiobookStatus so the next pre-gen picks up the new builtin names.
  const touchedBookIds = new Set(rewrites.map((r) => r.bookId));
  for (const bid of touchedBookIds) {
    await prisma.book.update({
      where: { id: bid },
      data: { audiobookStatus: 'none' },
    });
  }

  console.log(`\nRewrote ${written}/${rewrites.length} voice rows. Marked ${touchedBookIds.size} book(s) for re-generation.`);
  console.log('Restart any running app/server (host + container) so Prisma picks up the new snapshot.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('reconcile-character-voices failed:', e);
      process.exit(1);
    });
}

export { gatherStale, REMOVED_BUILTINS };
// scripts/reconcile-common-pool.ts
//
// One-shot reconciliation for the common-voice pool after the Jul-2026
// upstream VieNeu-TTS sync. Background:
//
//   - `app/tts-service/VieNeu-TTS/src/vieneu/assets/voices_v3_turbo.json`
//     now serves 10 voices (Trúc Ly, Phạm Tuyên, Thái Sơn, Xuân Vĩnh, Thanh
//     Bình, Minh Đức, Ngọc Linh, Đoan Trang, Mai Anh, Thục Đoan). Six of the
//     old catalog names (Ngọc Lan, Bình An, Gia Bảo, Đức Trí, Mỹ Duyên,
//     Trọng Hữu) are gone from the server — they no longer resolve to any
//     preset and pre-generation now fails silently or produces a wrong-vox
//     chunk for any Voice row whose builtinName points at them.
//
//   - Per-book common-pool rows carry builtinName from the OLD catalog and
//     are stale. This script rewrites them to surviving presets so the next
//     pre-generation pass uses working voices.
//
// Rules:
//   1. Only `kind === 'common'` rows are touched.
//   2. Only builtinName in the removed set is rewritten (surviving presets
//      like "Trúc Ly", "Xuân Vĩnh", "Thái Sơn", "Ngọc Linh" pass through).
//   3. New builtinName is picked round-robin from COMMON_POOL_BUILTINS
//      (defined in src/lib/tts/vieneu-voices.ts). 2F + 2M for tonal variety.
//   4. Dry-run by default — pass --apply to commit.
//
// Usage:
//   npx tsx scripts/reconcile-common-pool.ts            # dry-run, audit only
//   npx tsx scripts/reconcile-common-pool.ts --apply    # write changes
//   npx tsx scripts/reconcile-common-pool.ts --apply --book <id>  # one book
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

import { prisma } from '../src/lib/db/client';
import {
  BUILTIN_VIENEU_NAMES,
  COMMON_POOL_BUILTINS,
} from '../src/lib/tts/vieneu-voices';

// Names the Jul-2026 upstream sync removed from the server catalog. Any
// Voice row with builtinName in this list is broken (synthesizer will 404).
const REMOVED_BUILTINS = new Set([
  'Ngọc Lan', 'Bình An', 'Gia Bảo', 'Đức Trí', 'Mỹ Duyên', 'Trọng Hữu',
]);

interface Rewrite {
  voiceId: string;
  bookId: string;
  name: string;
  from: string | null;
  to: string;
}

async function gatherStale(bookFilter?: string): Promise<Rewrite[]> {
  const where: { kind: string; bookId?: string } = { kind: 'common' };
  if (bookFilter) where.bookId = bookFilter;

  const voices = await prisma.voice.findMany({
    where,
    select: { id: true, bookId: true, name: true, builtinName: true },
    orderBy: [{ bookId: 'asc' }, { createdAt: 'asc' }],
  });

  const rewrites: Rewrite[] = [];
  let rrIdx = 0;
  for (const v of voices) {
    const bn = v.builtinName ?? null;
    const isStale = bn ? REMOVED_BUILTINS.has(bn) : false;
    const isMissingFromCatalog = bn && !BUILTIN_VIENEU_NAMES.includes(bn);
    if (!isStale && !isMissingFromCatalog) continue;
    const next = COMMON_POOL_BUILTINS[rrIdx % COMMON_POOL_BUILTINS.length];
    rrIdx++;
    rewrites.push({
      voiceId: v.id,
      bookId: v.bookId,
      name: v.name,
      from: bn,
      to: next,
    });
  }
  return rewrites;
}

function fmtRow(r: Rewrite): string {
  return `  - book=${r.bookId.slice(0, 8)}  voice="${r.name}"  ${r.from ?? '(null)'} → ${r.to}`;
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
    console.log('Found 0 stale common-pool rows; nothing to do.');
    return;
  }

  console.log(`Found ${rewrites.length} stale common-pool row(s):`);
  for (const r of rewrites) console.log(fmtRow(r));

  if (!apply) {
    console.log(`\nDry-run only. Pass --apply to commit.`);
    return;
  }

  let written = 0;
  for (const r of rewrites) {
    await prisma.voice.update({
      where: { id: r.voiceId },
      data: { builtinName: r.to },
    });
    written++;
  }

  // Bump audiobookStatus so the next pre-gen picks up the new builtin names
  const touchedBookIds = new Set(rewrites.map((r) => r.bookId));
  for (const bid of touchedBookIds) {
    await prisma.book.update({
      where: { id: bid },
      data: { audiobookStatus: 'none' },
    });
  }

  console.log(`\nRewrote ${written}/${rewrites.length} rows. Marked ${touchedBookIds.size} book(s) for re-generation.`);
}

// Standalone runner
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('reconcile-common-pool failed:', e);
      process.exit(1);
    });
}

export { gatherStale, REMOVED_BUILTINS };

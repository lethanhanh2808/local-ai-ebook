// scripts/backfill-character-bible.ts
//
// One-shot per-chapter Character Bible scanner.
//
// For each Book in the library, runs refreshBible(bookId, { chapterIndex: i,
// autoMerge }) once per chapter, accumulating patches into the bible
// incrementally. Skips books whose CharacterProfile already has ≥ 1 row
// (i.e. the bible has been initialised), unless --force is passed.
//
// Why per-chapter (and not whole-book in one call)?
//   - A single 40 k-char chapter already pushed us into "Unexpected end
//     of JSON input" territory. Whole-novel prompts blow past the local
//     model's context window.
//   - One bad chapter-merge shouldn't corrupt the whole bible. Per-chapter
//     deltas queue conflicting updates as PendingBibleDiff for review.
//   - Per-chapter matches the runtime path: the chapter-close hook
//     (EbookReader / AudiobookPlayer) enqueues the same call shape, so
//     behaviour is consistent.
//
// Flags:
//   --book-id <uuid>      only scan one book
//   --dry-run             do not commit; just count how many chapters
//                          would be scanned
//   --apply               commit via autoMerge=true (default: autoMerge=false,
//                          so the caller can preview via UI before approving)
//   --force               re-scan books that already have a bible
//   --from <N>            start at chapter N (default 0)
//   --to <M>              stop after chapter M (inclusive); default = all
//   --delay-ms <ms>       sleep between chapters (default 500 ms) —
//                          polite to the local LLM
//
// Usage:
//   npx tsx scripts/backfill-character-bible.ts --dry-run
//   BOOK_ID=<uuid> npx tsx scripts/backfill-character-bible.ts --apply --from 0 --to 9
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, '.env.local'))) {
  // dotenv/config already loaded .env; preload .env.local on top so local
  // SQLite overrides win.
  const env = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const prisma = new PrismaClient();
// Lazy import — `refreshBible` uses path aliases and is not CJS-friendly
// via top-level await. Lazy + inside main() works under esbuild/tsx CJS.
async function loadRefresh() {
  return (await import('../src/lib/ai/character-bible')).refreshBible;
}
// Lazy import for parseEpub — same reason.
async function loadParseEpub() {
  return (await import('../src/lib/pipeline/epub-parser')).parseEpub;
}

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}
function flag(flag: string): boolean {
  return process.argv.includes(flag);
}
function argNumber(flag: string, fallback: number): number {
  const v = arg(flag);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const onlyBookId = arg('--book-id') ?? process.env.BOOK_ID;
const dryRun = flag('--dry-run');
const apply = flag('--apply') || (!flag('--dry-run') && !arg('--book-id')); // default = apply-all when no flag
const force = flag('--force');
const fromIdx = Math.max(0, argNumber('--from', 0));
const toIdxArg = arg('--to');
const delayMs = Math.max(0, argNumber('--delay-ms', 500));
const autoMerge = apply;

async function countProfiles(bookId: string): Promise<number> {
  return prisma.characterProfile.count({ where: { character: { bookId } } });
}

async function countChapters(bookId: string): Promise<number> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { filePath: true } });
  if (!book?.filePath || !fs.existsSync(book.filePath)) return 0;
  try {
    const parseEpub = await loadParseEpub();
    const epub = await parseEpub(book.filePath);
    return epub.htmlFiles.length;
  } catch (e) {
    console.warn(`[backfill]   could not parse epub for ${bookId.slice(0, 8)}: ${(e as Error).message}`);
    return 0;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const refreshBible = await loadRefresh();
  const where = onlyBookId ? { id: onlyBookId } : {};
  const books = await prisma.book.findMany({ where, select: { id: true, title: true } });
  console.log(
    `[backfill] Found ${books.length} book(s). ` +
    `dryRun=${dryRun} apply=${apply} force=${force} autoMerge=${autoMerge} ` +
    `from=${fromIdx} to=${toIdxArg ?? 'end'} delayMs=${delayMs}`,
  );

  let totalProfiles = 0;
  let totalChapters = 0;
  let skipped = 0;
  let scanned = 0;
  let errors = 0;
  for (const book of books) {
    const existing = await countProfiles(book.id);
    if (existing > 0 && !force) {
      console.log(`[backfill]   skip "${book.title}" (${book.id.slice(0, 8)}) — already has ${existing} profile(s); pass --force to override`);
      skipped++;
      continue;
    }
    const chapterCount = await countChapters(book.id);
    const toIdx = toIdxArg == null ? chapterCount - 1 : Math.min(chapterCount - 1, argNumber('--to', chapterCount - 1));
    const range = Math.max(0, toIdx - fromIdx + 1);
    if (dryRun) {
      console.log(`[backfill]   would scan "${book.title}" (${book.id.slice(0, 8)}) — ${range} chapter(s) [${fromIdx}..${toIdx}], existing profiles=${existing}`);
      totalChapters += range;
      continue;
    }
    console.log(`[backfill]   scanning "${book.title}" (${book.id.slice(0, 8)}) — ${range} chapter(s) [${fromIdx}..${toIdx}] autoMerge=${autoMerge}`);
    let bookProfiles = 0;
    for (let i = fromIdx; i <= toIdx; i++) {
      const t0 = Date.now();
      try {
        const result = await refreshBible(book.id, {
          chapterIndex: i,
          chapterFile: null,
          autoMerge,
          maxChapterChars: 30_000,
        });
        const ms = Date.now() - t0;
        console.log(
          `[backfill]     ch=${i} ${ms}ms — applied=${result.autoApplied} queued=${result.queued} conflicts=${result.conflicts}`,
        );
        bookProfiles += result.autoApplied;
        totalChapters++;
        if (i < toIdx && delayMs > 0) await sleep(delayMs);
      } catch (e) {
        errors++;
        console.error(`[backfill]     ch=${i} ERROR: ${e instanceof Error ? e.message : String(e)}`);
        // Continue with the next chapter — one bad chapter shouldn't stop
        // the whole sweep. The user can re-run with --from <i+1>.
      }
    }
    totalProfiles += bookProfiles;
    scanned++;
    console.log(`[backfill]     → ${bookProfiles} profile(s) created across ${range} chapter(s)`);
  }

  console.log(
    `[backfill] Done. scanned=${scanned} skipped=${skipped} errors=${errors} ` +
    `chapters=${totalChapters} totalProfilesCreated≈${totalProfiles}.`,
  );
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error('[backfill] error:', e);
  await prisma.$disconnect();
  process.exit(1);
});
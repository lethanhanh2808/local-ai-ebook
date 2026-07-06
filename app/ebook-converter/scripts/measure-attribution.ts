// scripts/measure-attribution.ts
//
// Local corpus probe for ACTION_ITEMS_V2.md + the headline measurement
// for D1 (cross-chapter ConversationState carry).
//
// Usage:
//   # Default — multi-chapter walk with the seed threaded through:
//   MEASURE_BOOK_ID=<uuid> npx tsx scripts/measure-attribution.ts [--seed]
//   #          ↳ walks chapters --from..--to (default chapter003..chapter005),
//   #            loads BookConversationState before each chapter, persists
//   #            the final state back. Matches production behaviour.
//
//   # Single-chapter legacy probe (no seed carry, no persist):
//   MEASURE_BOOK_ID=<uuid> MEASURE_CHAPTER_ID=chapter005 \
//     npx tsx scripts/measure-attribution.ts --no-seed
//
//   # Custom book / chapter scope:
//   npx tsx scripts/measure-attribution.ts --book <uuid> --from chapter004 --to chapter005
//
// Flags:
//   --seed              Thread BookConversationState across chapters
//                        (default).  Persists the final state after each.
//   --no-seed           Legacy single-chapter behaviour.
//   --book <uuid>       Book id (overrides MEASURE_BOOK_ID).
//   --from <chapterId>  First chapter to attribute (default: chapter003).
//   --to <chapterId>    Last chapter to attribute (default: chapter005).
//   --inventory-only    Score only the configured chapter, skip persistence
//                        and the per-chapter walk table.  Implies
//                        `--no-seed` if combined.
//
// Inventory: the 22 misattribution rows from ACTION_ITEMS_V2.md,
// keyed by paragraph index.  Used as the headline delta metric so
// before/after runs (with and without the seed) are directly comparable.

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

import { getBook } from '../src/lib/db/books';
import { listCharacters } from '../src/lib/db/voices';
import { parseEpub } from '../src/lib/pipeline/epub-parser';
import {
  attributeByRegex,
  attributeConversationChapter,
  computeStats,
  sliceParagraphs,
} from '../src/lib/attribution';
import {
  loadConversationState,
  saveConversationState,
  clearConversationState,
} from '../src/lib/db/conversation-state';
import type { AttributionEvidence } from '../src/lib/db/chapter-attribution';

const DEFAULT_BOOK_ID = 'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314';
const DEFAULT_CHAPTER_ID = 'chapter005';
const DEFAULT_FROM = 'chapter003';
const DEFAULT_TO = 'chapter005';
const ATTRIBUTION_VERSION = 'conversation-v3+vncorenlp-1.2';

const INVENTORY: Array<{
  row: number;
  quote: string;
  was: string;
  should: string;
}> = [
  { row: 10, quote: 'Sai!', was: 'Ưu Nhi', should: 'Y Đằng Long' },
  { row: 14, quote: 'Đúng rồi đúng rồi, Ưu Nhi đã trưởng thành rồi.', was: 'Ưu Nhi', should: 'Y Đằng Long' },
  { row: 17, quote: 'Anh......đồ quá đáng!', was: 'Y Đằng Long', should: 'Y Đằng Ưu Nhi' },
  { row: 21, quote: 'Hừ, anh trai hư đốn chả nghĩ được chuyện gì tốt đẹp.', was: 'Y Đằng Long', should: 'Y Đằng Ưu Nhi' },
  { row: 29, quote: 'Yên tâm đi, đại ca!', was: 'Y Đằng Long', should: 'Y Đằng Ưu Nhi' },
  { row: 39, quote: 'Anh, anh bày ra cái bộ dáng quái dị này...', was: 'Y Đằng Long', should: 'context-dependent' },
  { row: 43, quote: 'Cha.', was: 'Y Đằng Long', should: 'Y Đằng Ưu Nhi' },
  { row: 46, quote: 'Hoá ra là Y Đằng thiếu gia và tiểu thư...', was: 'Y Đằng Long', should: 'host/other' },
  { row: 49, quote: 'Bác Y Đằng, Y Đằng huynh.', was: 'Y Đằng Long', should: 'Nhâm Thiếu Hoài' },
  { row: 53, quote: 'Em gái?', was: 'Y Đằng Long', should: 'Nhâm Thiếu Hoài' },
  { row: 65, quote: 'Cái gì hả, tôi không hiểu anh đang nói...', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Ưu Nhi' },
  { row: 67, quote: 'Anh......', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Ưu Nhi' },
  { row: 69, quote: 'Làm sao tôi biết được là anh sẽ không?', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Ưu Nhi' },
  { row: 75, quote: 'Đừng tưởng anh có thể quyến rũ được tôi...', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Ưu Nhi' },
  { row: 82, quote: 'Hưởng thụ......', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Ưu Nhi' },
  { row: 99, quote: 'Nhâm Thiếu Hoài, anh rốt cuộc muốn nhảy đến khi nào đây?', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Long' },
  { row: 101, quote: 'Thực quá bất công!', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Ưu Nhi' },
  { row: 103, quote: 'Oái......', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Ưu Nhi' },
  { row: 126, quote: 'Cô ta không hợp với anh.', was: 'Y Đằng Ưu Nhi', should: 'Y Đằng Chân Lí Tử' },
  { row: 135, quote: 'Những......những điều đó Y Đằng Ưu Nhi đều không làm được', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Chân Lí Tử' },
  { row: 138, quote: 'Nhâm Thiếu Hoài......', was: 'Nhâm Thiếu Hoài', should: 'Y Đằng Chân Lí Tử' },
  { row: 104, quote: '(Y Đằng Chân Lí Tử related context)', was: '?', should: 'Y Đằng Chân Lí Tử' },
];

// ── argv parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  seed: boolean;
  book: string;
  from: string;
  to: string;
  inventoryOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    seed: true,
    book: process.env.MEASURE_BOOK_ID ?? DEFAULT_BOOK_ID,
    from: process.env.MEASURE_FROM ?? DEFAULT_FROM,
    to: process.env.MEASURE_TO ?? DEFAULT_TO,
    inventoryOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-seed') { out.seed = false; continue; }
    if (a === '--seed')    { out.seed = true;  continue; }
    if (a === '--book')    { out.book = argv[++i] ?? out.book; continue; }
    if (a === '--from')    { out.from = argv[++i] ?? out.from; continue; }
    if (a === '--to')      { out.to = argv[++i] ?? out.to; continue; }
    if (a === '--inventory-only') { out.inventoryOnly = true; continue; }
    if (a === '--help' || a === '-h') {
      console.log('Usage: tsx scripts/measure-attribution.ts [--seed|--no-seed] [--book <uuid>] [--from <chapterId>] [--to <chapterId>] [--inventory-only]');
      process.exit(0);
    }
  }
  if (out.inventoryOnly) out.seed = false;
  return out;
}

// ── inventory scoring ─────────────────────────────────────────────────────────

type Verdict = 'fixed' | 'partial' | 'wrong';

function verdictFor(
  row: { speaker: string | null; source: string; evidence?: AttributionEvidence[] } | undefined,
  expected: string,
): Verdict {
  const actual = row?.speaker ?? null;
  const softExpected = expected === 'host/other' || expected === 'context-dependent';
  if (actual && !softExpected && actual.toLowerCase() === expected.toLowerCase()) return 'fixed';
  if (!actual && softExpected) return 'fixed';
  if (row?.source === 'unresolved-actor' && !softExpected) return 'partial';
  const unresolvedName = row?.evidence?.find((e) => e.source === 'timeline')?.speaker ?? null;
  if (!actual && unresolvedName && !softExpected) return 'partial';
  return 'wrong';
}

function scoreInventory(attribution: Record<number, { speaker: string | null; source: string; evidence?: AttributionEvidence[] }>) {
  let fixed = 0;
  let partial = 0;
  let wrong = 0;
  const table = INVENTORY.map((item) => {
    const row = attribution[item.row];
    const actual = row?.speaker ?? null;
    const verdict = verdictFor(row, item.should);
    if (verdict === 'fixed') fixed += 1;
    else if (verdict === 'partial') partial += 1;
    else wrong += 1;
    return {
      '#': item.row,
      quote: item.quote,
      was: item.was,
      should: item.should,
      after: actual ?? row?.source ?? '(none)',
      verdict,
    };
  });
  return { fixed, partial, wrong, table };
}

// ── EPUB helpers ──────────────────────────────────────────────────────────────

function resolveHostBookPath(filePath: string): string {
  if (fs.existsSync(filePath)) return filePath;
  if (filePath.startsWith('/app/')) {
    const local = path.join(process.cwd(), filePath.slice('/app/'.length));
    if (fs.existsSync(local)) return local;
  }
  const byBasename = path.join(process.cwd(), 'data/library', path.basename(filePath));
  if (fs.existsSync(byBasename)) return byBasename;
  return filePath;
}

async function loadChapter(
  bookId: string,
  chapterId: string,
): Promise<{ html: string; chapterIndex: number; chapterFile: string }> {
  const book = await getBook(bookId);
  if (!book) throw new Error(`Book not found: ${bookId}`);
  const epub = await parseEpub(resolveHostBookPath(book.filePath));
  const chapterFile = epub.htmlFiles.find((file) => {
    const base = path.basename(file, path.extname(file));
    return base === chapterId || path.basename(file) === chapterId;
  });
  if (!chapterFile) throw new Error(`Chapter not found: ${chapterId}`);
  const chapterIndex = epub.htmlFiles.indexOf(chapterFile);
  const html = epub.entries.get(chapterFile)?.data.toString('utf8') ?? '';
  return { html, chapterIndex, chapterFile };
}

async function loadCharacterContext(bookId: string) {
  const chars = await listCharacters(bookId);
  const characterContext = chars.map((c) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    gender: c.gender ?? null,
  }));
  const knownNames = chars.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  return { chars, characterContext, knownNames };
}

// ── per-chapter attribution runner ────────────────────────────────────────────
//
// `attributeConversationChapter` returns the final ConversationState
// snapshot alongside the attribution map — same shape the production
// `/attribute` route uses. We persist it (when --seed) so the next
// chapter sees a real seed.

async function runOneChapter(
  args: CliArgs,
  bookId: string,
  chapterId: string,
) {
  const { html, chapterIndex, chapterFile } = await loadChapter(bookId, chapterId);
  const { chars, characterContext, knownNames } = await loadCharacterContext(bookId);
  const paragraphs = sliceParagraphs(html);

  // ── Load seed (production path) or skip (legacy) ──────────────────────────
  let seedState: any = undefined;
  let seedReason: 'applied' | 'no-row' | 'stale-chapter' | 'version-mismatch' | 'corrupt-payload' | 'empty-payload' | 'n/a' = 'n/a';
  if (args.seed) {
    const seed = await loadConversationState(bookId, chapterIndex, ATTRIBUTION_VERSION);
    if (seed.found) {
      seedState = seed.seed.state;
      seedReason = 'applied';
    } else {
      seedReason = seed.reason;
    }
  }

  const regexOut = attributeByRegex(paragraphs, knownNames);
  const result = attributeConversationChapter({
    paragraphs,
    characters: characterContext,
    regexOut,
    seedState,
  });
  const stats = computeStats(paragraphs, result.attribution);
  const sourceCounts = Object.values(result.attribution).reduce<Record<string, number>>(
    (acc, row) => { acc[row.source] = (acc[row.source] ?? 0) + 1; return acc; }, {});

  // ── Persist snapshot back (production path) ──────────────────────────────
  let persistedAt: number | null = null;
  if (args.seed) {
    try {
      await saveConversationState(bookId, chapterIndex, result.finalState, ATTRIBUTION_VERSION);
      persistedAt = chapterIndex;
    } catch (e) {
      console.error('  [warn] persist failed:', e instanceof Error ? e.message : e);
    }
  }

  // ── Score inventory if this chapter is the configured single target ──────
  const target = process.env.MEASURE_CHAPTER_ID ?? DEFAULT_CHAPTER_ID;
  const scored = chapterId === target
    ? scoreInventory(result.attribution)
    : { fixed: 0, partial: 0, wrong: 0, table: [] as ReturnType<typeof scoreInventory>['table'] };

  return {
    chapterId,
    chapterIndex,
    chapterFile,
    paragraphs: paragraphs.length,
    chars: chars.length,
    seedApplied: !!seedState,
    seedReason,
    persistedAt,
    stats,
    sourceCounts,
    scored,
    attribution: result.attribution,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const book = await getBook(args.book);
  if (!book) throw new Error(`Book not found: ${args.book}`);
  const epub = await parseEpub(resolveHostBookPath(book.filePath));

  // Resolve from..to to a contiguous range of chapter IDs in order.
  const allIds = epub.htmlFiles.map((f) => path.basename(f, path.extname(f)));
  const fromIdx = allIds.indexOf(args.from);
  const toIdx   = allIds.indexOf(args.to);
  if (fromIdx < 0) throw new Error(`from chapter not found: ${args.from}`);
  if (toIdx < 0)   throw new Error(`to chapter not found: ${args.to}`);
  if (toIdx < fromIdx) throw new Error(`--to (${args.to}) is before --from (${args.from})`);
  const chapterIds = allIds.slice(fromIdx, toIdx + 1);

  console.log(`Book: ${book.title} (${args.book})`);
  console.log(`Seed mode: ${args.seed ? 'THREADED (production)' : 'OFF (legacy)'}`);
  console.log(`Chapter range: ${chapterIds[0]} .. ${chapterIds.at(-1)} (${chapterIds.length} chapters)`);
  if (args.seed) {
    console.log(`Resetting BookConversationState for ${args.book} so this run is the seed source.`);
    await clearConversationState(args.book);
  }

  const runs: Awaited<ReturnType<typeof runOneChapter>>[] = [];
  for (const chapterId of chapterIds) {
    const r = await runOneChapter(args, args.book, chapterId);
    runs.push(r);
    process.stdout.write(
      `  ${chapterId}: seed=${r.seedReason.padEnd(15)} ` +
      `conv=${r.stats.conversationHits} ` +
      `regex=${r.stats.regexHits} ` +
      `default=${r.stats.defaults} ` +
      `parser=${r.stats.parserHits} ` +
      `total=${r.stats.totalParagraphs}\n`
    );
  }

  const heading = (s: string) => console.log(`\n=== ${s} ===`);

  heading('Per-chapter summary');
  console.table(runs.map((r) => ({
    chapter: r.chapterId,
    seedReason: r.seedReason,
    persistedAt: r.persistedAt,
    parserHits: r.stats.parserHits,
    regexHits: r.stats.regexHits,
    convHits: r.stats.conversationHits,
    defaults: r.stats.defaults,
    paragraphs: r.paragraphs,
  })));

  // If the configured single-target chapter is in the run, print its inventory.
  const target = process.env.MEASURE_CHAPTER_ID ?? DEFAULT_CHAPTER_ID;
  const targetRun = runs.find((r) => r.chapterId === target);
  if (targetRun && targetRun.scored.table.length > 0) {
    heading(`Inventory (${INVENTORY.length} rows) on ${target}`);
    console.log(`  fixed : ${targetRun.scored.fixed}/${INVENTORY.length}`);
    console.log(`  partial: ${targetRun.scored.partial}/${INVENTORY.length}`);
    console.log(`  wrong  : ${targetRun.scored.wrong}/${INVENTORY.length}`);
    console.table(targetRun.scored.table);
  }

  if (args.inventoryOnly) {
    console.log('\n(inventory-only mode — exited before walk)');
    return;
  }

  // Delta vs legacy single-chapter unseeded run on the target chapter.
  heading('Headline delta vs legacy (--no-seed) run');
  console.log('Re-running the same target chapter with `--no-seed` for comparison:');
  const noSeedArgs: CliArgs = { ...args, seed: false };
  const noSeedRun = await runOneChapter(noSeedArgs, args.book, target);
  console.table([{
    run: 'seeded',
    seedReason: targetRun?.seedReason ?? 'n/a',
    fixed: targetRun?.scored.fixed ?? 0,
    partial: targetRun?.scored.partial ?? 0,
    wrong: targetRun?.scored.wrong ?? 0,
  }, {
    run: 'no-seed',
    seedReason: 'n/a',
    fixed: noSeedRun.scored.fixed,
    partial: noSeedRun.scored.partial,
    wrong: noSeedRun.scored.wrong,
  }]);
  if (targetRun) {
    const dFixed = targetRun.scored.fixed - noSeedRun.scored.fixed;
    console.log(`  Δ fixed  = ${dFixed >= 0 ? '+' : ''}${dFixed}`);
    console.log(`  Δ wrong  = ${(targetRun.scored.wrong - noSeedRun.scored.wrong) >= 0 ? '+' : ''}${targetRun.scored.wrong - noSeedRun.scored.wrong}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

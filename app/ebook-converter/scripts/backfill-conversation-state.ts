// scripts/backfill-conversation-state.ts
//
// One-shot backfill for D1: walks every chapter of a book in order and
// drives the live `/attribute` route on each, which in turn calls
// `attributeConversationChapter` and writes `BookConversationState` for
// the most recently attributed chapter. The next chapter's
// `/attribute` call sees the persisted seed.
//
// Why this exists:
//   Any book attributed BEFORE D1 landed has no BookConversationState
//   row. Their first post-D1 attribution still works correctly (the
//   loader reports `seedReason: 'no-row'`), but they miss the chapter-
//   boundary bleed fix that D1 provides. This script retriggers the
//   chain in order so even legacy books benefit.
//
// Usage:
//   BACKFILL_BOOK_ID=<uuid> npx tsx scripts/backfill-conversation-state.ts
//   BACKFILL_BOOK_ID=<uuid> npx tsx scripts/backfill-conversation-state.ts --from chapter003 --to chapter020
//   BACKFILL_BOOK_ID=<uuid> npx tsx scripts/backfill-conversation-state.ts --dry-run
//   BACKFILL_BOOK_ID=<uuid> npx tsx scripts/backfill-conversation-state.ts --clear-only
//
// Flags:
//   --book <uuid>            Book id (overrides BACKFILL_BOOK_ID env).
//   --from <chapterId>       First chapter id (default: chapter001).
//   --to <chapterId>         Last chapter id (default: last in book).
//   --base-url <url>         Base URL of the running app
//                              (default: BACKFILL_BASE_URL or http://127.0.0.1:3100).
//   --dry-run                Don't drive the route, just print the planned walk.
//   --clear-only             Delete the seed row and exit (re-arms the book).
//   --rate-ms <n>            Sleep between attribute calls, ms
//                              (default: 250, prevents route flooding).
//   --no-skip-resume          Override the resume-on-already-applied default.
//
// Idempotency:
//   By default, if the row already has `lastChapterIndex >= --to's
//   index`, the script does nothing (chapter order is monotonic so
//   walking past is wasted work). Pass `--no-skip-resume` to re-run.

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

import { getBook } from '../src/lib/db/books';
import { parseEpub } from '../src/lib/pipeline/epub-parser';
import { prisma } from '../src/lib/db/client';
import {
  loadConversationState,
  saveConversationState,
  clearConversationState,
} from '../src/lib/db/conversation-state';

const ATTRIBUTION_VERSION = 'conversation-v3+vncorenlp-1.2';

interface CliArgs {
  book: string;
  from: string;
  to: string | null;
  baseUrl: string;
  dryRun: boolean;
  clearOnly: boolean;
  rateMs: number;
  noSkipResume: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    book: process.env.BACKFILL_BOOK_ID ?? '',
    from: process.env.BACKFILL_FROM ?? 'chapter001',
    to: process.env.BACKFILL_TO ?? null,
    baseUrl: process.env.BACKFILL_BASE_URL ?? 'http://127.0.0.1:3100',
    dryRun: false,
    clearOnly: false,
    rateMs: Number(process.env.BACKFILL_RATE_MS ?? 250),
    noSkipResume: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--book')        { out.book = argv[++i] ?? out.book; continue; }
    if (a === '--from')        { out.from = argv[++i] ?? out.from; continue; }
    if (a === '--to')          { out.to   = argv[++i] ?? out.to;   continue; }
    if (a === '--base-url')    { out.baseUrl = argv[++i] ?? out.baseUrl; continue; }
    if (a === '--dry-run')     { out.dryRun = true; continue; }
    if (a === '--clear-only')  { out.clearOnly = true; continue; }
    if (a === '--rate-ms')     { out.rateMs = Number(argv[++i] ?? 250); continue; }
    if (a === '--no-skip-resume') { out.noSkipResume = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

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

function printHelp() {
  console.log(`Usage: tsx scripts/backfill-conversation-state.ts [flags]

Flags:
  --book <uuid>            Book id (overrides BACKFILL_BOOK_ID env)
  --from <chapterId>       First chapter id (default: chapter001)
  --to <chapterId>         Last chapter id (default: last in book)
  --base-url <url>         Default: http://127.0.0.1:3100 (env: BACKFILL_BASE_URL)
  --dry-run                Plan only, do not touch the DB or HTTP
  --clear-only             Delete the seed row and exit
  --rate-ms <n>            Sleep between attribute calls (default: 250)
  --no-skip-resume         Force re-run even if lastChapterIndex >= --to
  --help / -h              Print this message
`);
}

interface ChapterPlan {
  id: string;
  index: number;   // 0-based
  file: string;
}

async function buildPlan(args: CliArgs): Promise<{ bookId: string; bookTitle: string; chapters: ChapterPlan[] }> {
  if (!args.book) {
    throw new Error('No book id. Pass --book <uuid> or set BACKFILL_BOOK_ID.');
  }
  const book = await getBook(args.book);
  if (!book) throw new Error(`Book not found: ${args.book}`);
  const epub = await parseEpub(resolveHostBookPath(book.filePath));
  const allIds = epub.htmlFiles.map((f) => path.basename(f, path.extname(f)));
  const fromIdx = allIds.indexOf(args.from);
  if (fromIdx < 0) throw new Error(`--from chapter not found: ${args.from}`);
  const toIdx = args.to ? allIds.indexOf(args.to) : allIds.length - 1;
  if (toIdx < 0) throw new Error(`--to chapter not found: ${args.to}`);
  if (toIdx < fromIdx) {
    throw new Error(`--to (${args.to}) is before --from (${args.from})`);
  }
  const chapters: ChapterPlan[] = allIds
    .slice(fromIdx, toIdx + 1)
    .map((id, k) => ({ id, index: fromIdx + k, file: epub.htmlFiles[fromIdx + k] }));
  return { bookId: book.id, bookTitle: book.title, chapters };
}

async function attributeChapterViaHttp(
  baseUrl: string,
  bookId: string,
  chapterId: string,
): Promise<{ ok: boolean; status: number; crossChapter?: any; err?: string }> {
  const url = `${baseUrl}/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/attribute`;
  try {
    const r = await fetch(url, {
      // Generous timeout — the route is `maxDuration = 60` on Next.js.
      signal: AbortSignal.timeout(180_000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, status: r.status, err: typeof body === 'object' && body?.error ? body.error : r.statusText };
    }
    return { ok: true, status: r.status, crossChapter: body.crossChapter };
  } catch (e) {
    return { ok: false, status: 0, err: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.book) {
    printHelp();
    throw new Error('missing --book');
  }

  const { bookId, bookTitle, chapters } = await buildPlan(args);
  console.log(`Book: ${bookTitle} (${bookId})`);
  console.log(`Walk: ${chapters[0].id}..${chapters.at(-1)?.id} (${chapters.length} chapters)`);
  console.log(`Base URL: ${args.baseUrl}`);

  if (args.clearOnly) {
    if (args.dryRun) {
      console.log('[dry-run] would call clearConversationState — skipping');
    } else {
      await clearConversationState(bookId);
      console.log('Cleared BookConversationState row.');
    }
    return;
  }

  // Resume decision: if the row already exists with lastChapterIndex ≥ toIdx,
  // skip unless --no-skip-resume was passed.
  if (!args.dryRun && !args.noSkipResume) {
    const existing = await prisma.bookConversationState.findUnique({ where: { bookId } });
    if (existing && existing.parserVersion === ATTRIBUTION_VERSION) {
      const toIdx = chapters.at(-1)!.index;
      if (existing.lastChapterIndex >= toIdx) {
        console.log(
          `Row already at lastChapterIndex=${existing.lastChapterIndex} ` +
          `(target ${toIdx}). Pass --no-skip-resume to force a re-run.`
        );
        return;
      }
    }
  }

  if (args.dryRun) {
    console.log('[dry-run] planned calls:');
    for (const ch of chapters) {
      console.log(`  GET /api/library/${bookId}/chapters/${ch.id}/attribute`);
    }
    console.log(`Total: ${chapters.length} attribute calls (~${(chapters.length * args.rateMs / 1000).toFixed(1)}s wall-clock, no API time)`);
    return;
  }

  // We deliberately do NOT call clearConversationState here — the resume
  // detection above already short-circuits when the row is up to date.
  // Forcing a clear would defeat the resume behaviour.

  let seeded = 0;
  let applied = 0;
  let noRow = 0;
  let failed = 0;
  const start = Date.now();
  const summary: Array<{ chapterId: string; seedReason: string; ok: boolean }> = [];
  for (const ch of chapters) {
    process.stdout.write(`  ${ch.id} ... `);
    const r = await attributeChapterViaHttp(args.baseUrl, bookId, ch.id);
    if (!r.ok) {
      console.log(`FAIL (${r.status}) ${r.err ?? ''}`);
      failed += 1;
      summary.push({ chapterId: ch.id, seedReason: 'fail', ok: false });
      continue;
    }
    const sr = r.crossChapter?.seedReason ?? 'n/a';
    if (sr === 'no-row') noRow += 1;
    else if (sr === 'applied') applied += 1;
    else seeded += 1;
    console.log(`seedReason=${sr} persistedAt=${r.crossChapter?.persistedAt ?? 'n/a'}`);
    summary.push({ chapterId: ch.id, seedReason: sr, ok: true });
    if (args.rateMs > 0) await new Promise((res) => setTimeout(res, args.rateMs));
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const final = await prisma.bookConversationState.findUnique({ where: { bookId } });

  console.log('');
  console.log(`Done in ${elapsed}s`);
  console.log(`  success : ${summary.filter((s) => s.ok).length}/${chapters.length}`);
  console.log(`  failed  : ${failed}`);
  console.log(`  applied : ${applied}`);
  console.log(`  no-row  : ${noRow}`);
  console.log(`  other   : ${seeded}`);
  console.log(`Row: ${final ? `lastChapterIndex=${final.lastChapterIndex} parserVersion=${final.parserVersion}` : 'absent'}`);
  console.table(summary);

  // Sanity-check by re-fetching the debug endpoint that OPS-7 just shipped.
  try {
    const r = await fetch(`${args.baseUrl}/api/library/${bookId}/conversation-state`);
    if (r.ok) {
      const body = await r.json();
      console.log(`\nDebug endpoint reports: ${JSON.stringify({
        found: body.found,
        lastChapterIndex: body.lastChapterIndex,
        parserVersion: body.parserVersion,
        snapshotSpeaker: body.snapshot?.currentSpeaker,
        dialogueHistoryLength: body.snapshot?.dialogueHistoryLength,
      })}`);
    }
  } catch {
    /* monitoring is best-effort */
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

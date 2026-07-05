// src/app/api/library/[id]/chapters/[chapterId]/attribute/analyze/route.ts
//
// POST /api/library/[id]/chapters/[chapterId]/attribute/analyze
//
// Full-attribution pipeline: parser + regex evidence → stateful conversation
// pass → oMLX LLM only for unresolved/ambiguous paragraphs → final stateful
// fusion. This is the expensive endpoint triggered by the "Full Analysis"
// Wand2 button on the chapter toolbar. Use the cheap GET route for routine
// chapter changes.
//
// The pipeline:
//   1. Invalidate the cached ChapterAttribution row (so we always recompute).
//   2. Run attributeByParse (VnCoreNLP) + attributeByRegex.
//   3. Run local stateful conversation fusion.
//   4. Identify unresolved paragraphs (no speaker after step 3).
//   5. Preflight probe: one cheap chat() call. If it fails → omlxReachable
//      stays false, the LLM step is skipped, response still returns the
//      local stateful result.
//   6. attributeByLLM: batched, concurrent (max 2 in flight), strict name
//      validation. Failed batches are counted but don't abort the pipeline.
//   7. Re-run stateful fusion with LLM evidence, persist to cache, return.
//
// Response:
//   {
//     parserVersion, fromCache: false, parserReachable, omlxReachable,
//     chapter, attribution, stats: { parserHits, regexHits, llmHits,
//     llmFailures, llmRequested, defaults, totalParagraphs }
//   }
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { listCharacters } from '@/lib/db/voices';
import {
  invalidateAttribution,
  setCachedAttribution,
  type ChapterAttributionMap,
} from '@/lib/db/chapter-attribution';
import { chat } from '@/lib/ai';
import {
  ATTRIBUTION_VERSION,
  ATTRIBUTION_VERSION_LLM,
  attributeByConversation,
  attributeByLLM,
  attributeByParse,
  attributeByRegex,
  buildGenderByChar,
  callParser,
  computeStats,
  sliceParagraphs,
} from '@/lib/attribution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel hobby limit is 60s; allow 5 min here because the full pipeline
// (parser + 20 LLM batches × 90s timeout) can easily run 2-3 minutes when
// oMLX is slow or busy.
export const maxDuration = 300;

// ── oMLX preflight probe ─────────────────────────────────────────────────
// Cheap "are you alive?" call. If it fails, we skip the LLM step entirely
// rather than burning 20 × 90s on a known-down provider.
async function omlxPreflight(): Promise<boolean> {
  try {
    const text = await chat({
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 4,
      enable_thinking: false,
      timeoutMs: 15_000,
    });
    return typeof text === 'string';
  } catch {
    return false;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; chapterId: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  // 1. Pull chapter HTML.
  const origin = req.nextUrl.origin;
  const chapterResp = await fetch(
    `${origin}/api/library/${params.id}/chapters/${encodeURIComponent(params.chapterId)}?raw=1`,
  );
  if (!chapterResp.ok) {
    return NextResponse.json({ error: 'Failed to load chapter HTML' }, { status: 502 });
  }
  const { html } = await chapterResp.json() as { html: string };
  if (!html) {
    return NextResponse.json({
      parserVersion: ATTRIBUTION_VERSION,
      fromCache: false,
      parserReachable: false,
      omlxReachable: false,
      chapter: null,
      attribution: {},
      stats: {
        parserHits: 0, regexHits: 0, llmHits: 0,
        llmFailures: 0, llmRequested: 0,
        defaults: 0, totalParagraphs: 0,
      },
    });
  }

  // 2. Resolve chapterIndex + mtime (for cache write-back).
  const filePath = await (await import('@/lib/storage')).resolveBookPath(book);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'EPUB file missing on disk' }, { status: 404 });
  }
  const { parseEpub } = await import('@/lib/pipeline/epub-parser');
  const epub = await parseEpub(filePath);
  const chapterIndex = epub.htmlFiles.findIndex(
    (f) => path.basename(f, path.extname(f)) === params.chapterId
      || path.basename(f) === params.chapterId,
  );
  if (chapterIndex < 0) {
    return NextResponse.json({ error: 'Chapter not found in EPUB' }, { status: 404 });
  }
  let mtime = 0;
  try {
    const stat = fs.statSync(filePath);
    mtime = Math.floor(stat.mtimeMs);
  } catch { /* keep 0 */ }

  // 3. Load characters + slice paragraphs.
  const chars = await listCharacters(params.id);
  const knownNames = chars.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const genderByChar = buildGenderByChar(
    chars.map((c) => ({ name: c.name, aliases: c.aliases ?? [], gender: c.gender ?? null })),
  );
  const paragraphs = sliceParagraphs(html);
  const characterContext = chars.map((c) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    gender: c.gender ?? null,
  }));

  // 4. Force a fresh compute (don't serve from cache — the user explicitly
  //    asked for "full analysis").
  await invalidateAttribution(params.id, chapterIndex);

  // 5. Parser + regex layers (identical to the GET route's computeFn).
  let parserReachable = true;
  const parserText = paragraphs.map((p) => p.text).join('\n');
  const parserResp = await callParser(parserText);
  let parserOut: ChapterAttributionMap = {};
  if (parserResp) {
    parserOut = attributeByParse(paragraphs, parserResp.sentences, knownNames, genderByChar);
  } else {
    parserReachable = false;
  }
  const regexOut = attributeByRegex(paragraphs, knownNames);

  const localBaseline = attributeByConversation({
    paragraphs,
    characters: characterContext,
    parserOut,
    regexOut,
  });

  // 6. oMLX preflight probe. On failure we skip the LLM step but still
  //    return the local stateful result.
  const omlxReachable = await omlxPreflight();

  let llmOut: ChapterAttributionMap = {};
  let llmFailures = 0;
  let llmRequested = 0;
  if (omlxReachable) {
    // 7. Identify paragraphs still unresolved after parser + regex +
    //    local conversation state.
    const unresolved = paragraphs
      .filter((p) => !localBaseline[p.index]?.speaker)
      .map((p) => p.index);
    if (unresolved.length > 0 && knownNames.length > 0) {
      const llmResult = await attributeByLLM({
        paragraphs,
        unresolvedIndices: unresolved,
        knownNames,
        characterContext,
        parserOut,
        regexOut,
      });
      llmOut = llmResult.map;
      llmFailures = llmResult.failedBatches;
      llmRequested = llmResult.requested;
    }
  }

  // 8. Re-run stateful fusion with LLM as one more evidence source + persist.
  const merged = attributeByConversation({
    paragraphs,
    characters: characterContext,
    parserOut,
    regexOut,
    llmOut,
  });
  try {
    await setCachedAttribution(
      params.id, chapterIndex, merged, mtime, ATTRIBUTION_VERSION_LLM,
    );
  } catch (e) {
    console.error('[attribute/analyze] cache write failed:', e);
  }

  // 9. Stats.
  const baseStats = computeStats(paragraphs, merged);

  return NextResponse.json({
    parserVersion: ATTRIBUTION_VERSION_LLM,
    fromCache: false,
    parserReachable,
    omlxReachable,
    chapter: { chapterIndex, chapterId: params.chapterId, file: epub.htmlFiles[chapterIndex] },
    attribution: merged,
    stats: {
      ...baseStats,
      llmFailures,
      llmRequested,
    },
  });
}

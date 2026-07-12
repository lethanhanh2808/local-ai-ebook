// src/app/api/library/[id]/chapters/[chapterId]/attribute/route.ts
//
// GET /api/library/[id]/chapters/[chapterId]/attribute
//
// Per-paragraph speaker attribution for a chapter. Cheap, cache-first call
// used by the reader on every chapter change. Runs regex evidence + a stateful
// conversation pass (NOT the LLM — that's the /analyze route).
//
// Layers (shared from `@/lib/attribution`):
//   1. Regex evidence   — existing local speech-verb/name matcher.
//   2. Conversation     — scene memory, active participants, turn history,
//                         event timeline and weighted confidence fusion.
//   3. Default voice    — null speaker for paragraphs nothing could resolve.
//
// Results are persisted in `ChapterAttribution` keyed by chapter file mtime,
// so re-opening the same chapter is O(1) until the HTML is regenerated.
//
// Response shape:
//   {
//     parserVersion: "conversation-v3",
//     fromCache: bool,
//     omlxReachable: false,        // GET route never runs the LLM
//     chapter: { chapterIndex, chapterId, file } | null,
//     attribution: {
//       [paragraphIndex: number]: {
//         speaker: string | null,
//         confidence: number,        // 0..1
//         source: 'regex'|'default',
//       }
//     },
//     stats: { regexHits: n, llmHits: 0, defaults: n, ... }
//   }
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { listCharacters } from '@/lib/db/voices';
import {
  getOrComputeAttribution,
} from '@/lib/db/chapter-attribution';
import {
  ATTRIBUTION_VERSION,
  attributeByConversation,
  attributeByRegex,
  computeStats,
  sliceParagraphs,
} from '@/lib/attribution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ── Main handler ─────────────────────────────────────────────────────────
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> }
) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  // 1. Pull chapter HTML (re-uses existing route so watermarks/dedup apply).
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
      omlxReachable: false,
      chapter: null,
      attribution: {},
      stats: { regexHits: 0, llmHits: 0, defaults: 0, totalParagraphs: 0 },
    });
  }

  // 2. Resolve chapterIndex (0-based offset in htmlFiles).
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

  // 3. mtime of the source file (cache invalidation).
  let mtime = 0;
  try {
    const stat = fs.statSync(filePath);
    mtime = Math.floor(stat.mtimeMs);
  } catch { /* keep 0 → cache will be skipped */ }

  // 4. Load characters (name + aliases + gender) for pronoun/name resolution.
  const chars = await listCharacters(params.id);
  const knownNames = chars.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const characterContext = chars.map((c) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    gender: c.gender ?? null,
  }));

  // 5. Slice the HTML into paragraphs that match what EbookReader displays.
  const paragraphs = sliceParagraphs(html);

  // 6. Read-through cache. The computeFn runs the regex pipeline
  //    (no LLM — that's the /analyze route).
  const { payload, fromCache } = await getOrComputeAttribution(
    params.id,
    chapterIndex,
    mtime,
    async () => {
      const regexOut = attributeByRegex(paragraphs, knownNames);
      return attributeByConversation({
        paragraphs,
        characters: characterContext,
        regexOut,
      });
    },
    ATTRIBUTION_VERSION,
  );

  const stats = computeStats(paragraphs, payload);

  return NextResponse.json({
    parserVersion: ATTRIBUTION_VERSION,
    fromCache,
    omlxReachable: false,  // GET route never invokes the LLM
    chapter: { chapterIndex, chapterId: params.chapterId, file: epub.htmlFiles[chapterIndex] },
    attribution: payload,
    stats,
  });
}

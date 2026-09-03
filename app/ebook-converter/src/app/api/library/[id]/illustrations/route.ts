// src/app/api/library/[id]/illustrations/route.ts
//
// Generate AI illustrations for "highlight" chapters of a book.
//
// Workflow:
//   1. GET  /api/library/[id]/illustrations        → list existing illustrations
//   2. POST /api/library/[id]/illustrations/analyze → AI analyzes each chapter
//                          and decides which to illustrate (returns a plan)
//   3. POST /api/library/[id]/illustrations/generate → for each "should illustrate"
//                          chapter, AI scores + generates image + saves to disk
//
// Images are stored as:  data/illustrations/<bookId>/chapter-<idx>.png
// Each illustration row in the DB tracks: chapter title, prompt, file path, AI metadata.

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db/client';
import { getBook } from '@/lib/db/books';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { getEffectiveSettings } from '@/lib/db/settings';
import { generateImage, analyzeChapterForIllustration, characterSeed, normalizeImageStyle } from '@/lib/ai/image-generator';
import { resolveBookPath } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ILLUSTRATIONS_DIR = path.resolve(process.cwd(), 'data/illustrations');

// ── Quick-skip heuristics ──────────────────────────────────────────────
// Detect chapters that are obviously non-story (empty body, cover,
// copyright page, TOC, prologue metadata, ...) BEFORE we spend an LLM
// call on them. Saves ~5-10% of analyzer calls on real Vietnamese
// novels and avoids sending garbage prompts that just get rejected.

/** Title patterns for known non-story chapters. Case-insensitive,
 *  diacritic-tolerant via toLowerCase + unicode-aware match. */
const NON_STORY_TITLE_PATTERNS: readonly RegExp[] = [
  /^(cover|bìa|trang bìa)$/i,
  /^(mục lục|table of contents)$/i,
  /^(lời mở đầu|lời giới thiệu|lời tựa|lời nói đầu|lời dẫn|prologue|foreword|preface)$/i,
  /^(giới thiệu|introduction)$/i,
  /^(tác giả|author|about the author|về tác giả)$/i,
  /^(bản quyền|copyright|copy right)$/i,
  /^(lời cảm ơn|acknowledg(e|ment)s)$/i,
  /^(phụ lục|appendix)$/i,
  /^(chương\s*0|chapter\s*0)$/i,
];

/** Plain-text body length threshold below which a chapter is treated
 *  as effectively empty. 200 chars is roughly one paragraph; anything
 *  shorter is unlikely to contain a describable scene. */
const MIN_BODY_CHARS = 200;

/** Cheap server-side filter: returns a reason string if the chapter
 *  should be skipped without an LLM call, or null if it's worth
 *  sending to the analyzer. Pure function — no I/O. */
function quickSkipReason(title: string, bodyHtml: string): string | null {
  // 1. Empty body
  const plainLen = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if (plainLen < MIN_BODY_CHARS) {
    return `Chương trống hoặc quá ngắn (${plainLen} ký tự) — không thể minh họa.`;
  }
  // 2. Known non-story title patterns
  const t = title.trim();
  for (const re of NON_STORY_TITLE_PATTERNS) {
    if (re.test(t)) {
      return `Chương không chứa nội dung truyện (${t}) — bỏ qua.`;
    }
  }
  return null;
}

/** Decide which chapter indices to actually analyze for a generate
 *  request. Honors `onlyMissing` (skip already-illustrated chapters)
 *  and `chapterIndices` (caller-specified subset). Returns the
 *  filtered set plus the count skipped. */
async function selectChaptersForGenerate(
  bookId: string,
  chapters: Array<{ index: number; title: string; bodyText: string }>,
  body: { chapterIndices?: number[]; onlyMissing?: boolean },
): Promise<{ selected: typeof chapters; skippedExisting: number }> {
  let pool = chapters;
  if (body.chapterIndices) {
    pool = pool.filter((ch) => body.chapterIndices!.includes(ch.index));
  }
  if (body.onlyMissing) {
    const existing = await prisma.illustration.findMany({
      where: { bookId },
      select: { chapterIndex: true },
    });
    const taken = new Set(existing.map((r) => r.chapterIndex));
    pool = pool.filter((ch) => !taken.has(ch.index));
    return { selected: pool, skippedExisting: taken.size };
  }
  return { selected: pool, skippedExisting: 0 };
}

// ── GET: list existing illustrations for a book ────────────────────────
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const illustrations = await prisma.illustration.findMany({
    where: { bookId: params.id },
    orderBy: { chapterIndex: 'asc' },
  });
  return NextResponse.json({ illustrations });
}

// ── POST: analyze = AI reviews each chapter, returns the plan only ──────
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const settings = await getEffectiveSettings();
  if (settings.imageProvider === 'none') {
    return NextResponse.json({ error: 'Image generation is disabled in settings' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({})) as {
    action?: 'analyze' | 'generate';
    maxPerBook?: number;
    /** If provided, only analyze/generate for these chapter indices. */
    chapterIndices?: number[];
    /** If true, use a RANDOM seed instead of the deterministic
     *  per-character seed. Useful when the user wants a fresh take
     *  on a chapter without losing the locked prompt wording. */
    reroll?: boolean;
    /** If true, skip chapters that already have an Illustration row.
     *  Lets users fill gaps without overwriting existing ones. The
     *  `chapterIndices` filter is applied first; `onlyMissing` then
     *  subtracts the rest. */
    onlyMissing?: boolean;
  };

  // Parse the EPUB once
  const bookPath = await resolveBookPath(book);
  if (!fs.existsSync(bookPath)) {
    return NextResponse.json({ error: 'Book file not found on disk' }, { status: 404 });
  }
  const epub = await parseEpub(bookPath);

  // Strip <body> from each chapter file → plain text-ish body
  const chapters: Array<{ index: number; title: string; bodyText: string }> = [];
  for (let i = 0; i < epub.htmlFiles.length; i++) {
    const file = epub.htmlFiles[i];
    const html = epub.entries.get(file)?.data.toString('utf8') ?? '';
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const body = bodyMatch ? bodyMatch[1] : html;
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Chapter ${i + 1}`;
    chapters.push({ index: i, title, bodyText: body });
  }

  // Look up character visual anchors once. Wrapped in try so a transient
  // DB error doesn't break illustration generation entirely — the
  // analyzer just won't get the cast hint for this run.
  let cast: import('@/lib/ai/image-generator').CastMember[] = [];
  try {
    const charRows = await prisma.character.findMany({
      where: { bookId: params.id },
      include: { profile: { select: { visualDescription: true } } },
    });
    cast = charRows
      .filter((c) => c.profile?.visualDescription)
      .map((c) => ({ name: c.name, visualDescription: c.profile!.visualDescription }));
  } catch (err) {
    console.warn(`[illustrations] character cast lookup failed for ${params.id}:`, err);
  }

  if (body.action === 'analyze') {
    const analyses = [];
    for (const ch of chapters) {
      if (body.chapterIndices && !body.chapterIndices.includes(ch.index)) continue;
      // Skip non-story chapters BEFORE the LLM call — saves a network
      // round trip and avoids sending garbage that the model can't help
      // with anyway. We still emit a row so the caller sees the chapter
      // was considered.
      const skipReason = quickSkipReason(ch.title, ch.bodyText);
      if (skipReason) {
        analyses.push({
          chapterIndex: ch.index, chapterTitle: ch.title,
          shouldIllustrate: false, confidence: 1,
          reason: skipReason,
        });
        continue;
      }
      try {
        const result = await analyzeChapterForIllustration(ch.title, ch.bodyText, {
          title: book.title, author: book.author, language: book.language,
          // Pass description so detectGenre() can disambiguate ambiguous
          // titles (e.g. "Tu Tiên Trở Về" (modern) vs "Phàm Nhân Tu Tiên"
          // (cultivation)) and seed chapter illustrations with the right
          // art direction.
          description: book.description ?? null,
        }, cast);
        analyses.push({ chapterIndex: ch.index, chapterTitle: ch.title, ...result });
      } catch (err) {
        analyses.push({
          chapterIndex: ch.index, chapterTitle: ch.title,
          shouldIllustrate: false, confidence: 0,
          reason: `AI error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return NextResponse.json({ analyses });
  }

  if (body.action === 'generate') {
    const maxPerBook = body.maxPerBook ?? settings.imageMaxPerBook ?? 6;
    const bookDir = path.join(ILLUSTRATIONS_DIR, params.id);
    fs.mkdirSync(bookDir, { recursive: true });

    // Whether to bypass the per-character deterministic seed. By default
    // (reroll=false) the SAME character + same chapter + same book always
    // gets the SAME seed → same noise → near-identical images across
    // regenerations; this is the lever for character consistency. When
    // the user explicitly wants a fresh take they pass reroll=true.
    const useStableSeed = body.reroll !== true;
    // Resolve style once per request so it can be normalised + coerced.
    const resolvedStyle = normalizeImageStyle(settings.imageStyle);

    // Filter the chapter pool first (chapterIndices + onlyMissing), then
    // skip obviously-non-story chapters BEFORE the LLM round-trip. For
    // a 100-chapter Vietnamese novel this typically saves 5-10 LLM calls.
    const { selected: chapterPool, skippedExisting } = await selectChaptersForGenerate(
      params.id, chapters, body,
    );

    // ── Fast path: reroll a single already-illustrated chapter ─────────
    // The prompt + character anchor are already stored in the Illustration
    // row. Re-running the analyzer would burn an LLM call just to emit the
    // same scene description again. Skip straight to image generation with
    // a fresh random seed — the user wanted a NEW composition, not a new
    // prompt.
    if (body.reroll === true && body.chapterIndices && body.chapterIndices.length > 0) {
      const rerollResults: typeof results = [];
      for (const idx of body.chapterIndices) {
        const existing = await prisma.illustration.findUnique({
          where: { bookId_chapterIndex: { bookId: params.id, chapterIndex: idx } },
        });
        if (!existing || !existing.prompt) {
          rerollResults.push({
            chapterIndex: idx,
            chapterTitle: chapters.find((c) => c.index === idx)?.title ?? `Chapter ${idx + 1}`,
            ok: false,
            reason: 'Reroll requested but no existing illustration to regenerate',
          });
          continue;
        }
        try {
          const seed = Math.floor(Math.random() * 0x7fffffff) + 1;
          const img = await generateImage({
            prompt: existing.prompt,
            style: resolvedStyle,
            size: '1024x1792',
            seed,
          });
          // Save the new bytes (same on-disk filename, overwriting).
          let ext = 'png';
          let buf: Buffer;
          if (img.b64) {
            buf = Buffer.from(img.b64, 'base64');
            if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
          } else {
            const fetched = await fetch(img.url);
            buf = Buffer.from(await fetched.arrayBuffer());
            if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
          }
          const imagePath = existing.imagePath.replace(/\.(png|jpg)$/i, `.${ext}`);
          fs.writeFileSync(imagePath, buf);
          await prisma.illustration.update({
            where: { id: existing.id },
            data: { imagePath, imageModel: img.model, updatedAt: new Date() },
          });
          rerollResults.push({
            chapterIndex: idx, chapterTitle: existing.chapterTitle,
            ok: true, imagePath, prompt: existing.prompt, seed,
          });
        } catch (err) {
          rerollResults.push({
            chapterIndex: idx, chapterTitle: existing.chapterTitle, ok: false,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return NextResponse.json({
        generated: rerollResults.filter((r) => r.ok).length,
        failed: rerollResults.filter((r) => !r.ok).length,
        results: rerollResults,
        mode: 'reroll',
      });
    }

    // First, run analyze on the filtered pool to find candidates.
    const analyses: Array<{ chapterIndex: number; chapterTitle: string; shouldIllustrate: boolean; confidence: number; prompt?: string; reason?: string }> = [];
    for (const ch of chapterPool) {
      const skipReason = quickSkipReason(ch.title, ch.bodyText);
      if (skipReason) {
        analyses.push({
          chapterIndex: ch.index, chapterTitle: ch.title,
          shouldIllustrate: false, confidence: 1,
          reason: skipReason,
        });
        continue;
      }
      try {
        const result = await analyzeChapterForIllustration(ch.title, ch.bodyText, {
          title: book.title, author: book.author, language: book.language,
          // Pass description so detectGenre() can disambiguate ambiguous
          // titles (e.g. "Tu Tiên Trở Về" (modern) vs "Phàm Nhân Tu Tiên"
          // (cultivation)) and seed chapter illustrations with the right
          // art direction.
          description: book.description ?? null,
        }, cast);
        analyses.push({ chapterIndex: ch.index, chapterTitle: ch.title, ...result });
      } catch (err) {
        // skip on error
      }
    }

    // Rank by confidence, take top N that shouldIllustrate. If onlyMissing
    // was set the pool is already filtered; otherwise we trust the LLM's
    // top-N ranking to pick the strongest scenes.
    const candidates = analyses
      .filter((a) => a.shouldIllustrate && a.prompt)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxPerBook);

    const results: Array<{
      chapterIndex: number; chapterTitle: string; ok: boolean;
      imagePath?: string; prompt?: string; reason?: string; seed?: number;
    }> = [];

    for (const cand of candidates) {
      try {
        // Pick the first cast member with a description as the seed anchor
        // for this chapter. Fall back to a chapter-only seed if no character
        // has a description (book without character bible).
        const anchorName = cast[0]?.name ?? `chapter-${cand.chapterIndex}`;
        const seed = useStableSeed
          ? characterSeed(params.id, cand.chapterIndex, anchorName)
          : Math.floor(Math.random() * 0x7fffffff) + 1;
        const img = await generateImage({
          prompt: cand.prompt!,
          style: resolvedStyle,
          // Default to portrait (1024x1792) — fits Vietnamese-novel reader
          // layouts (vertical reading, portrait-first devices like Onyx Boox
          // and Kobo Aura). Square 1024x1024 looked out-of-register on the
          // top-of-chapter preview spot.
          size: '1024x1792',
          seed,
        });

        let imagePath: string;
        // MiniMax returns JPEG bytes; OpenAI DALL-E 3 returns PNG bytes.
        // We sniff the magic bytes instead of trusting the file extension
        // so the on-disk filename matches the actual format (browsers handle
        // mismatched Content-Type, but correct ext helps file managers /
        // e-ink reader-side tools that ignore headers).
        let ext = 'png';
        if (img.b64) {
          const buf = Buffer.from(img.b64, 'base64');
          // PNG magic: 89 50 4E 47 ; JPEG magic: FF D8 FF
          if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
          imagePath = path.join(bookDir, `chapter-${String(cand.chapterIndex).padStart(3, '0')}.${ext}`);
          fs.writeFileSync(imagePath, buf);
        } else {
          // Some providers return a URL instead of b64 — fetch and save
          const fetched = await fetch(img.url);
          const buf = Buffer.from(await fetched.arrayBuffer());
          if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
          imagePath = path.join(bookDir, `chapter-${String(cand.chapterIndex).padStart(3, '0')}.${ext}`);
          fs.writeFileSync(imagePath, buf);
        }

        // Upsert into DB
        await prisma.illustration.upsert({
          where: { bookId_chapterIndex: { bookId: params.id, chapterIndex: cand.chapterIndex } },
          create: {
            bookId: params.id,
            chapterIndex: cand.chapterIndex,
            chapterTitle: cand.chapterTitle,
            prompt: cand.prompt!,
            imagePath,
            imageModel: img.model,
          },
          update: {
            chapterTitle: cand.chapterTitle,
            prompt: cand.prompt!,
            imagePath,
            imageModel: img.model,
            updatedAt: new Date(),
          },
        });

        results.push({ chapterIndex: cand.chapterIndex, chapterTitle: cand.chapterTitle, ok: true, imagePath, prompt: cand.prompt, seed });
      } catch (err) {
        results.push({
          chapterIndex: cand.chapterIndex, chapterTitle: cand.chapterTitle, ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      generated: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
      analyzed: analyses.length,
      skippedExisting,  // chapters skipped via onlyMissing (already illustrated)
      mode: 'generate',
    });
  }

  return NextResponse.json({ error: 'action must be "analyze" or "generate"' }, { status: 400 });
}

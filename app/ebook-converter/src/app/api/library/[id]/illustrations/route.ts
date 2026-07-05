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
import { getSettings } from '@/lib/db/settings';
import { generateImage, analyzeChapterForIllustration } from '@/lib/ai/image-generator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ILLUSTRATIONS_DIR = path.resolve(process.cwd(), 'data/illustrations');

// ── GET: list existing illustrations for a book ────────────────────────
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const illustrations = await prisma.illustration.findMany({
    where: { bookId: params.id },
    orderBy: { chapterIndex: 'asc' },
  });
  return NextResponse.json({ illustrations });
}

// ── POST: analyze = AI reviews each chapter, returns the plan only ──────
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const settings = await getSettings();
  if (settings.imageProvider === 'none') {
    return NextResponse.json({ error: 'Image generation is disabled in settings' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({})) as {
    action?: 'analyze' | 'generate';
    maxPerBook?: number;
    /** If provided, only analyze/generate for these chapter indices. */
    chapterIndices?: number[];
  };

  // Parse the EPUB once
  const epub = await parseEpub(book.filePath);

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

  if (body.action === 'analyze') {
    const analyses = [];
    for (const ch of chapters) {
      if (body.chapterIndices && !body.chapterIndices.includes(ch.index)) continue;
      try {
        const result = await analyzeChapterForIllustration(ch.title, ch.bodyText, {
          title: book.title, author: book.author, language: book.language,
        });
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

    // First, run analyze on all chapters to find candidates
    const analyses: Array<{ chapterIndex: number; chapterTitle: string; shouldIllustrate: boolean; confidence: number; prompt?: string; reason?: string }> = [];
    for (const ch of chapters) {
      if (body.chapterIndices && !body.chapterIndices.includes(ch.index)) continue;
      try {
        const result = await analyzeChapterForIllustration(ch.title, ch.bodyText, {
          title: book.title, author: book.author, language: book.language,
        });
        analyses.push({ chapterIndex: ch.index, chapterTitle: ch.title, ...result });
      } catch (err) {
        // skip on error
      }
    }

    // Rank by confidence, take top N that shouldIllustrate
    const candidates = analyses
      .filter((a) => a.shouldIllustrate && a.prompt)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxPerBook);

    const results: Array<{
      chapterIndex: number; chapterTitle: string; ok: boolean;
      imagePath?: string; prompt?: string; reason?: string;
    }> = [];

    for (const cand of candidates) {
      try {
        const img = await generateImage({
          prompt: cand.prompt!,
          style: settings.imageStyle as 'ink' | 'manga' | 'sketch' | 'watercolor' | 'none',
          size: '1024x1024',
        });

        let imagePath: string;
        if (img.b64) {
          const buf = Buffer.from(img.b64, 'base64');
          imagePath = path.join(bookDir, `chapter-${String(cand.chapterIndex).padStart(3, '0')}.png`);
          fs.writeFileSync(imagePath, buf);
        } else {
          // Some providers return a URL instead of b64 — fetch and save
          const fetched = await fetch(img.url);
          const buf = Buffer.from(await fetched.arrayBuffer());
          imagePath = path.join(bookDir, `chapter-${String(cand.chapterIndex).padStart(3, '0')}.png`);
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

        results.push({ chapterIndex: cand.chapterIndex, chapterTitle: cand.chapterTitle, ok: true, imagePath, prompt: cand.prompt });
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
    });
  }

  return NextResponse.json({ error: 'action must be "analyze" or "generate"' }, { status: 400 });
}
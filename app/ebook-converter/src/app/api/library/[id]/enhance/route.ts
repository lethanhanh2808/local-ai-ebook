// POST /api/library/[id]/enhance
// AI-enhance all chapters of an existing library book.
// Creates a NEW book entry with the same title + " - AI Edited" suffix.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { getBook, createBook } from '@/lib/db/books';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { buildEpub } from '@/lib/pipeline/epub-builder';
import { buildChapterHtml, extractChapterBodyFragment } from '@/lib/pipeline/epub-styler';
import { enhanceChaptersParallel } from '@/lib/ai/chapter-enhancer';
import { libraryPath, coverPath, ensureDirs, resolveBookPath, resolveCoverPath } from '@/lib/storage';
import { extractCoverFromEpub } from '@/lib/pipeline/epub-cover';
import { auditMinimalPairs } from '@/lib/vi-text-qa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const bookPath = await resolveBookPath(book);
  if (!fs.existsSync(bookPath)) {
    return NextResponse.json({ error: 'Book file not found on disk' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({})) as { customPrompt?: string };
  const customPrompt = body.customPrompt?.trim().slice(0, 8_000) || undefined;

  try {
    // Parse the existing epub
    const epub = await parseEpub(bookPath);

    // Extract chapter bodies from the epub's HTML files
    const chapterInputs: Array<{ id: string; title: string; bodyHtml: string }> = [];
    const tocMap = new Map<string, string>();
    for (const entry of epub.tocEntries) {
      tocMap.set(path.basename(entry.src), entry.title);
      tocMap.set(entry.src, entry.title);
    }

    epub.htmlFiles.forEach((file, i) => {
      const raw = epub.entries.get(file)?.data.toString('utf8') ?? '';
      const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const rawBodyHtml = bodyMatch ? bodyMatch[1] : raw;
      const headingMatch = rawBodyHtml.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      const title =
        tocMap.get(file) ??
        tocMap.get(path.basename(file)) ??
        (headingMatch ? headingMatch[1].replace(/<[^>]+>/g, '').trim() : null) ??
        `Chapter ${i + 1}`;
      const bodyHtml = extractChapterBodyFragment(rawBodyHtml, title);
      chapterInputs.push({ id: `chapter${String(i + 1).padStart(3, '0')}`, title, bodyHtml });
    });

    if (chapterInputs.length === 0) {
      return NextResponse.json({ error: 'No chapters found in this book' }, { status: 400 });
    }

    // Run AI enhancement
    const enhanced = await enhanceChaptersParallel(
      chapterInputs.map(({ id, bodyHtml }) => ({ id, bodyHtml })),
      customPrompt,
      book.language,
    );

    // Vietnamese text QA: detect minimal-pair collapses in enhanced chapters.
    // Surfaces as warnings on the response — does NOT block the enhance.
    const qaWarnings: Array<{
      chapterId: string;
      chapterTitle: string;
      minimalPairs: ReturnType<typeof auditMinimalPairs>;
    }> = [];
    if (book.language === 'vi') {
      for (const ch of chapterInputs) {
        const enhancedHtml = enhanced.get(ch.id) ?? ch.bodyHtml;
        // Strip HTML tags so we audit the visible text, not markup
        const plain = enhancedHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const findings = auditMinimalPairs(plain);
        if (findings.length > 0) {
          qaWarnings.push({
            chapterId: ch.id,
            chapterTitle: ch.title,
            minimalPairs: findings,
          });
        }
      }
    }

    // Build chapter entries
    const fontDir = path.resolve(process.cwd(), 'public/assets/fonts');
    const fontPaths: Record<string, string> = {};
    for (const f of ['Literata-Regular.ttf', 'Literata-Italic.ttf', 'Literata-Bold.ttf', 'Literata-BoldItalic.ttf']) {
      const fp = path.join(fontDir, f);
      if (fs.existsSync(fp)) fontPaths[f] = fp;
    }

    const chapters = chapterInputs.map((ch) => {
      const enhancedBody = enhanced.get(ch.id) ?? ch.bodyHtml;
      return {
        id: ch.id,
        title: ch.title,
        filename: `${ch.id}.xhtml`,
        html: buildChapterHtml({ id: ch.id, title: ch.title, body: enhancedBody, lang: book.language }),
      };
    });

    // Write output epub
    ensureDirs();
    const newBookId = uuid();
    const outputFile = libraryPath(newBookId);

    await buildEpub(
      {
        title: book.title,
        author: book.author,
        language: book.language,
        description: book.description ?? '',
        chapters,
        fontPaths,
      },
      outputFile,
    );

    const fileSize = fs.statSync(outputFile).size;

    // Extract cover
    let cover: string | undefined;
    try {
      const coverDest = coverPath(newBookId);
      const extracted = await extractCoverFromEpub(outputFile, coverDest);
      if (extracted) cover = coverDest;
      else {
        const sourceCover = await resolveCoverPath(book);
        if (sourceCover) {
        // Copy original cover
        const ext = path.extname(sourceCover);
        cover = coverPath(newBookId).replace(/\.[^.]+$/, ext);
        fs.copyFileSync(sourceCover, cover);
        }
      }
    } catch { /* ok */ }

    // Create new book record
    const aiSuffix = ' - AI Edited';
    const newTitle = book.title.endsWith(aiSuffix) ? book.title : book.title + aiSuffix;
    const originalName = book.originalFilename.replace(/(\.[^.]+)$/, `${aiSuffix}$1`);

    const newBook = await createBook({
      id: newBookId,
      title:            newTitle,
      author:           book.author,
      language:         book.language,
      description:      book.description ?? undefined,
      publisher:        book.publisher ?? undefined,
      coverPath:        cover,
      filePath:         outputFile,
      fileSize,
      originalFilename: originalName,
      tags:             book.tags,
    });

    return NextResponse.json(
      { ...newBook, qaWarnings: qaWarnings.length > 0 ? qaWarnings : undefined },
      { status: 201 },
    );
  } catch (err) {
    console.error('[enhance]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

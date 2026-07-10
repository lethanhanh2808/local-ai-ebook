// POST /api/library/[id]/cover/generate
// 1. Try to extract existing cover from EPUB
// 2. Otherwise, generate a beautiful AI-powered cover (background + elegant typography)
// 3. Falls back to SVG-only generation if AI is disabled
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { getBook, updateBook } from '@/lib/db/books';
import { extractCoverFromEpub } from '@/lib/pipeline/epub-cover';
import { coverPath } from '@/lib/storage';
import { generateAIBookCover } from '@/lib/covers/ai-generate-cover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const destBase = coverPath(book.id);

  // 1. Try to extract existing cover from the EPUB
  if (book.filePath && fs.existsSync(book.filePath)) {
    try {
      const extracted = await extractCoverFromEpub(book.filePath, destBase);
      if (extracted) {
        const exts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        for (const ext of exts) {
          const p = destBase.replace(/\.[^.]+$/, `.${ext}`);
          if (fs.existsSync(p)) { await updateBook(book.id, { coverPath: p }); break; }
        }
        return NextResponse.json({ ok: true, type: 'extracted' });
      }
    } catch { /* fall through to generation */ }
  }

  // 2. Generate cover — AI background (if enabled) + elegant title typography.
  //     The title on the bìa is the user's Vietnamese version when set,
  //     otherwise the book's stored title (which is already Vietnamese for
  //     native-VN imports). This guarantees the printed text is always
  //     Vietnamese — even if the imported `title` is in another language
  //     (e.g. Chinese for translated novels).
  try {
    const result = await generateAIBookCover({
      title: book.titleVi ?? book.title,
      author: book.author,
      language: book.language,
      series: book.series,
      seriesIndex: book.seriesIndex ?? undefined,
      description: book.description,
    });

    const pngPath = destBase.replace(/\.[^.]+$/, '.png');
    fs.mkdirSync(path.dirname(pngPath), { recursive: true });
    fs.writeFileSync(pngPath, result.buffer);
    await updateBook(book.id, { coverPath: pngPath });
    return NextResponse.json({
      ok: true,
      type: result.source === 'ai' ? 'ai' : 'generated',
      source: result.source,
      design: { style: result.design.style, accent: result.design.accent, background: result.design.background },
      durationMs: result.durationMs,
    });
  } catch (err) {
    console.error('[cover/generate]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
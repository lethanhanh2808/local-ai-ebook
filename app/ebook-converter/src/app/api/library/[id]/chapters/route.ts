// GET /api/library/[id]/chapters – list chapters from the stored EPUB
import { NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { resolveBookPath } from '@/lib/storage';
import fs from 'fs';
import path from 'path';

/** Extract plain-text title from first heading in an HTML body */
function extractH1(html: string): string | null {
  const m = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim() || null;
}

/** True if a file looks like a cover/image-only page (no meaningful text) */
function isCoverPage(file: string): boolean {
  return /cover/i.test(path.basename(file, path.extname(file)));
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const filePath = await resolveBookPath(book);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  try {
    const epub = await parseEpub(filePath);

    // Build O(1) lookup maps for TOC matching
    const tocByBasename = new Map(epub.tocEntries.map((e) => [path.basename(e.src), e.title]));
    const tocByFullPath = new Map(epub.tocEntries.map((e) => [e.src, e.title]));

    let chapterOrder = 0;
    const chapters = epub.htmlFiles.map((file, i) => {
      const basename = path.basename(file, path.extname(file));

      // 1. Try TOC match
      let title: string =
        tocByFullPath.get(file) ??
        tocByBasename.get(path.basename(file)) ??
        '';

      // 2. Try H1 extraction from body HTML
      if (!title) {
        const entry = epub.entries.get(file);
        if (entry) {
          const raw = entry.data.toString('utf8');
          const bodyM = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          const body = bodyM ? bodyM[1] : raw;
          title = extractH1(body) ?? '';
        }
      }

      // 3. Final fallback
      if (!title) {
        title = isCoverPage(file) ? 'Cover' : `Chapter ${i + 1}`;
      }

      // Only increment chapter order for non-cover pages
      if (!isCoverPage(file)) chapterOrder++;

      return { id: basename, title, order: i + 1, file };
    });

    return NextResponse.json(chapters);
  } catch (err) {
    console.error('[chapters] parse error', err);
    return NextResponse.json({ error: 'Failed to read EPUB' }, { status: 500 });
  }
}

// GET /api/library/[id]/chapters – list chapters from the stored EPUB
//
// Returns the reading chapter list with non-reading EPUB files (cover,
// nav.xhtml, toc.ncx, Mục lục auto-page) filtered out. The reader UI
// renders its own Mục lục panel from this list, so we don't need to expose
// the EPUB's native nav.xhtml as a clickable chapter — it would render
// as a thin link list with broken relative URLs.
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

/**
 * True if this HTML file is the EPUB's auto-generated navigation page
 * (nav.xhtml in EPUB3, or a page titled "Mục lục" / "Table of Contents").
 * The reader renders its own TOC sidebar so exposing these as clickable
 * chapters just produces a confusing link-list inside the iframe.
 */
function isNavPage(file: string, bodyHtml: string | null): boolean {
  const basename = path.basename(file).toLowerCase();
  if (basename === 'nav.xhtml' || basename === 'toc.ncx') return true;
  if (bodyHtml) {
    const h1 = extractH1(bodyHtml);
    if (h1) {
      const t = h1.toLowerCase();
      if (t === 'mục lục' || t === 'table of contents' || t === 'contents' || t === 'muc luc') return true;
    }
  }
  return false;
}

/**
 * Heuristic for "this file has so little text it isn't a real chapter" —
 * cover pages, half-title pages, copyright pages, blank pages, etc. We
 * expose them only via the optional /cover endpoint, never as a
 * clickable chapter in the TOC sidebar.
 */
function isProbablyNotChapter(file: string, bodyHtml: string | null): boolean {
  if (isCoverPage(file)) return true;
  if (!bodyHtml) return false;
  // Strip HTML tags and count non-whitespace characters
  const text = bodyHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
  return text.length < 80;
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
    const chapters: Array<{ id: string; title: string; order: number; file: string }> = [];
    for (const file of epub.htmlFiles) {
      const basename = path.basename(file, path.extname(file));

      // Read body HTML once for filtering + title extraction.
      const entry = epub.entries.get(file);
      let bodyHtml: string | null = null;
      if (entry) {
        const raw = entry.data.toString('utf8');
        const bodyM = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        bodyHtml = bodyM ? bodyM[1] : raw;
      }

      // Skip nav pages (EPUB3 nav.xhtml, "Mục lục" heading) — the reader
      // has its own TOC sidebar built from this response.
      if (isNavPage(file, bodyHtml)) continue;

      // Skip empty / cover / front-matter pages — they have no body text
      // worth scrolling to and break the chapter numbering.
      if (isProbablyNotChapter(file, bodyHtml)) continue;

      // 1. Try TOC match
      let title: string =
        tocByFullPath.get(file) ??
        tocByBasename.get(path.basename(file)) ??
        '';

      // 2. Try H1 extraction from body HTML
      if (!title && bodyHtml) {
        title = extractH1(bodyHtml) ?? '';
      }

      // 3. Final fallback
      if (!title) {
        title = `Chapter ${chapterOrder + 1}`;
      }

      chapterOrder++;
      chapters.push({ id: basename, title, order: chapterOrder, file });
    }

    return NextResponse.json(chapters);
  } catch (err) {
    console.error('[chapters] parse error', err);
    return NextResponse.json({ error: 'Failed to read EPUB' }, { status: 500 });
  }
}
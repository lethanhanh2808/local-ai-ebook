// src/lib/voice-plan-loader.ts
//
// Shared helper for the voice-plan API routes. Kept out of the route file so it
// can be imported by both the GET/PUT route and the /suggest route without
// exporting a symbol from a Next.js route module (which breaks the generated
// route types).
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { resolveBookPath } from '@/lib/storage';
import { parseEpub } from '@/lib/pipeline/epub-parser';

export interface ChapterRef {
  chapterIndex: number;
  mtime: number;
  html: string;
}

export async function loadChapterRef(
  req: NextRequest,
  bookId: string,
  chapterId: string,
): Promise<ChapterRef | { error: string; status: number }> {
  const book = await getBook(bookId);
  if (!book) return { error: 'Book not found', status: 404 };

  const origin = req.nextUrl.origin;
  // Re-use the existing chapter route so watermarks/dedup apply.
  let html = '';
  try {
    const url = `${origin}/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}?raw=1`;
    const chapterResp = await fetch(url);
    if (chapterResp.ok) {
      const data = await chapterResp.json() as { html?: string };
      html = data.html ?? '';
    }
  } catch {
    html = '';
  }
  if (!html) return { error: 'Failed to load chapter HTML', status: 502 };

  const filePath = await resolveBookPath(book);
  if (!fs.existsSync(filePath)) return { error: 'EPUB file missing on disk', status: 404 };
  const epub = await parseEpub(filePath);
  const chapterIndex = epub.htmlFiles.findIndex(
    (f) => path.basename(f, path.extname(f)) === chapterId || path.basename(f) === chapterId,
  );
  if (chapterIndex < 0) return { error: 'Chapter not found in EPUB', status: 404 };

  let mtime = 0;
  try {
    mtime = Math.floor(fs.statSync(filePath).mtimeMs);
  } catch {
    mtime = 0;
  }
  return { chapterIndex, mtime, html };
}

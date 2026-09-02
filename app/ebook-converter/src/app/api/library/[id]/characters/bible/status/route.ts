// src/app/api/library/[id]/characters/bible/status/route.ts
// GET /api/library/:id/characters/bible/status
//
// Reports per-chapter analysis state so the UI can:
//   - render an "analyzed / not analyzed / failed" flag per chapter,
//   - compute which chapters remain for a "Continue analysis" run,
//   - show overall progress (analyzed / total).
//
// The chapter index space here is the SAME one refreshBible uses:
// the raw `epub.htmlFiles` index (NOT the filtered reading-chapter list),
// because BibleRefreshLog.chapterIndex is written with that index.
import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import { prisma } from '@/lib/db/client';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { resolveBookPath } from '@/lib/storage';
import fs from 'node:fs/promises';

export const dynamic = 'force-dynamic';

export interface BibleChapterStatus {
  chapterIndex: number;
  file: string;
  title: string | null;
  analyzed: boolean;
  status: string | null;       // BibleRefreshLog.status when present
  analyzedAt: string | null;
  lastError: string | null;
  charCount: number;
}

export interface BibleStatusResponse {
  bookId: string;
  totalChapters: number;
  analyzedCount: number;
  failedCount: number;
  pendingDiffCount: number;
  characterCount: number;
  chapters: BibleChapterStatus[];
}

function firstHeading(html: string): string | null {
  const m = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim() || null;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Load per-chapter logs + counts in parallel with parsing the EPUB.
  const [logs, pendingDiffCount, characterCount] = await Promise.all([
    prisma.bibleRefreshLog.findMany({
      where: { bookId: params.id },
      select: { chapterIndex: true, status: true, analyzedAt: true, lastError: true },
    }),
    prisma.pendingBibleDiff.count({ where: { bookId: params.id, status: 'pending' } }),
    prisma.character.count({ where: { bookId: params.id } }),
  ]);

  const logByIdx = new Map<number, (typeof logs)[number]>();
  for (const l of logs) logByIdx.set(l.chapterIndex, l);

  const chapters: BibleChapterStatus[] = [];
  let totalChapters = 0;

  try {
    const bookPath = await resolveBookPath(book);
    let ok = false;
    try { await fs.access(bookPath); ok = true; } catch { ok = false; }
    if (ok) {
      const epub = await parseEpub(bookPath);
      totalChapters = epub.htmlFiles.length;
      for (let i = 0; i < epub.htmlFiles.length; i++) {
        const file = epub.htmlFiles[i];
        const entry = epub.entries.get(file);
        const html = entry ? entry.data.toString('utf-8') : '';
        const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const log = logByIdx.get(i);
        chapters.push({
          chapterIndex: i,
          file,
          title: html ? firstHeading(html) : null,
          analyzed: !!log && log.status !== 'failed',
          status: log?.status ?? null,
          analyzedAt: log?.analyzedAt ? log.analyzedAt.toISOString() : null,
          lastError: log?.lastError ?? null,
          charCount: text.length,
        });
      }
    }
  } catch {
    // If the EPUB can't be parsed we still return the log-derived state.
    totalChapters = logs.length;
  }

  const analyzedCount = chapters.filter((c) => c.analyzed).length;
  const failedCount = chapters.filter((c) => c.status === 'failed').length;

  const body: BibleStatusResponse = {
    bookId: params.id,
    totalChapters,
    analyzedCount,
    failedCount,
    pendingDiffCount,
    characterCount,
    chapters,
  };
  return NextResponse.json(body);
}

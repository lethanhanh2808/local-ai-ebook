// GET  /api/library/[id]/watermarks        → detect watermark candidates
// POST /api/library/[id]/watermarks        → save confirmed watermarks { watermarks: string[] }
// DELETE /api/library/[id]/watermarks      → clear all watermarks

import { NextResponse, NextRequest } from 'next/server';
import { getBook, updateBookWatermarks, getBookWatermarks } from '@/lib/db/books';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { chat } from '@/lib/ai';  // unified AI client (routes by settings.aiProvider)
import fs from 'fs';
import path from 'path';

// ── Text extraction ────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract candidate phrases from a chapter's plain text */
function extractPhrases(text: string): Set<string> {
  const phrases = new Set<string>();
  // Split on sentence-ending punctuation or newlines
  const segments = text
    .split(/(?<=[.!?。！？\n])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 350);

  for (const seg of segments) {
    phrases.add(seg);
  }
  return phrases;
}

export interface WatermarkCandidate {
  text: string;
  count: number;
  percentage: number;
  confirmed?: boolean;
}

/** Core detection: find phrases repeated across many chapters */
async function detectCandidates(bookId: string): Promise<WatermarkCandidate[]> {
  const book = await getBook(bookId);
  if (!book) throw new Error('Book not found');
  if (!fs.existsSync(book.filePath)) throw new Error('EPUB file not found');

  const epub = await parseEpub(book.filePath);
  const totalChapters = epub.htmlFiles.length;
  if (totalChapters < 2) return []; // Can't detect with only 1 chapter

  // Collect all phrases per chapter
  const phraseToChapters = new Map<string, Set<number>>();

  for (let i = 0; i < epub.htmlFiles.length; i++) {
    const file = epub.htmlFiles[i];
    const entry = epub.entries.get(file);
    if (!entry) continue;
    const rawHtml = entry.data.toString('utf8');
    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : rawHtml;
    const text = htmlToText(bodyHtml);
    const phrases = extractPhrases(text);

    for (const phrase of phrases) {
      if (!phraseToChapters.has(phrase)) phraseToChapters.set(phrase, new Set());
      phraseToChapters.get(phrase)!.add(i);
    }
  }

  // Filter to candidates appearing in >= 25% of chapters (min 2)
  const minCount = Math.max(2, Math.floor(totalChapters * 0.25));

  const candidates: WatermarkCandidate[] = [];
  for (const [text, chapterSet] of phraseToChapters.entries()) {
    if (chapterSet.size >= minCount) {
      candidates.push({
        text,
        count: chapterSet.size,
        percentage: Math.round((chapterSet.size / totalChapters) * 100),
      });
    }
  }

  // Sort by frequency descending, keep top 25
  return candidates.sort((a, b) => b.count - a.count).slice(0, 25);
}

/** AI confirmation: ask LLM which candidates are watermarks */
async function aiConfirm(candidates: WatermarkCandidate[]): Promise<WatermarkCandidate[]> {
  if (candidates.length === 0) return [];

  const listText = candidates
    .map((c, i) => `${i + 1}. [${c.percentage}% of chapters] "${c.text}"`)
    .join('\n');

  const prompt = `You are a conservative ebook watermark classifier. Precision is more important than recall: a false positive would delete real book text.

The following phrases repeat across many chapters. Identify only phrases that are clearly WATERMARKS or PROMOTIONAL TEXT that should be removed, such as website URLs, "Read more at...", advertising text, download site references, uploader credits, or source-site notices.

Do NOT flag story content, chapter titles, subtitles, recurring narrative phrases, poems, epigraphs, letters, dialogue, or character catchphrases.

Candidates:
${listText}

Reply with ONLY a JSON array of the 1-based indices of confirmed watermarks. No prose, no markdown. Example: [1, 3, 7]
If none are watermarks, reply: []`;

  try {
    const reply = await chat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 256,
      timeoutMs: 30000,
    });

    const match = reply.match(/\[[\d,\s]*\]/);
    if (!match) return candidates.map((c) => ({ ...c, confirmed: false }));

    const confirmed = new Set<number>(JSON.parse(match[0]) as number[]);
    return candidates.map((c, i) => ({ ...c, confirmed: confirmed.has(i + 1) }));
  } catch {
    // If AI fails, mark all as unconfirmed and return
    return candidates.map((c) => ({ ...c, confirmed: false }));
  }
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const useAI = req.nextUrl.searchParams.get('ai') === 'true';
    const book = await getBook(params.id);
    if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    let candidates = await detectCandidates(params.id);

    if (useAI && candidates.length > 0) {
      candidates = await aiConfirm(candidates);
    }

    // Also return currently saved watermarks
    const saved = await getBookWatermarks(params.id);

    return NextResponse.json({ candidates, saved, totalChapters: candidates.length > 0 ? undefined : 0 });
  } catch (err) {
    console.error('[watermarks/GET]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = await req.json() as { watermarks: string[] };
    if (!Array.isArray(body.watermarks)) {
      return NextResponse.json({ error: 'watermarks must be an array' }, { status: 400 });
    }
    // Deduplicate and sanitise
    const cleaned = [...new Set(body.watermarks.map((w: string) => w.trim()).filter((w) => w.length > 0))];
    await updateBookWatermarks(params.id, cleaned);
    return NextResponse.json({ ok: true, saved: cleaned });
  } catch (err) {
    console.error('[watermarks/POST]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await updateBookWatermarks(params.id, []);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

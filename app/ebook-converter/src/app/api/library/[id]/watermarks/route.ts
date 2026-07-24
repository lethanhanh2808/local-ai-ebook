// GET    /api/library/[id]/watermarks?ai={true|false}  → detect watermark candidates
//                                       &all=true       → return all chapters' candidates
// POST   /api/library/[id]/watermarks  → save confirmed watermarks { watermarks: string[] }
// DELETE /api/library/[id]/watermarks  → clear all watermarks
//
// Implementation notes
// ────────────────────
// * Detection runs the SHARED tag-aware engine (`@/lib/pipeline/watermark-detect`).
//   Previously this route used a punctuation-splitter that silently missed
//   any DTV-style `<div class="header">…</div>` watermark — that's why the
//   Detect button felt broken even though the converter's auto-detect was
//   (almost) working. Both paths now share the same splitter + threshold
//   semantics.
// * AI confirmation is a thin wrapper over the unified `chat()` client —
//   any provider configured in /settings works (local OMLX, MiniMax Cloud,
//   OpenAI, custom OpenAI-compatible). When AI is unavailable or returns
//   unparseable output, we degrade gracefully to "all unconfirmed" so the
//   user can still pick by hand.
// * The response payload always includes `saved` (existing per-book phrases)
//   so the UI can pre-select candidates that are already memorised.

import { NextResponse, NextRequest } from 'next/server';
import { getBook, updateBookWatermarks, getBookWatermarks } from '@/lib/db/books';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { chat } from '@/lib/ai';
import {
  splitChapterIntoPhrases,
} from '@/lib/pipeline/watermark-detect';
import fs from 'fs';
import { resolveBookPath } from '@/lib/storage';

export interface WatermarkCandidate {
  text: string;
  count: number;
  percentage: number;
  confirmed?: boolean;
}

/** Aggregate candidate phrases across every chapter of the book. Returns
 *  candidate list + the chapter count used for the percentage display. */
async function detectCandidates(bookId: string): Promise<{ candidates: WatermarkCandidate[]; totalChapters: number }> {
  const book = await getBook(bookId);
  if (!book) throw new Error('Book not found');
  const bookPath = await resolveBookPath(book);
  if (!fs.existsSync(bookPath)) throw new Error('EPUB file not found');

  const epub = await parseEpub(bookPath);
  const totalChapters = epub.htmlFiles.length;
  if (totalChapters < 1) {
    return { candidates: [], totalChapters: 0 };
  }

  // Per-chapter phrase collection. We use the shared splitter so the
  // detection semantics match the converter exactly.
  const counts = new Map<string, number>();
  for (const file of epub.htmlFiles) {
    const entry = epub.entries.get(file);
    if (!entry) continue;
    const phrases = splitChapterIntoPhrases(entry.data.toString('utf8'));
    for (const phrase of phrases) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  // For the per-book UI we accept even single-chapter matches — the
  // global scanner rejects singletons but the user might want to see
  // unusual suspects so they can decide for themselves. Threshold is
  // 25% so noise stays out but a clearly-fake 1-of-10 footer still
  // surfaces.
  const required = Math.max(2, Math.floor(totalChapters * 0.25));
  const candidates: WatermarkCandidate[] = [];
  for (const [text, count] of counts) {
    if (count >= required) {
      candidates.push({
        text,
        count,
        percentage: Math.round((count / totalChapters) * 100),
      });
    }
  }

  // Sort: most common first, ties broken by descending length (longer
  // phrases are typically more specific / less likely to be a story
  // fragment).
  candidates.sort((a, b) => b.count - a.count || b.text.length - a.text.length);
  // Keep the top 50 so the UI doesn't drown.
  return { candidates: candidates.slice(0, 50), totalChapters };
}

/** AI confirmation: ask the LLM which candidates are watermarks.
 *
 *  Prompt is calibrated for Vietnamese web-novel EPUBs that ship with:
 *    - publisher footers ("Đọc thêm truyện hay tại: dtv-ebook.com.vn")
 *    - upload-site credits ("Nguồn: truyenfull.vn")
 *    - book title / author stamps in <div class="header">
 *    - "Đọc tiếp tại..." promotional links
 *  and against typical false-positive patterns we DON'T want stripped:
 *    - chapter subtitles ("Chương 12: Trở về")
 *    - recurring narrative phrases / poems
 *    - common nouns reused across the book (with both 25% AND 60% book
 *      representation). */
async function aiConfirm(candidates: WatermarkCandidate[]): Promise<WatermarkCandidate[]> {
  if (candidates.length === 0) return [];

  const listText = candidates
    .map((c, i) => `${i + 1}. [${c.percentage}% của chương] "${c.text}"`)
    .join('\n');

  const prompt = `Bạn là bộ lọc watermark cho sách điện tử. Ưu tiên **độ chính xác** hơn độ nhạy: một false-positive sẽ xóa nhầm nội dung sách, rất tệ.

Dưới đây là các cụm từ lặp lại giữa nhiều chương của một cuốn sách. Hãy xác định CHỈ những cụm rõ ràng là WATERMARK / quảng cáo / credit cần xóa, ví dụ:
  • URL website (vd "www.dtv-ebook.com.vn", "truyenfull.vn")
  • "Đọc thêm truyện hay tại: …", "Nguồn: …", "Tải tại …"
  • Tên bộ / tên tác giả / credit lưu hành được dán ở đầu MỖI chương (vd "Chiếm Đoạt Vợ Yêu", "Tiểu Ngôn")
  • Câu quảng cáo cuối trang ("Đọc tiếp tại …", "Người đăng: …")

KHÔNG được đánh dấu: tiêu đề chương ("Chương N"), phụ đề, lời thơ, lời nhân vật, mô típ truyện lặp lại, tên gọi vật phẩm / chiêu thức lặp lại.

Ứng viên:
${listText}

Chỉ trả lời bằng JSON array các CHỈ SỐ (1-based) của watermark thật. Ví dụ: [1, 3, 7]
Nếu không có cái nào là watermark, trả về: []`;

  try {
    const reply = await chat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 256,
      timeoutMs: 30_000,
    });

    const match = reply.match(/\[[\d,\s]*\]/);
    if (!match) return candidates.map((c) => ({ ...c, confirmed: false }));

    const confirmed = new Set<number>(JSON.parse(match[0]) as number[]);
    return candidates.map((c, i) => ({ ...c, confirmed: confirmed.has(i + 1) }));
  } catch (err) {
    // If AI fails, mark all as unconfirmed but DO log so the user sees
    // why their "Detect + AI" button produced zero green ticks. The
    // converter + UI both degrade gracefully without this.
    console.warn('[watermarks/ai] LLM confirmation failed:', err instanceof Error ? err.message : String(err));
    return candidates.map((c) => ({ ...c, confirmed: false }));
  }
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const useAI = req.nextUrl.searchParams.get('ai') === 'true';
    const book = await getBook(params.id);
    if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { candidates, totalChapters } = await detectCandidates(params.id);
    let enriched = candidates;
    if (useAI && candidates.length > 0) {
      enriched = await aiConfirm(candidates);
    }

    // Also return currently saved watermarks so the UI can pre-select
    // them and show "already saved" badges.
    const saved = await getBookWatermarks(params.id);

    return NextResponse.json({
      candidates: enriched,
      saved,
      totalChapters: totalChapters > 0 ? totalChapters : undefined,
    });
  } catch (err) {
    console.error('[watermarks/GET]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const body = (await req.json()) as { watermarks: unknown[]; persistToMemory?: boolean };
    if (!Array.isArray(body.watermarks) || !body.watermarks.every((value) => typeof value === 'string')) {
      return NextResponse.json({ error: 'watermarks must be an array' }, { status: 400 });
    }
    // Deduplicate and sanitise
    const cleaned = [...new Set(body.watermarks.map((w) => (w as string).trim()).filter((w) => w.length > 0))];
    if (cleaned.length > 500 || cleaned.some((value) => value.length > 1_000)) {
      return NextResponse.json({ error: 'Too many or overly long watermark phrases' }, { status: 400 });
    }
    await updateBookWatermarks(params.id, cleaned);

    // Optionally persist to the global WatermarkMemory so the next
    // conversion (different book, same publisher) picks these up for
    // free. Defaults to false to keep the per-book memory independent
    // from the cross-book catalog unless the user explicitly opts in.
    let memorized = 0;
    if (body.persistToMemory === true) {
      const { rememberWatermarks } = await import('@/lib/db/watermark-memory');
      memorized = await rememberWatermarks(cleaned, 'user');
    }

    return NextResponse.json({ ok: true, saved: cleaned, memorized });
  } catch (err) {
    console.error('[watermarks/POST]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await updateBookWatermarks(params.id, []);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

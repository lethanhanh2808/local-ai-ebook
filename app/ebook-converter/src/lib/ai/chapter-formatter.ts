// src/lib/ai/chapter-formatter.ts
//
// AI-powered chapter formatter optimized for Vietnamese novels / web fiction.
//
// Why a separate module from chapter-enhancer.ts?
//   - chapter-enhancer.ts: basic HTML cleanup (titles, watermarks, encoding)
//   - chapter-formatter.ts (this): semantic reformatting of the prose itself
//     (paragraphs, dialogue, scene breaks) — what the user actually sees.
//
// Pipeline per chapter:
//   1. Pre-chunk if very long (> MAX_SINGLE_CHUNK_CHARS)
//   2. Send each chunk to the AI with a Vietnamese-novel-specific system prompt
//   3. Validate the AI's output (HTML structure, required elements)
//   4. Retry with feedback on validation failure (up to MAX_RETRIES)
//   5. Stitch chunks back together
//
// Performance: sequential processing (concurrency 1) by default to avoid
// overloading the AI provider and to maximize per-chapter quality.
// Set FORMATTER_CONCURRENCY > 1 in env to parallelize.

import { chatWithStats, ChatResult } from './';
import { getSettings } from '@/lib/db/settings';
import { retryWithBackoff } from '@/lib/utils/retry';
import { stripIntroducedEmoji } from './emoji-stripper';

// ── Limits ────────────────────────────────────────────────────────────────
const MAX_SINGLE_CHUNK_CHARS = parseInt(process.env.FORMATTER_MAX_CHUNK ?? '8000', 10);
// Larger than enhanceChapter's 12000 because we want fewer chunks for novels
// where each chunk represents a contiguous narrative segment.

const MAX_RETRIES = parseInt(process.env.FORMATTER_MAX_RETRIES ?? '2', 10);
const CHUNK_OVERLAP_CHARS = 200; // carry-over context between chunks (preserves sentence continuity)
const CONCURRENCY = parseInt(process.env.FORMATTER_CONCURRENCY ?? '1', 10);

// ── System prompt (Vietnamese-novel-specialized) ──────────────────────────
const SYSTEM_PROMPT = `Bạn là công cụ format EPUB bảo thủ, chuyên về tiểu thuyết và tiếng Việt.

Bạn sẽ nhận HTML body fragment của một chương. Ứng dụng sẽ tự thêm XHTML wrapper, <section>, <h1> tiêu đề chương, nav, OPF metadata, và CSS sau đó.

MỤC TIÊU CHÍNH
- Làm sạch cấu trúc đoạn văn, hội thoại, ngắt cảnh, và lỗi HTML để chương dễ đọc trên thiết bị EPUB.
- Giữ nguyên nội dung tác giả. Chất lượng quan trọng hơn việc "viết hay lại".

QUY TẮC NỘI DUNG BẮT BUỘC
- KHÔNG dịch, tóm tắt, viết lại, diễn giải lại, kiểm duyệt, hiện đại hóa, hoặc thêm nội dung truyện.
- Giữ nguyên tên riêng, xưng hô, lời thoại, thứ tự đoạn, ý nghĩa câu, và dấu câu có chủ ý.
- Chỉ sửa lỗi encoding/mojibake khi ý định rõ ràng, ví dụ "Ã©" -> "é", "Â·" -> "·", "â€”" -> "—".
- Chỉ xóa watermark/quảng cáo chắc chắn: URL website, "Đọc truyện tại...", "Nguồn: ...", dòng tải ebook, uploader/source site lặp lại.
- KHÔNG xóa câu chuyện, tiêu đề phụ, thơ, thư, epigraph, lời thoại, hoặc cụm từ truyện chỉ vì chúng lặp lại.

QUY TẮC HTML BẮT BUỘC
- Chỉ trả về body fragment. KHÔNG trả về <html>, <head>, <body>, markdown, code fences, hoặc giải thích.
- KHÔNG tạo <h1>. Nếu đầu fragment có heading trùng tiêu đề chương, xóa heading đó; ứng dụng sẽ inject <h1> chuẩn.
- Có thể giữ heading nội dung như <h2>/<h3> nếu nguồn thật sự có tiểu mục trong chương.
- Dùng tag XHTML-compatible, cân bằng thẻ, không để <p> bị mở dang dở.
- Tag được ưu tiên: <p>, <br/>, <hr/>, <em>, <strong>, <i>, <b>, <span>, <blockquote>, <ol>, <ul>, <li>, <a>, <img>, <h2>, <h3>.
- Giữ link, ảnh, alt/src/href/id/class an toàn nếu có trong nguồn. Không tự bịa image path, id, class, hoặc CSS.

QUY TẮC FORMAT
- Mỗi đoạn văn hoàn chỉnh là một <p>.
- Gộp dòng rời rạc chỉ khi rõ ràng chúng thuộc cùng một đoạn.
- Tách đoạn quá dài chỉ khi có ranh giới tự nhiên: xuống dòng kép, đổi người nói, đổi ý, đổi cảnh.
- Mỗi lượt thoại nên là một <p> riêng khi nguồn cho thấy đổi lượt nói.
- Không tự đổi dấu nháy hàng loạt nếu điều đó có thể làm sai nguyên văn; chỉ chuẩn hóa khi nguồn nhất quán và chắc chắn.
- Dùng <hr/> cho ngắt cảnh rõ ràng; không để <p> rỗng quanh <hr/>.

QUY TẮC KÝ TỰ (BẮT BUỘC)
- KHÔNG chèn emoji, emoticon, hoặc các ký tự biểu cảm vào text (😊 😂 😅 🙂 😉 😢 😡 ❤️ ✨ 🌟 💫 …).
- KHÔNG chèn các ký tự trang trí giữa các đoạn (★ ☆ ♥ ♦ ♣ ♠ ❀ ❤ ✿ ❄ ☀ ☁ ☂ ⚡ ✨ …).
- KHÔNG chèn smiley kiểu ASCII ( :) :( ;) :D :P =) ^^ TT TT TT ).
- Nếu nguồn đã có những ký tự này, giữ nguyên (đây là phần tác giả); nhưng TUYỆT ĐỐI không tự thêm.
- Chỉ dùng các ký tự gốc của tiếng Việt, dấu câu chuẩn, và <hr/> để ngắt cảnh.

ĐẦU RA
- Chỉ HTML body fragment đã format.
- Văn bản hiển thị sau format phải gần như bằng nguồn, ngoại trừ watermark/quảng cáo chắc chắn và lỗi encoding đã sửa.`;

// ── Public types ──────────────────────────────────────────────────────────
export interface FormatChapterProgress {
  chapter: number;
  total: number;
  chunk: number;
  totalChunks: number;
  chars: number;
  retries: number;
  ok: boolean;
  error?: string;
}

export interface FormatOptions {
  /** Custom system-prompt override (appended to the default). */
  customSystemPrompt?: string;
  /** Called per-chunk as work progresses. */
  onProgress?: (p: FormatChapterProgress) => void;
  /** "concise" | "thorough" — controls temperature & chunking strictness. */
  mode?: 'concise' | 'thorough';
  /** Called after each successful AI call (for TOPS / token display). */
  onAiCall?: (stats: {
    model: string;
    tokens: number;
    durationMs: number;
    stage: string;
    promptTokens?: number;
    completionTokens?: number;
    generationTokensPerSecond?: number;
    promptTokensPerSecond?: number;
  }) => void;
  /** Called after each chapter is fully formatted. Async — allows DB writes. */
  onChapterDone?: (i: number, total: number, chapterTitle?: string) => void | Promise<void>;
}

export interface ChapterInput {
  id: string;
  /** Raw HTML body (just the inner content). */
  bodyHtml: string;
}

export interface ChapterOutput {
  id: string;
  /** Cleaned, formatted HTML body. */
  bodyHtml: string;
  /** Number of AI calls made (including retries). */
  aiCalls: number;
  /** If the final output failed validation, this explains what. */
  warning?: string;
}

// ── Single-chapter pipeline ──────────────────────────────────────────────
export async function formatChapter(
  bodyHtml: string,
  opts: FormatOptions = {},
): Promise<ChapterOutput> {
  const chunks = chunkHtml(bodyHtml, MAX_SINGLE_CHUNK_CHARS, CHUNK_OVERLAP_CHARS);
  const totalChunks = chunks.length;
  let aiCalls = 0;
  let warning: string | undefined;

  if (totalChunks === 1) {
    // Fast path: single chunk
    let firstError: string | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      aiCalls++;
      try {
        const formatted = await callFormatterAI(chunks[0], opts, attempt);
        const validation = validateFormattedChapter(formatted);
        const preservation = validation.ok ? validateContentPreservation(bodyHtml, formatted) : validation;
        if (validation.ok && preservation.ok) {
          return { id: '', bodyHtml: formatted, aiCalls };
        }
        warning = validation.ok ? preservation.reason : validation.reason;
        if (attempt === MAX_RETRIES) break;
      } catch (err) {
        // Capture the FIRST error (most informative — e.g. "missing API key")
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
        if (attempt === MAX_RETRIES) {
          // Graceful degradation: fall back to original. Include the AI error
          // so the caller (e.g. the job report) shows the real reason.
          return {
            id: '',
            bodyHtml,
            aiCalls,
            warning: `AI call failed (${aiCalls} attempt${aiCalls > 1 ? 's' : ''}): ${firstError}`,
          };
        }
      }
    }
    // All retries failed validation — return best-effort original
    return { id: '', bodyHtml, aiCalls, warning: warning ?? 'validation failed' };
  }

  // Long chapter: process chunks sequentially
  const formattedChunks: string[] = [];
  let firstError: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    let formatted = chunks[i];
    let accepted = false;
    let chunkWarning: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      aiCalls++;
      try {
        formatted = await callFormatterAI(chunks[i], opts, attempt);
        const validation = validateFormattedChunk(formatted);
        const preservation = validation.ok ? validateContentPreservation(chunks[i], formatted) : validation;
        if (validation.ok && preservation.ok) {
          accepted = true;
          break;
        }
        chunkWarning = validation.ok ? preservation.reason : validation.reason;
        if (attempt === MAX_RETRIES) {
          formatted = chunks[i];
        }
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
        if (attempt === MAX_RETRIES) {
          formatted = chunks[i]; // fallback to raw
          chunkWarning = `AI failed on chunk ${i + 1}: ${firstError}`;
        }
      }
    }
    if (!accepted) warning = warning ?? chunkWarning ?? `AI output rejected on chunk ${i + 1}`;
    formattedChunks.push(formatted);
  }

  // Stitch chunks back, deduplicating overlap
  const stitched = stitchChunks(formattedChunks);
  return { id: '', bodyHtml: stitched, aiCalls, warning };
}

// ── Batch (one chapter at a time, with progress) ─────────────────────────
export async function formatChapters(
  chapters: ChapterInput[],
  opts: FormatOptions = {},
): Promise<Map<string, ChapterOutput>> {
  const results = new Map<string, ChapterOutput>();
  const total = chapters.length;
  let processed = 0;

  // Fast-fail: if the AI provider has no key configured, skip the whole loop
  // so we don't waste 30-180 minutes making 4101 calls that all fail with
  // "API key required" — return a single warning for the whole book instead.
  const s = await getSettings();
  if (s.aiProvider !== 'omlx-local' && !s.aiApiKey?.trim()) {
    const earlyWarn = `Deep format skipped: AI provider "${s.aiProvider}" has no API key configured. Set it in /settings.`;
    for (const ch of chapters) {
      results.set(ch.id, { id: ch.id, bodyHtml: ch.bodyHtml, aiCalls: 0, warning: earlyWarn });
      processed++;
      opts.onProgress?.({
        chapter: processed, total, chunk: 1, totalChunks: 1,
        chars: ch.bodyHtml.length, retries: 0, ok: false, error: earlyWarn,
      });
    }
    return results;
  }

  // Process in batches of CONCURRENCY (default 1 = sequential)
  for (let i = 0; i < chapters.length; i += CONCURRENCY) {
    const batch = chapters.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (ch) => {
        const out = await formatChapter(ch.bodyHtml, opts);
        out.id = ch.id;
        results.set(ch.id, out);
        processed++;
        opts.onProgress?.({
          chapter: processed,
          total,
          chunk: 1,
          totalChunks: 1,
          chars: ch.bodyHtml.length,
          retries: 0,
          ok: !out.warning,
          error: out.warning,
        });
        // Per-chapter completion callback (for live progress display)
        await opts.onChapterDone?.(processed - 1, total, ch.id);
      }),
    );
  }

  return results;
}

// ── AI call ───────────────────────────────────────────────────────────────
async function callFormatterAI(
  chunkHtml: string,
  opts: FormatOptions,
  attempt: number,
): Promise<string> {
  const systemPrompt = opts.customSystemPrompt
    ? `${SYSTEM_PROMPT}\n\nYÊU CẦU THÊM TỪ NGƯỜI DÙNG\nChỉ áp dụng nếu không mâu thuẫn với các quy tắc nội dung và HTML bắt buộc ở trên:\n${opts.customSystemPrompt}`
    : SYSTEM_PROMPT;

  // For retry attempts, include feedback so the model knows what to fix
  const retryHint = attempt > 0
    ? `\n\nLẦN TRƯỚC OUTPUT CÓ VẤN ĐỀ. HÃY SỬA:\n- Trả về body fragment hoàn chỉnh, không có <html>, <head>, <body>, hoặc <h1>\n- Giữ nguyên nội dung, không tóm tắt, không thêm chi tiết mới\n- Dùng tag XHTML-compatible cân bằng: <p>, <blockquote>, <ol>, <ul>, <li>, <em>, <strong>, <hr/>, <a>, <img>, <h2>, <h3>\n- Không dùng markdown, không giải thích, không code fences`
    : '';

  const userContent = `SOURCE_HTML_BODY_FRAGMENT:\n${chunkHtml}${retryHint}`;

  // Read the current model from settings — the OMLX client falls back to
  // OMLX_MODEL env var if no override is provided. Passing model explicitly
  // ensures the user's selected model is used (not the env var).
  const { getSettings } = await import('@/lib/db/settings');
  const settings = await getSettings();

  const aiResult: ChatResult = await chatWithStats({
    model: settings.aiModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: opts.mode === 'concise' ? 0.05 : 0.1,
    max_tokens: Math.max(4096, Math.min(16000, Math.floor(chunkHtml.length * 0.8))),
    enable_thinking: false,
  });

  // Forward the AI stats to the pipeline (for TOPS / token display)
  if (opts.onAiCall) {
    opts.onAiCall({
      model: aiResult.model,
      tokens: aiResult.tokens,
      durationMs: aiResult.durationMs,
      stage: 'deep-format',
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
      generationTokensPerSecond: aiResult.server?.generationTokensPerSecond,
      promptTokensPerSecond: aiResult.server?.promptTokensPerSecond,
    });
  }

  return cleanAiOutput(aiResult.text, chunkHtml);
}

// ── Validation ───────────────────────────────────────────────────────────
interface ValidationResult { ok: boolean; reason?: string }

function validateFormattedChapter(html: string): ValidationResult {
  return validateFormattedFragment(html, 'chapter');
}

function validateFormattedChunk(html: string): ValidationResult {
  return validateFormattedFragment(html, 'chunk');
}

function validateFormattedFragment(html: string, scope: 'chapter' | 'chunk'): ValidationResult {
  const trimmed = html.trim();
  if (!trimmed) return { ok: false, reason: `Empty ${scope} output` };
  if (/```/.test(trimmed)) return { ok: false, reason: 'Markdown fences detected' };
  if (/<(?:html|head|body|script|style)\b/i.test(trimmed)) {
    return { ok: false, reason: `Full-document or unsafe tag detected in ${scope}` };
  }
  if (/<h1[\s>]/i.test(trimmed)) {
    return { ok: false, reason: 'Unexpected <h1>; chapter title is injected by the EPUB builder' };
  }
  if (!hasBlockContent(trimmed)) {
    return { ok: false, reason: `No block content in ${scope}` };
  }
  const openP = (html.match(/<p[\s>]/gi) ?? []).length;
  const closeP = (html.match(/<\/p>/gi) ?? []).length;
  if (openP !== closeP) {
    return { ok: false, reason: `Unbalanced <p>: ${openP} vs ${closeP}` };
  }
  return { ok: true };
}

function hasBlockContent(html: string): boolean {
  return /<(?:p|blockquote|ol|ul|li|hr|img|h2|h3)[\s/>]/i.test(html);
}

function validateContentPreservation(sourceHtml: string, outputHtml: string): ValidationResult {
  const sourceLen = visibleTextLength(sourceHtml);
  const outputLen = visibleTextLength(outputHtml);
  if (sourceLen < 200) {
    return outputLen > 0
      ? { ok: true }
      : { ok: false, reason: 'No visible text in AI output' };
  }
  if (outputLen < sourceLen * 0.55) {
    return { ok: false, reason: `AI output likely truncated or summarized (${outputLen}/${sourceLen} visible chars)` };
  }
  if (outputLen > sourceLen * 1.45) {
    return { ok: false, reason: `AI output likely expanded or hallucinated (${outputLen}/${sourceLen} visible chars)` };
  }
  return { ok: true };
}

function visibleTextLength(html: string): number {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

// ── Chunking ─────────────────────────────────────────────────────────────
function chunkHtml(html: string, maxChars: number, overlap: number): string[] {
  if (html.length <= maxChars) return [html];

  const chunks: string[] = [];
  // Split at paragraph boundaries first (preserve semantic chunks)
  const paragraphRe = /<\/p>\s*<p[\s>]/gi;
  const paragraphs: string[] = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = paragraphRe.exec(html)) !== null) {
    paragraphs.push(html.slice(lastEnd, m.index + 4)); // include </p>
    lastEnd = m.index + 4;
  }
  if (lastEnd < html.length) paragraphs.push(html.slice(lastEnd));

  // If a single paragraph exceeds maxChars, fall back to character splits
  const normalized: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      normalized.push(p);
    } else {
      // Hard-split this oversized paragraph at sentence boundaries
      let cursor = 0;
      while (cursor < p.length) {
        let end = Math.min(cursor + maxChars, p.length);
        // try to break at a sentence end
        const slice = p.slice(cursor, end);
        const lastSentence = Math.max(
          slice.lastIndexOf('. '),
          slice.lastIndexOf('! '),
          slice.lastIndexOf('? '),
          slice.lastIndexOf('.\n'),
        );
        if (lastSentence > maxChars * 0.7) {
          end = cursor + lastSentence + 1;
        }
        normalized.push(p.slice(cursor, end));
        cursor = end;
      }
    }
  }

  // Group paragraphs into chunks of <= maxChars (with overlap)
  let current = '';
  for (const p of normalized) {
    if (current.length + p.length > maxChars && current.length > 0) {
      chunks.push(current);
      // Start next chunk with overlap of previous tail
      const tail = current.slice(-overlap);
      current = tail + p;
    } else {
      current += p;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Stitch chunks (remove duplicate overlap) ────────────────────────────
function stitchChunks(chunks: string[]): string {
  if (chunks.length === 1) return chunks[0];
  let result = chunks[0];
  for (let i = 1; i < chunks.length; i++) {
    // Try to find the overlap region's content in `result` and append only the
    // non-overlapping part of chunks[i]. If detection fails, just concatenate
    // with a paragraph break.
    const tail = result.slice(-CHUNK_OVERLAP_CHARS);
    const head = chunks[i].slice(0, CHUNK_OVERLAP_CHARS);
    // Naive approach: find the longest common suffix of `result` that's also a
    // prefix of chunks[i]. If found, merge at that point. Else: concatenate.
    let overlapLen = 0;
    for (let n = Math.min(tail.length, head.length, 80); n >= 10; n--) {
      if (tail.slice(-n) === head.slice(0, n)) {
        overlapLen = n;
        break;
      }
    }
    result += chunks[i].slice(overlapLen);
  }
  return result;
}

// ── Output cleaning ──────────────────────────────────────────────────────
function cleanAiOutput(raw: string, sourceHtml?: string): string {
  let s = raw.trim();
  // Strip markdown fences
  s = s.replace(/^```(?:html)?\s*\n/i, '').replace(/\n```\s*$/m, '');
  // Strip leading/trailing whitespace
  s = s.trim();
  // If AI returned a full HTML doc, extract the body
  const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) s = bodyMatch[1].trim();
  s = s
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
    .replace(/^\s*<h1[\s>][\s\S]*?<\/h1>\s*/i, '')
    .trim();
  // Strip emoji/emoticons the AI added that weren't in the source. This is
  // defense-in-depth: the system prompt forbids them, but smaller local
  // models occasionally slip one in.
  if (sourceHtml) {
    s = stripIntroducedEmoji(sourceHtml, s);
  }
  return s;
}

// Re-export retry helper if not already
export { retryWithBackoff };

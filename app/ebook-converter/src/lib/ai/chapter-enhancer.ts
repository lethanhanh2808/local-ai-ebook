// src/lib/ai/chapter-enhancer.ts
// AI-powered chapter enhancement: cleans HTML, fixes formatting, removes broken images.
// Processes chapters in parallel (configurable concurrency).
import { chatWithStats } from './';  // unified AI client (routes by settings.aiProvider)
import { stripIntroducedEmoji } from './emoji-stripper';

const DEFAULT_CONCURRENCY = parseInt(process.env.AI_ENHANCE_CONCURRENCY ?? '3', 10);

const DEFAULT_SYSTEM_PROMPT = `You are a conservative EPUB body-fragment cleanup tool.

You will receive the INNER BODY HTML for one ebook chapter. The application will add the final XHTML wrapper, chapter title, section id, stylesheet link, nav, and OPF metadata later.

PRIMARY GOAL
- Improve structural readability and EPUB compatibility without changing the author's text.

NON-NEGOTIABLE CONTENT RULES
- Do NOT translate, summarize, rewrite, paraphrase, censor, modernize, or add story content.
- Preserve names, honorifics, dialogue wording, punctuation intent, paragraph order, and all meaningful text.
- Only fix obvious mojibake/encoding artifacts when the intended character is clear, e.g. "â€”" -> "—", "Â·" -> "·".
- Remove only clear non-book watermarks/promotional boilerplate: website URLs, "read more at...", source/download site notices, repeated uploader credits.
- Do NOT remove recurring story phrases, chapter titles, epigraphs, poems, letters, or dialogue just because they repeat.

HTML RULES
- Return only an HTML body fragment. No <html>, <head>, <body>, markdown, code fences, or explanations.
- Do not create <h1>. If a duplicate chapter heading appears at the very start, remove it; the app will inject the canonical title.
- Use valid, balanced XHTML-compatible tags.
- Prefer these tags: <p>, <br/>, <hr/>, <em>, <strong>, <i>, <b>, <span>, <blockquote>, <ol>, <ul>, <li>, <a>, <img>.
- Preserve safe inline tags and attributes when possible, especially links and images.
- Do not invent image paths, IDs, classes, or CSS.
- Convert runs of naked prose into <p> paragraphs.
- Replace repeated empty paragraphs or standalone <br/> blocks with a single logical paragraph break or <hr/> only when it is clearly a scene break.

VIETNAMESE FORMATTING GUIDANCE
- Keep Vietnamese diacritics exactly unless repairing obvious encoding damage.
- Fix spacing around punctuation conservatively.
- Dialogue may be split into separate paragraphs only when the source clearly separates speakers or turns.

CHARACTER HYGIENE (NON-NEGOTIABLE)
- Do NOT insert emojis, emoticons, or decorative symbols into the text
  (😊 😂 😅 🙂 😉 😢 😡 ❤️ ✨ 🌟 💫 ★ ☆ ♥ ♦ ❀ ❤ ✿ …).
- Do NOT insert ASCII smileys between paragraphs ( :) :( ;) :D :P =) ^^ ).
- Preserve any such characters the source already contains — but never add new ones.

QUALITY BAR
- The visible text after cleanup should be substantially the same as the source, except for removed boilerplate/watermarks and repaired encoding artifacts.`;

/**
 * Enhances a single chapter's HTML body using AI.
 * @param bodyHtml - Raw HTML body content
 * @param customPrompt - Optional custom prompt to prepend
 * @param language - Language hint (e.g. 'vi', 'en')
 * @returns Enhanced HTML body (or original on failure)
 */
export async function enhanceChapter(
  bodyHtml: string,
  customPrompt?: string,
  language?: string,
): Promise<string> {
  // Read model from settings (override OMLX_MODEL env var fallback)
  const { getSettings } = await import('@/lib/db/settings');
  const settings = await getSettings();
  const start = Date.now();

  try {
    console.log(`[chapter-enhancer] Enhancing chapter (${bodyHtml.length} chars) using model=${settings.aiModel}…`);
    const result = await chatWithStats({
      model: settings.aiModel,
      messages: [
        { role: 'system', content: buildSystemPrompt(customPrompt, language) },
        { role: 'user', content: `SOURCE_HTML_BODY_FRAGMENT:\n${bodyHtml.slice(0, 12000)}` }, // truncate very large chapters
      ],
      temperature: 0.1,
      max_tokens: 8192,
      enable_thinking: false,
    });

    const cleaned = cleanAiHtml(result.text, bodyHtml);
    if (!isSafeEnhancedOutput(bodyHtml, cleaned)) {
      console.warn('[chapter-enhancer] AI output failed safety check, using original');
      return bodyHtml;
    }

    return cleaned || bodyHtml; // fall back to original on empty response
  } catch (err) {
    console.warn('[chapter-enhancer] AI call failed, using original:', err);
    return bodyHtml; // graceful degradation
  }
}

/**
 * Enhances multiple chapters in parallel with a concurrency limit.
 * @param chapters - Array of { id, bodyHtml } objects
 * @param customPrompt - Optional custom prompt
 * @param language - Language hint
 * @param onProgress - Progress callback (done, total)
 * @param onAiCall - Per-AI-call callback for performance tracking (tokens, tok/s, etc.)
 * @param onChapterDone - Per-chapter completion callback (run after each chapter; useful for live DB sync)
 */
export async function enhanceChaptersParallel(
  chapters: Array<{ id: string; bodyHtml: string }>,
  customPrompt?: string,
  language?: string,
  onProgress?: (done: number, total: number) => void,
  onAiCall?: (stats: { chapterId: string; tokens: number; promptTokens?: number; completionTokens?: number; durationMs: number; model: string; generationTokensPerSecond?: number; promptTokensPerSecond?: number }) => void,
  onChapterDone?: (i: number, total: number, chapterId: string) => void | Promise<void>,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const total = chapters.length;
  let done = 0;

  // Process in batches of DEFAULT_CONCURRENCY
  for (let i = 0; i < chapters.length; i += DEFAULT_CONCURRENCY) {
    const batch = chapters.slice(i, i + DEFAULT_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ id, bodyHtml }, idxInBatch) => {
        const start = Date.now();
        try {
          const { text, tokens, promptTokens, completionTokens, durationMs, model, server } =
            await chatWithStats({
            model: undefined, // read from settings inside chatWithStats
            messages: [
              { role: 'system', content: buildSystemPrompt(customPrompt, language) },
              { role: 'user', content: `SOURCE_HTML_BODY_FRAGMENT:\n${bodyHtml.slice(0, 12000)}` },
            ],
            temperature: 0.1,
            max_tokens: 8192,
            enable_thinking: false,
          });
          const cleaned = cleanAiHtml(text, bodyHtml);
          results.set(id, isSafeEnhancedOutput(bodyHtml, cleaned) ? cleaned : bodyHtml);
          // Fire onAiCall BEFORE onChapterDone so the worker's running counters
          // (totalCalls, totalTokens, totalDurationMs) are updated in time for
          // the chapter-done DB-sync callback to write the correct values.
          // Otherwise the live DB would show stale (off-by-one) stats.
          onAiCall?.({
            chapterId: id,
            tokens,
            promptTokens,
            completionTokens,
            durationMs: durationMs || Date.now() - start,
            model,
            generationTokensPerSecond: server?.generationTokensPerSecond,
            promptTokensPerSecond: server?.promptTokensPerSecond,
          });
        } catch (err) {
          console.warn(`[chapter-enhancer] AI call failed for ${id}, using original:`, err);
          results.set(id, bodyHtml);
        }
        done++;
        onProgress?.(done, total);
        const globalIndex = i + idxInBatch;
        await onChapterDone?.(globalIndex, total, id);
      }),
    );
  }

  return results;
}

/** Build the system prompt for chapter enhancement. */
function buildSystemPrompt(customPrompt?: string, language?: string): string {
  const base = DEFAULT_SYSTEM_PROMPT;
  const custom = customPrompt
    ? `\n\nOPTIONAL USER STYLE REQUESTS\nApply these only if they do not conflict with the non-negotiable content and HTML rules above:\n${customPrompt}`
    : '';
  const langHint = language === 'vi' ? ' The text is in Vietnamese.' : '';
  return base + custom + langHint;
}

function cleanAiHtml(raw: string, sourceHtml?: string): string {
  let cleaned = raw
    .replace(/^```(?:html)?\n?/m, '')
    .replace(/```$/m, '')
    .trim();
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) cleaned = bodyMatch[1].trim();
  cleaned = cleaned
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
    .replace(/^\s*<h1[\s>][\s\S]*?<\/h1>\s*/i, '')
    .trim();
  // Strip emoji/emoticons the AI added that weren't in the source (defense
  // in depth — system prompt forbids them).
  if (sourceHtml) {
    cleaned = stripIntroducedEmoji(sourceHtml, cleaned);
  }
  return cleaned;
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

function isSafeEnhancedOutput(sourceHtml: string, outputHtml: string): boolean {
  if (!outputHtml.trim()) return false;
  if (/<(?:html|head|body)\b/i.test(outputHtml)) return false;
  if (/<h1[\s>]/i.test(outputHtml)) return false;
  if (/<script\b/i.test(outputHtml)) return false;
  const sourceLen = visibleTextLength(sourceHtml);
  const outputLen = visibleTextLength(outputHtml);
  if (sourceLen < 200) return outputLen > 0;
  // Allow meaningful boilerplate removal, but reject likely truncation or hallucination.
  return outputLen >= sourceLen * 0.55 && outputLen <= sourceLen * 1.35;
}

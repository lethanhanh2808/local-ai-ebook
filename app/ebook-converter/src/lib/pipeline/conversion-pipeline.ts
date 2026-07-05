// src/lib/pipeline/conversion-pipeline.ts
// Orchestrates conversion: parse → validate → repair (script-first) → [AI enhance] → build → output
// AI is invoked when:
//   • HTML repair: score < 50 (seriously broken structure)
//   • Metadata: title or author missing
//   • Chapter order: TOC completely absent
//   • aiEnhance: true (user-requested per-chapter AI processing)
//   • deepFormat: true (slow but high-quality Vietnamese-novel formatter)
import path from 'path';
import fs from 'fs';
import { parseEpub, TocEntry } from './epub-parser';
import { validateEpub, ValidationResult } from './epub-validator';
import { repairEpub, repairEpubHeuristic, RepairResult } from './epub-repairer';
import { buildEpub, ChapterEntry } from './epub-builder';
import { generateEpubMetadata, detectChapters } from '../ai/epub-analyzer';
import { enhanceChaptersParallel } from '../ai/chapter-enhancer';
import { formatChapters as formatChaptersDeep } from '../ai/chapter-formatter';
import { buildChapterHtml, extractChapterBodyFragment } from './epub-styler';

export interface PipelineOptions {
  inputPath: string;
  outputPath: string;
  originalExt: string;
  fontDir?: string;
  aiEnhance?: boolean;
  aiWatermarkClean?: boolean;
  /** Slow-but-thorough Vietnamese-novel formatter (paragraphs, dialogue, scene breaks). */
  deepFormat?: boolean;
  aiPrompt?: string;
  onProgress?: (pct: number, stage: string) => void | Promise<void>;
  /** Per-AI-call stats callback for performance tracking (TOPS, tokens, etc). */
  onAiCall?: (stats: {
    model: string;
    tokens: number;
    promptTokens?: number;
    completionTokens?: number;
    durationMs: number;
    stage: string;
    /** OMLX-specific: server-reported per-second rates (more accurate than client-measured). */
    generationTokensPerSecond?: number;
    promptTokensPerSecond?: number;
  }) => void;
  /** Per-chapter completion callback (e.g. for live progress display). Async to allow DB writes. */
  onChapterDone?: (i: number, total: number, chapterTitle?: string) => void | Promise<void>;
}

export interface PipelineResult {
  outputPath: string;
  validation: ValidationResult;
  repairReport: RepairResult['report'] | null;
  metadata: Record<string, string>;
  aiUsed: { repair: boolean; metadata: boolean; chapters: boolean; deepFormat: boolean };
  /** Total AI calls made during the deep-format stage (per chapter × per chunk). */
  deepFormatAiCalls?: number;
  /** If the deep-format stage produced warnings (e.g. AI key missing), this is the first one. */
  deepFormatWarning?: string;
}

export async function runConversionPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { inputPath, outputPath, onProgress, onAiCall, aiEnhance = false, aiWatermarkClean = false, deepFormat = false, aiPrompt } = opts;
  const progress = async (pct: number, stage: string) => {
    await onProgress?.(pct, stage);
  };
  const aiUsed = { repair: false, metadata: false, chapters: false, deepFormat: false };
  let firstDeepWarning: string | null = null;

  const ext = (opts.originalExt || path.extname(inputPath)).toLowerCase().replace('.', '');

  await progress(2, 'Reading source file…');

  // ── Step 1: parse ─────────────────────────────────────────────────────
  let epub;
  if (ext === 'epub') {
    await progress(5, 'Parsing EPUB structure…');
    epub = await parseEpub(inputPath);
  } else {
    await progress(5, 'Reading source content…');
    epub = await buildMinimalEpubFromFile(inputPath, ext);
  }

  // ── Step 2: validate ──────────────────────────────────────────────────
  await progress(15, 'Validating EPUB structure…');
  const validation = validateEpub(epub);

  // ── Step 3: repair (script-first; AI only when score < 50) ───────────
  let repairResult: RepairResult | null = null;
  if (epub.htmlFiles.length > 0) {
    if (validation.score < 50) {
      // Seriously broken structure – use AI-assisted repair
      aiUsed.repair = true;
      await progress(20, 'AI-assisted repair (critical issues detected)…');
      repairResult = await repairEpub(epub, async (pct, stage) => {
        await progress(20 + Math.round(pct * 0.45), stage);
      });
    } else {
      // Good enough – fast heuristic-only repair
      await progress(20, 'Repairing HTML…');
      repairResult = await repairEpubHeuristic(epub, async (pct, stage) => {
        await progress(20 + Math.round(pct * 0.45), stage);
      });
    }
  }

  // ── Step 4: metadata — keep existing; AI only fills blank fields ───────
  await progress(68, 'Checking metadata…');
  // Preserve all original metadata fields; normalise empty strings
  let finalMeta: Record<string, string> = {
    identifier: epub.metadata.identifier ?? '',
    publisher:  epub.metadata.publisher  ?? '',
    date:       epub.metadata.date       ?? '',
    ...epub.metadata,
    title:    (epub.metadata.title    ?? '').trim(),
    author:   (epub.metadata.author   ?? '').trim(),
    language: (epub.metadata.language ?? 'vi').trim(),
    description: (epub.metadata.description ?? '').trim(),
  };

  const metaNeedsAI = !finalMeta.title || !finalMeta.author;
  if (metaNeedsAI) {
    aiUsed.metadata = true;
    await progress(70, 'Inferring missing metadata with AI…');
    try {
      const sampleText = epub.htmlFiles[0]
        ? epub.entries.get(epub.htmlFiles[0])?.data.toString('utf8').slice(0, 500) ?? ''
        : '';
      const aiMeta = await generateEpubMetadata(
        finalMeta.title,
        finalMeta.author,
        sampleText,
      );
      // Only fill in blanks — never overwrite existing values
      finalMeta = {
        ...finalMeta,
        title:       finalMeta.title       || aiMeta.title       || 'Untitled',
        author:      finalMeta.author      || aiMeta.author      || 'Unknown',
        language:    finalMeta.language    || aiMeta.language    || 'vi',
        description: finalMeta.description || aiMeta.description || '',
      };
    } catch {
      finalMeta.title  = finalMeta.title  || 'Untitled';
      finalMeta.author = finalMeta.author || 'Unknown';
    }
  }

  // ── Step 5: chapters — use existing TOC/spine; AI only if TOC absent ──
  await progress(75, 'Building chapter list…');
  let chapters: ChapterEntry[] = [];

  const hasToc = epub.tocEntries.length > 0;
  if (!hasToc) {
    // No TOC at all — ask AI to figure out chapter structure
    aiUsed.chapters = true;
    await progress(75, 'Ordering chapters with AI…');
    try {
      const detected = await detectChapters(epub.tocEntries, epub.htmlFiles);
      chapters = detected.chapters.map((ch, i) => {
        const file = epub.htmlFiles.find((f) => f.endsWith(ch.file)) ?? epub.htmlFiles[i];
        const rawHtml = repairResult?.repairedHtml.get(file ?? '') ??
          (file ? epub.entries.get(file)?.data.toString('utf8') : '') ?? '';
        return makeChapter(i, ch.title, rawHtml, finalMeta.language);
      });
    } catch {
      // Fall through to spine-order fallback below
    }
  }

  if (chapters.length === 0) {
    // Build a lookup: filename (basename + full path) → TOC title for O(1) matching
    const tocByBasename = new Map<string, string>();
    const tocByFullPath = new Map<string, string>();
    for (const entry of epub.tocEntries) {
      tocByFullPath.set(entry.src, entry.title);
      tocByBasename.set(path.basename(entry.src), entry.title);
    }

    chapters = epub.htmlFiles.map((file, i) => {
      const rawHtml = repairResult?.repairedHtml.get(file) ??
        epub.entries.get(file)?.data.toString('utf8') ?? '';

      // Match TOC title by full path first, then basename — avoids position-based mismatch
      const tocTitle =
        tocByFullPath.get(file) ??
        tocByBasename.get(path.basename(file)) ??
        `Chapter ${i + 1}`;

      return makeChapter(i, tocTitle, rawHtml, finalMeta.language);
    }).filter((ch) => {
      // Skip cover-only chapters: body has no readable text after stripping tags
      const textContent = ch.html.replace(/<[^>]+>/g, '').trim();
      return textContent.length > 20; // at least some text beyond just the title
    });
  }

  if (chapters.length === 0) {
    throw new Error('No chapters could be extracted from the source file');
  }

  // ── Step 5.5: Deep format (slow, Vietnamese-novel optimized) ──────────
  // When `deepFormat` is true, runs the new chapter-formatter module which
  // understands paragraph structure, dialogue attribution, scene breaks.
  // Processes chapters SEQUENTIALLY by default for best quality.
  let deepFormatAiCalls = 0;
  if (deepFormat && chapters.length > 0) {
    aiUsed.deepFormat = true;
    const total = chapters.length;
    console.log(`[pipeline] Starting DEEP format for ${total} chapters (slow)…`);
    await progress(66, `Deep format: processing chapter 1/${total}…`);

    // Send only the editable chapter body to AI. The deterministic EPUB
    // builder owns <html>, <body>, <section>, and the canonical <h1>.
    const chapterBodies = chapters.map((ch) => ({
      id: ch.id,
      bodyHtml: extractChapterBodyFragment(ch.html, ch.title),
    }));

    const formatted = await formatChaptersDeep(
      chapterBodies,
      {
        customSystemPrompt: aiPrompt,
        mode: 'thorough',
        onAiCall: opts.onAiCall,
        onChapterDone: opts.onChapterDone,
      },
    );

    // Replace chapter HTML with formatted version
    let deepFormatFailed = 0;
    chapters = chapters.map((ch) => {
      const out = formatted.get(ch.id);
      if (!out) return ch;
      deepFormatAiCalls += out.aiCalls;
      if (out.warning) {
        deepFormatFailed++;
        if (!firstDeepWarning) firstDeepWarning = out.warning;
      }
      return {
        ...ch,
        html: buildChapterHtml({ id: ch.id, title: ch.title, body: out.bodyHtml, lang: finalMeta.language }),
      };
    });
    if (firstDeepWarning) {
      console.warn(`[pipeline] Deep format warning (${deepFormatFailed}/${chapters.length} chapters): ${firstDeepWarning}`);
    }
    await progress(84, deepFormatFailed === chapters.length
      ? `Deep format SKIPPED (${firstDeepWarning})`
      : `Deep format complete (${deepFormatAiCalls} AI calls${deepFormatFailed ? `, ${deepFormatFailed} failed` : ''})`);
  }

  // ── Step 5.55: Light AI enhancement (optional, fast) ─────────────────
  // The light enhancer still runs when `aiEnhance` is true, even after deep
  // format — it adds watermarks/encoding fixes on top.
  if (aiEnhance && chapters.length > 0 && !deepFormat) {
    aiUsed.repair = true;
    const total = chapters.length;
    console.log(`[pipeline] Starting light AI enhancement for ${total} chapters…`);
    await progress(66, `AI enhancement: processing ${total} chapters…`);

    const chapterBodies = chapters.map((ch) => ({
      id: ch.id,
      bodyHtml: extractChapterBodyFragment(ch.html, ch.title),
    }));

    const enhanced = await enhanceChaptersParallel(
      chapterBodies,
      aiPrompt,
      finalMeta.language,
      (done, tot) => {
        const pct = 66 + Math.round((done / tot) * 18);
        void progress(pct, `AI enhancement: ${done}/${tot} chapters done`);
      },
      (stats) => {
        // Forward per-call metrics through the pipeline's onAiCall so the
        // worker (and live DB) can show tokens / tok/s for the light path too.
        const serverGen = stats.generationTokensPerSecond;
        const clientTokPerSec = stats.durationMs > 0
          ? (stats.tokens * 1000 / stats.durationMs).toFixed(1)
          : '–';
        const label = serverGen
          ? `model=${stats.model} ${stats.tokens} tokens (gen ${serverGen.toFixed(1)} tok/s) dur=${stats.durationMs}ms`
          : `model=${stats.model} ${stats.tokens} tokens (${clientTokPerSec} tok/s) dur=${stats.durationMs}ms`;
        onAiCall?.({
          model: stats.model,
          tokens: stats.tokens,
          promptTokens: stats.promptTokens,
          completionTokens: stats.completionTokens,
          durationMs: stats.durationMs,
          stage: 'enhance',
          generationTokensPerSecond: stats.generationTokensPerSecond,
          promptTokensPerSecond: stats.promptTokensPerSecond,
        });
        // Also write a friendly log entry for the worker's NDJSON log.
        // Stripped down: avoid duplicating `log` calls.
        console.log(`[pipeline] Light enhance ${label}`);
      },
      // Forward chapter-done to the worker's live-DB sync callback so
      // `aiCallCount` / `aiTotalTokens` update as each chapter completes
      // (not only at the final summary).
      async (i, total, chapterId) => {
        // Look up the chapter title so the log line is friendly
        const ch = chapters.find((c) => c.id === chapterId);
        await opts.onChapterDone?.(i, total, ch?.title);
      },
    );

    chapters = chapters.map((ch) => {
      const enhancedBody = enhanced.get(ch.id);
      if (!enhancedBody) return ch;
      return {
        ...ch,
        html: buildChapterHtml({ id: ch.id, title: ch.title, body: enhancedBody, lang: finalMeta.language }),
      };
    });
    await progress(84, 'AI enhancement complete');
  }

  // ── Step 5.6: watermark detection + cleanup (optional) ───────────────
  if (aiWatermarkClean && chapters.length > 1) {
    await progress(85, 'Detecting watermarks…');
    const watermarkPhrases = detectWatermarkPhrases(chapters);
    if (watermarkPhrases.length > 0) {
      console.log(`[pipeline] Stripping ${watermarkPhrases.length} watermark phrase(s)`);
      chapters = chapters.map((ch) => ({
        ...ch,
        html: stripPhrasesFromHtml(ch.html, watermarkPhrases),
      }));
    }
  }

  // ── Step 6: font paths ────────────────────────────────────────────────
  await progress(85, 'Embedding Literata font…');
  const fontDir = opts.fontDir ?? path.resolve(process.cwd(), 'public/assets/fonts');
  const fontPaths: Record<string, string> = {};
  for (const f of ['Literata-Regular.ttf', 'Literata-Italic.ttf', 'Literata-Bold.ttf', 'Literata-BoldItalic.ttf']) {
    const fp = path.join(fontDir, f);
    if (fs.existsSync(fp)) fontPaths[f] = fp;
  }

  // ── Step 7: build final EPUB ──────────────────────────────────────────
  await progress(90, 'Building EPUB…');
  await buildEpub(
    {
      title:       finalMeta.title,
      author:      finalMeta.author,
      language:    finalMeta.language,
      description: finalMeta.description,
      chapters,
      fontPaths,
    },
    outputPath,
  );

  await progress(100, 'Done!');

  return {
    outputPath,
    validation,
    repairReport: repairResult?.report ?? null,
    metadata: finalMeta,
    aiUsed,
    deepFormatAiCalls: deepFormat ? deepFormatAiCalls : undefined,
    deepFormatWarning: firstDeepWarning ?? undefined,
  };
}


// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract plain-text title from the first heading element in the body.
 * Returns null if no heading is found.
 */
function extractTitleFromBody(body: string): string | null {
  const m = body.match(/^\s*<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/i);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim() || null;
}

/**
 * Remove ALL consecutive heading elements from the very start of the body.
 * We inject our own clean <h1> via buildChapterHtml, so originals are redundant.
 * Also strips a leading <p> that is a verbatim repeat of the chapter title
 * (a common Calibre / DTV ebook artifact).
 */
function stripLeadingHeadings(body: string, title?: string): string {
  let result = body.trim();
  // Greedily remove leading heading tags one at a time
  const headRe = /^<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>\s*/i;
  while (headRe.test(result)) {
    result = result.replace(headRe, '').trim();
  }
  // Strip a leading <p> that is a verbatim repeat of the chapter title
  if (title) {
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dupPRe = new RegExp(`^<p(?:\\s[^>]*)?>\\s*${esc}\\s*<\\/p>\\s*`, 'i');
    if (dupPRe.test(result)) {
      result = result.replace(dupPRe, '').trim();
    }
  }
  return result;
}

function makeChapter(i: number, tocTitle: string, rawHtml: string, lang: string): ChapterEntry {
  const rawBody = extractBody(rawHtml);

  // Prefer title from the actual HTML heading (canonical source of truth)
  const bodyTitle = extractTitleFromBody(rawBody);
  const title = bodyTitle || tocTitle;

  // Strip the heading from body — buildChapterHtml injects its own clean <h1>
  // Also strip all <img> tags — images can't be resolved from the output EPUB
  const body = stripImages(stripLeadingHeadings(rawBody, title));

  const n = String(i + 1).padStart(3, '0');
  return {
    id: `chapter${n}`,
    title,
    filename: `chapter${n}.xhtml`,
    html: buildChapterHtml({ id: `chapter${n}`, title, body, lang }),
  };
}

/** Remove img elements from body content (images aren't embedded in output EPUB) */
function stripImages(body: string): string {
  return body.replace(/<img\b[^>]*\/?>/gi, '').trim();
}

function extractBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1].trim() : html;
}

async function buildMinimalEpubFromFile(
  filePath: string,
  ext: string,
): Promise<import('./epub-parser').ParsedEpub> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const name = path.basename(filePath, `.${ext}`);
  const html =
    ext === 'html' || ext === 'htm'
      ? raw
      : `<html><body>${raw
          .split('\n\n')
          .map((p) => `<p>${p.replace(/\n/g, ' ').trim()}</p>`)
          .join('\n')}</body></html>`;

  const dummyPath = `${name}.xhtml`;
  const entries = new Map([
    [dummyPath, { name: dummyPath, data: Buffer.from(html, 'utf8') }],
  ]);

  return {
    entries,
    opfPath: '',
    opfContent: '',
    htmlFiles: [dummyPath],
    cssFiles: [],
    imageFiles: [],
    metadata: { title: name, language: 'vi' },
    tocEntries: [{ title: name, src: dummyPath }],
  };
}

/**
 * Detect phrases that appear in the majority of chapters — likely watermarks.
 * Returns phrases that appear in > 60% of chapters and are < 200 chars.
 *
 * Phrases are extracted from each chapter by:
 *   1. Converting the HTML to plain text (stripping tags).
 *   2. Splitting on paragraph / heading boundaries — anything that
 *      puts text on its own line: <p>, <h1>..<h6>, <div>, <li>,
 *      <br/>, or literal newlines. This is critical because Calibre-built
 *      Vietnamese EPUBs from dtv-ebook.com put book-level metadata
 *      (title / author / URL) inside <div class="header"> / <div class="author">
 *      elements at the very top of every chapter file, with no surrounding
 *      whitespace. We need those divs to register as their own "lines"
 *      for the frequency count to work.
 *   3. Trimming and deduping — phrases are short, distinct, and consistent
 *      (≤ 200 chars).
 */
function detectWatermarkPhrases(chapters: ChapterEntry[]): string[] {
  const total = chapters.length;
  if (total < 2) return [];

  // Split-block regex: a paragraph OR heading OR content-div OR a literal
  // newline, OR a <br/> tag. We use this as the *separator* so each
  // block of text becomes one item in the resulting array.
  const splitRe = /<\/(?:p|h[1-6]|div|li|blockquote|pre|tr)>|<\s*br\s*\/?\s*>|\r?\n/i;

  const lineFreq = new Map<string, number>();
  for (const ch of chapters) {
    const blocks = ch.html.split(splitRe);
    const seen = new Set<string>();
    for (const block of blocks) {
      // Strip any remaining inline tags and squash whitespace
      const text = block
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length < 4 || text.length > 200) continue;
      // Skip "Chương N" chapter titles (vary per chapter, noisy for freq).
      // Keep entries that include known-watermark substrings (book title,
      // author, URL) even if they happen to start with "Chương N".
      if (/^Chương\s+\d+/i.test(text) && !/Chiếm Đoạt|Tiểu Ngôn|dtv-ebook/i.test(text)) {
        continue;
      }
      seen.add(text);
    }
    for (const phrase of seen) {
      lineFreq.set(phrase, (lineFreq.get(phrase) ?? 0) + 1);
    }
  }

  const threshold = Math.ceil(total * 0.6);
  return Array.from(lineFreq.entries())
    .filter(([, count]) => count >= threshold)
    .map(([phrase]) => phrase);
}

/**
 * Strip watermark phrases from HTML content. Three complementary passes:
 *   1. Remove <div>/<p>/<span>/<h*> elements whose ONLY text content
 *      equals one of the watermark phrases (whole-element removal).
 *   2. Remove any <div>/<p>/<span>/<h*> that contains a watermark phrase
 *      and at most 60 chars of "other" text (a thin wrapper).
 *   3. Strip bare occurrences inside other tags.
 */
function stripPhrasesFromHtml(html: string, phrases: string[]): string {
  if (phrases.length === 0) return html;
  let result = html;
  for (const phrase of phrases) {
    // Escape special regex chars (escape ALL non-alphanumerics)
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

    // Pass 1: remove whole elements whose text is *only* the watermark
    // (covers <div class="header">Chiếm Đoạt Vợ Yêu</div>, etc.)
    const wholeOnlyRe = new RegExp(
      `<(?:p|div|span|h[1-6])(?:\\s[^>]*)?>\\s*${escaped}\\s*<\\/(?:p|div|span|h[1-6])>`,
      'gi',
    );
    result = result.replace(wholeOnlyRe, '');

    // Pass 2: remove elements that *contain* the phrase with little else
    // (e.g. a thin wrapper like <div>Chiếm Đoạt Vợ Yêu | dtv-ebook.com</div>).
    // We allow up to 60 chars of "non-phrase" text before/after the phrase.
    const wrapperRe = new RegExp(
      `<(?:p|div|span|h[1-6])(?:\\s[^>]*)?>[^<]{0,60}${escaped}[^<]{0,60}<\\/(?:p|div|span|h[1-6])>`,
      'gi',
    );
    result = result.replace(wrapperRe, '');

    // Pass 3: strip bare text occurrences (e.g. anywhere the phrase leaked
    // out of an element into neighbouring prose).
    result = result.replace(new RegExp(`\\s*${escaped}\\s*`, 'g'), ' ');
  }
  // Tidy any double-blanks left behind
  result = result.replace(/\n\s*\n/g, '\n').replace(/[ \t]{2,}/g, ' ');
  return result;
}

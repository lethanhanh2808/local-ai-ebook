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
import { buildEpub, ChapterEntry, EpubImage } from './epub-builder';
import { generateEpubMetadata, detectChapters } from '../ai/epub-analyzer';
import { enhanceChaptersParallel } from '../ai/chapter-enhancer';
import { formatChapters as formatChaptersDeep } from '../ai/chapter-formatter';
import { buildChapterHtml, extractChapterBodyFragment, READER_FRIENDLY_CSS } from './epub-styler';
import { listWatermarkPhrases, rememberWatermark, touchWatermark } from '../db/watermark-memory';
import { detectFromChaptersHtml } from './watermark-detect';

export interface PipelineOptions {
  inputPath: string;
  outputPath: string;
  originalExt: string;
  fontDir?: string;
  aiEnhance?: boolean;
  aiWatermarkClean?: boolean;
  /** Slow-but-thorough Vietnamese-novel formatter (paragraphs, dialogue, scene breaks). */
  deepFormat?: boolean;
  /** Reader-friendly mode: strip heavy CSS (animations, text-shadow, blur,
   *  filter, hyphens, fixed-position decorative pseudos) and use a minimal
   *  stylesheet so the output renders correctly on Onyx Boox (Neoreader),
   *  Kobo Aura, Nook GlowLight, and older Kindle Paperwhite. Without this
   *  flag, complex source EPUBs may show only the first 1–2 pages of each
   *  chapter on those devices. */
  readerFriendly?: boolean;
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
  const { inputPath, outputPath, onProgress, onAiCall, aiEnhance = false, aiWatermarkClean = false, deepFormat = false, readerFriendly = false, aiPrompt } = opts;
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

  // Filter cover pages out of the spine before chapter construction.
  // EPUBs vary in how they mark the cover: `<body class="cover-page">`
  // (EPUB2) or `<body epub:type="cover">` (EPUB3) or `epub:type="frontmatter"`.
  // Without this filter the cover slips through as a 1-page Chapter 1
  // — it has enough whitespace and the alt text to pass the 20-char
  // floor in the `Skip cover-only chapters` filter below. Filename-only
  // checks (`/cover\.xhtml$/i`) miss the half of real EPUBs that name
  // the cover `title.xhtml` / `Cover001.xhtml`, so we match the body
  // metadata instead. The cover branch in buildEpub is unaffected.
  const chapterHtmlFiles = epub.htmlFiles.filter(
    (f) => !looksLikeCoverPage(epub.entries.get(f)?.data.toString('utf8') ?? ''),
  );

  // Shared sink for data-URI images decoded out of any chapter body.
  // Phase 2.3: data: URIs are extracted to disk-as-buffer entries
  // (filename pattern `inline-N.<ext>`) and rewritten to a `../images/`
  // src just like the source-resolver-mapped images. The build reads it
  // back at Step 6.7 to merge into the images[] collection. Both chapter
  // branches (AI-detect + spine-order fallback) write into this sink.
  const dataUriImages: EpubImage[] = [];

  const hasToc = epub.tocEntries.length > 0;
  if (!hasToc) {
    // No TOC at all — ask AI to figure out chapter structure
    aiUsed.chapters = true;
    await progress(75, 'Ordering chapters with AI…');
    try {
      const detected = await detectChapters(epub.tocEntries, chapterHtmlFiles);
      chapters = detected.chapters.map((ch, i) => {
        const file = chapterHtmlFiles.find((f) => f.endsWith(ch.file)) ?? chapterHtmlFiles[i];
        const rawHtml = repairResult?.repairedHtml.get(file ?? '') ??
          (file ? epub.entries.get(file)?.data.toString('utf8') : '') ?? '';
        // AI-detect branch can also produce interior images, so populate
        // the same imageResolver + sink as the spine-order branch.
        const imageResolver = file ? buildImageResolver(epub, file) : undefined;
        return makeChapter(i, ch.title, rawHtml, finalMeta.language, imageResolver, dataUriImages);
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

    chapters = chapterHtmlFiles.map((file, i) => {
      const rawHtml = repairResult?.repairedHtml.get(file) ??
        epub.entries.get(file)?.data.toString('utf8') ?? '';

      // Match TOC title by full path first, then basename — avoids position-based mismatch
      const tocTitle =
        tocByFullPath.get(file) ??
        tocByBasename.get(path.basename(file)) ??
        `Chapter ${i + 1}`;

      // Build a per-chapter image resolver so `<img src="...">` inside the
      // body can be rewritten against `../images/<basename>` for the output
      // (chapters live at `EPUB/chapterN.xhtml`; images at `EPUB/images/…`).
      const imageResolver = buildImageResolver(epub, file);
      return makeChapter(i, tocTitle, rawHtml, finalMeta.language, imageResolver, dataUriImages);
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
  // Reader-friendly mode forces deepFormat off too — it's the slow path the
  // user is explicitly trying to avoid when they need an Onyx Boox–safe EPUB
  // in minutes instead of hours.
  let deepFormatAiCalls = 0;
  if (deepFormat && chapters.length > 0 && !readerFriendly) {
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
  // Reader-friendly mode forces this off: the whole point of that mode is a
  // quick conversion that just strips heavy CSS, and per-chapter LLM calls
  // on a 798-chapter book take many hours. The user can still toggle AI
  // enhancement back on after the first reader-friendly pass to fix the
  // heavy-CSS issue, then re-run.
  const skipAiEnhance = aiEnhance && chapters.length > 0 && !deepFormat && !readerFriendly;
  if (skipAiEnhance) {
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
  // Two-phase:
  //   (a) Memory read — phrases from previous conversions that we can
  //       strip straight away, no scan needed. Sub-millisecond for
  //       O(10–50) typical catalog size.
  //   (b) Fresh detection — runs the shared tag-aware frequency scan
  //       against the new chapters. Whatever it finds joins the strip
  //       list AND gets persisted to memory so the next book skips this
  //       work entirely.
  //
  // The detector (watermark-detect.ts) is shared with the per-book Detect
  // endpoint so a user who notices leftover watermarks can re-trigger the
  // same scan from /library/[id] without a full re-conversion.
  if (aiWatermarkClean && chapters.length > 1) {
    await progress(85, 'Detecting watermarks…');
    const memoryPhrases = await listWatermarkPhrases();
    const memorySet = new Set(memoryPhrases);
    // Auto-detect uses a 40% chapter threshold (down from the legacy 60%).
    // The legacy threshold was conservative but missed books where the
    // watermark footer was missing on a handful of interlude chapters. A
    // 40% threshold still leaves plenty of headroom for "real" book text
    // (which rarely reappears verbatim across that share of chapters).
    const detectedPhrases = detectFromChaptersHtml(chapters, { threshold: 0.4 });
    // Anything from memory is always kept (cheap, already-known to be junk).
    // Anything new that detection picked up is kept too — but only if it's
    // *not* already in memory to avoid double-stripping (the strip regex
    // is idempotent but a second pass still costs CPU).
    const newOnes = detectedPhrases.filter((p) => !memorySet.has(p));
    const allPhrases = [...memoryPhrases, ...newOnes];

    if (allPhrases.length > 0) {
      console.log(`[pipeline] Stripping ${allPhrases.length} watermark phrase(s) (${memoryPhrases.length} from memory, ${newOnes.length} freshly detected)`);
      chapters = chapters.map((ch) => ({
        ...ch,
        html: stripPhrasesFromHtml(ch.html, allPhrases),
      }));
      // Bump hitCount + lastSeenAt for memory-served phrases (per-book
      // stats). Newly-detected phrases are inserted below — both paths
      // move the counter forward by 1.
      for (const p of memoryPhrases) {
        await touchWatermark(p);
      }
    }
    // Persist the new discoveries so the next upload skips them.
    if (newOnes.length > 0) {
      try {
        for (const p of newOnes) await rememberWatermark(p, 'auto');
        console.log(`[pipeline] Memorized ${newOnes.length} new watermark phrase(s)`);
      } catch (err) {
        // Non-fatal: memory write failure shouldn't fail the conversion.
        console.warn('[pipeline] Failed to persist watermark memory:', err);
      }
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

  // ── Step 6.5: source cover pass-through ──────────────────────────────
  // The builder has a complete cover branch (manifest + spine + cover.xhtml
  // + EPUB2/3 metadata), but the conversion flow never wired it up — the
  // previous behaviour was to silently drop the source cover, leaving
  // the output EPUB with no first-page image. We now extract the source
  // cover from the parsed OPF and pass its file path through to buildEpub.
  //
  // Three resolution strategies (in order), matching extractCoverFromEpub:
  //   1. <meta name="cover" content="<id>"> → manifest item → href
  //   2. <item ... properties="cover-image" ...> → href
  //   3. Any file named cover.<ext> in the ZIP
  // Falls through to "no cover" (and the builder emits no cover branch)
  // when none match — the AI cover generator's own route handles that
  // case later via epub-cover.ts.
  const coverInfo = resolveSourceCover(epub);
  if (coverInfo) {
    await progress(88, 'Embedding source cover…');
  }

  // Phase 2.2 / 2.3: build the interior-image collection for buildEpub. We
  // do this AFTER cover resolution so the cover's source entry can be
  // filtered out — the cover branch in buildEpub will write its own
  // `<item properties="cover-image">` row plus the cover bytes, and we'd
  // otherwise double-emit the same file. The collection is the source-EPUB
  // images PLUS any data-URI images extracted out of chapter bodies (the
  // latter is populated by the chapter loop above; we read it back here).
  const interiorImages: EpubImage[] = [
    ...collectInteriorImages(epub, coverInfo?.sourceEntry ?? null),
    ...(dataUriImages ?? []),
  ];

  // ── Step 7: build final EPUB ──────────────────────────────────────────
  await progress(90, 'Building EPUB…');
  // Reader-friendly mode swaps in a minimal, e-ink-safe stylesheet so the
  // output renders correctly on Onyx Boox (Neoreader), Kobo Aura, and older
  // Kindles — devices whose renderers bail on heavy CSS (animations, blur,
  // text-shadow, fixed-position decorative backgrounds, hyphens, columns).
  // We deliberately don't include fontPaths in reader-friendly mode because
  // some devices fail to resolve custom @font-face URLs and the renderer
  // then stops laying out the chapter.
  await buildEpub(
    {
      title:       finalMeta.title,
      author:      finalMeta.author,
      language:    finalMeta.language,
      description: finalMeta.description,
      chapters,
      fontPaths: readerFriendly ? undefined : fontPaths,
      customCss:   readerFriendly ? READER_FRIENDLY_CSS : undefined,
      coverImagePath: coverInfo?.path,
      images:      interiorImages.length > 0 ? interiorImages : undefined,
    },
    outputPath,
  );

  // Best-effort cleanup of the sidecar cover file (we never want stray
  // .jpg / .png in the output dir). A failure here is non-fatal — the
  // build has already succeeded and the user has a working EPUB.
  if (coverInfo) {
    try { fs.unlinkSync(coverInfo.path); } catch { /* best effort */ }
  }

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

/** Heuristic: returns true when the supplied source HTML looks like a
 *  cover page rather than a real chapter. EPUB2 typically marks cover
 *  pages via `class="cover-page"` on `<body>`; EPUB3 uses
 *  `epub:type="cover"` or `epub:type="frontmatter"` on `<body>`. Some
 *  exporters wrap the cover in a `<section epub:type="cover">` inside a
 *  normal `<body>` — the body-level metadata is the most reliable
 *  signal we have without re-parsing the OPF. The function is
 *  deliberately permissive: a false positive (skipping a real chapter)
 *  is the same failure mode the old code had with cover xhtmls that
 *  happened to have > 20 chars of text. A false negative lets the old
 *  bug surface again, which the test in image-preservation.test.ts
 *  pins so we notice. */
function looksLikeCoverPage(html: string): boolean {
  if (!html) return false;
  const bodyMatch = html.match(/<body\b([^>]*)>/i);
  if (!bodyMatch) return false;
  const attrs = bodyMatch[1];
  if (/\bclass\s*=\s*["'][^"']*\bcover-page\b/i.test(attrs)) return true;
  if (/\bepub:type\s*=\s*["'][^"']*\bcover\b/i.test(attrs)) return true;
  if (/\bepub:type\s*=\s*["'][^"']*\bfrontmatter\b/i.test(attrs)) return true;
  return false;
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

function makeChapter(
  i: number,
  tocTitle: string,
  rawHtml: string,
  lang: string,
  imageResolver?: (src: string) => string | null,
  dataUriSink?: EpubImage[],
): ChapterEntry {
  const rawBody = extractBody(rawHtml);

  // Prefer title from the actual HTML heading (canonical source of truth)
  const bodyTitle = extractTitleFromBody(rawBody);
  const title = bodyTitle || tocTitle;

  // Strip the heading from body — buildChapterHtml injects its own clean <h1>
  let body = stripLeadingHeadings(rawBody, title);

  // Phase 2.3: data-URI images → extract to files first, so the resolver
  // (Phase 2.2) sees a clean body with no inline data URIs. This pass is
  // idempotent: if no `<img src="data:...">` is present, the body is
  // returned unchanged. The sink (when present) is a shared list across
  // chapters so duplicate `inline-N.<ext>` filenames can't happen — the
  // extractor picks a fresh `N` per insertion.
  if (dataUriSink) {
    body = extractDataUriImages(body, dataUriSink);
  }

  // Phase 2.2: rewrite interior `<img src>` against the source image map
  // when we have a resolver. The resolver is `undefined` for the
  // buildMinimalEpubFromFile() path (no real source EPUB), so we fall
  // back to the legacy strip pass there. For real EPUB conversions, an
  // unresolvable `src` is left untouched — the reader will show a broken
  // image, which is preferable to silently dropping content.
  if (imageResolver) {
    body = rewriteImageSources(body, imageResolver);
  } else {
    body = stripImages(body);
  }

  const n = String(i + 1).padStart(3, '0');
  return {
    id: `chapter${n}`,
    title,
    filename: `chapter${n}.xhtml`,
    html: buildChapterHtml({ id: `chapter${n}`, title, body, lang }),
  };
}

/** Phase 2.3 — decode any `<img src="data:image/<ext>;base64,<payload>">`
 *  out of the body and into the shared `sink` as a regular `EpubImage`.
 *  Returns the rewritten HTML with the inline payload replaced by a
 *  `../images/inline-N.<ext>` src that the reader can resolve the same
 *  way it resolves file-backed figures.
 *
 *  Notes:
 *  - Operates only on quoted `data:image/...` srcs; bare-word forms are
 *    too rare to bother with and would complicate the regex.
 *  - Non-image data URIs (e.g. `data:application/octet-stream`) are
 *    passed through untouched.
 *  - Bad payloads (decode fails, buffer is empty) are passed through
 *    untouched, so a malformed inline image doesn't break the build.
 *  - The deterministic filename pattern `inline-N.<ext>` keeps the
 *    rewritten HTML readable in the output for debugging.
 */
function extractDataUriImages(body: string, sink: EpubImage[]): string {
  return body.replace(
    /<img\b([^>]*?)\ssrc=(["'])data:image\/([A-Za-z0-9+.-]+)(?:;base64)?,([^"']+)\2([^>]*?)\/?>/gi,
    (match, pre, quote, rawExt, payload, post) => {
      const ext = normalizeImageExt(rawExt);
      if (!ext) return match;
      let buf: Buffer;
      try {
        buf = Buffer.from(payload, 'base64');
      } catch {
        return match;
      }
      if (buf.length === 0) return match;

      // Pick a non-colliding inline-N.<ext>.
      const used = new Set(sink.map((i) => i.href));
      let n = 1;
      while (used.has(`inline-${n}.${ext}`)) n++;
      const basename = `inline-${n}.${ext}`;
      const mediaType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      sink.push({
        id: `img-inline-${sink.length + 1}`,
        href: basename,
        data: buf,
        mediaType,
      });

      const newSrc = `../images/${basename}`;
      const isSelfClosing = match.endsWith('/>');
      return `<img${pre} src=${quote}${newSrc}${quote}${post}${isSelfClosing ? ' /' : ''}>`;
    },
  );
}

/** Normalize a `data:image/<ext>` segment to a safe filename extension.
 *  Returns `''` for extensions we don't know how to write safely. */
function normalizeImageExt(raw: string): string {
  const e = raw.toLowerCase();
  switch (e) {
    case 'png':
    case 'gif':
    case 'svg':
    case 'svg+xml':
    case 'webp':
    case 'jpg':
    case 'jpeg':
      return e === 'jpeg' ? 'jpg' : e === 'svg+xml' ? 'svg' : e;
    default:
      return '';
  }
}

/** Remove img elements from body content. This is the LEGACY path —
 *  only used when we don't have a source EPUB to resolve images against
 *  (the `buildMinimalEpubFromFile()` branch for non-EPUB inputs like
 *  raw `.txt`/`.html`). For real EPUB conversions, `makeChapter` now
 *  rewrites `<img src>` via `rewriteImageSources` instead. Kept here
 *  so the helper signatures stay simple. */
function stripImages(body: string): string {
  return body.replace(/<img\b[^>]*\/?>/gi, '').trim();
}

/** Build the non-cover image collection to hand to buildEpub. Skips:
 *    - the cover entry (the cover branch owns that filename + bytes);
 *    - any entry whose buffer is missing or zero-length.
 *  Order follows the source `epub.imageFiles` order so the manifest
 *  rows are stable across re-runs. The `id` is derived from the
 *  basename with a `-N` suffix on collision, which avoids id collisions
 *  when two different directories happen to contain figures named the
 *  same. The builder's own sanitizer may further rename the `href` if
 *  the manifest already has a cover-named row; that's expected. */
function collectInteriorImages(
  epub: import('./epub-parser').ParsedEpub,
  coverEntryName: string | null,
): EpubImage[] {
  const out: EpubImage[] = [];
  const usedIds = new Set<string>();
  for (const entryName of epub.imageFiles) {
    if (coverEntryName && entryName === coverEntryName) continue;
    const entry = epub.entries.get(entryName);
    if (!entry || !entry.data || entry.data.length === 0) continue;
    const basename = path.posix.basename(entryName);
    const dot = basename.lastIndexOf('.');
    const ext = dot > 0 ? basename.slice(dot + 1).toLowerCase() : 'jpg';
    const mediaType = imageMediaType(ext);
    // Derive a deterministic id from the basename; sanitize to
    // [a-z0-9_-] and prefix to avoid clashing with reserved names.
    let baseId = basename
      .replace(/\.[^.]+$/, '')                  // strip ext
      .replace(/[^A-Za-z0-9_-]+/g, '-')         // collapse illegal chars
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    if (!baseId) baseId = 'image';
    let id = `img-${baseId}`;
    let n = 2;
    while (usedIds.has(id)) id = `img-${baseId}-${n++}`;
    usedIds.add(id);
    out.push({ id, href: basename, data: entry.data, mediaType });
  }
  return out;
}

function imageMediaType(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

/** Rewrite every `<img src="...">` whose src the resolver can map to a
 *  source-EPUB image entry. Unresolvable srcs are left in place so the
 *  user sees a broken-image marker rather than silently dropped content.
 *  The replacement is always `../images/<basename>` so the converter
 *  emits a uniform path regardless of the source's directory layout. */
function rewriteImageSources(body: string, resolve: (src: string) => string | null): string {
  return body.replace(/<img\b([^>]*?)\/?>/gi, (match, attrs) => {
    // Pull out the quoted-or-bare src value.
    const m = attrs.match(/\ssrc=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    if (!m) return match;
    const src = m[1] ?? m[2] ?? m[3] ?? '';
    const resolved = resolve(src);
    if (!resolved) return match;

    // Preserve original quote style: which capture group matched tells
    // us which delimiter to emit on rewrite.
    let quote: '"' | "'" | '' = '';
    if (m[1] !== undefined) quote = '"';
    else if (m[2] !== undefined) quote = "'";
    else if (m[3] !== undefined) quote = '';

    // Strip the old src attribute and append the rewritten one.
    // Doing it as a string replace (rather than re-emitting the whole
    // tag from `attrs`) keeps any other attributes untouched.
    const newAttrs = attrs.replace(/\ssrc=(?:"[^"]+"|'[^']+'|\S+)/i, '')
      + ` src=${quote}../images/${resolved}${quote}`;
    const isSelfClosing = match.endsWith('/>');
    return `<img${newAttrs}${isSelfClosing ? ' /' : ''}>`;
  });
}

/** Build a per-chapter image resolver. The resolver takes the value of
 *  an `<img src="...">` attribute from the chapter HTML and returns the
 *  basename of the matching source-EPUB image (the form we need in the
 *  output), or `null` if nothing matched (caller leaves the src alone).
 *
 *  Source paths are typically expressed relative to the chapter's
 *  directory (e.g. `<img src="../Images/figure-1.png">` from a chapter
 *  at `OEBPS/Text/ch1.xhtml` resolving to `OEBPS/Images/figure-1.png`).
 *  We try that first, plus a couple of fallbacks:
 *    • bare src (treated as ZIP root)
 *    • backslash form (`../Images\\figure-1.png` from sloppy exporters)
 *    • case-insensitive match (EPUB readers tolerate this; some
 *      exporters do too)
 *
 *  External URLs (`http:`, `mailto:`) and data URIs are skipped — the
 *  latter is handled by Phase 2.3 separately.
 */
function buildImageResolver(
  epub: import('./epub-parser').ParsedEpub,
  chapterFile: string,
): (src: string) => string | null {
  const chapterDir = path.posix.dirname(chapterFile);
  // Snapshot entry keys once so the loop is O(n) instead of O(n²).
  const entryKeys = Array.from(epub.entries.keys());
  return (src: string): string | null => {
    if (!src) return null;
    // Strip fragment / query before doing any IO.
    const cleanSrc = src.split('#')[0].split('?')[0].trim();
    if (!cleanSrc) return null;
    if (/^(?:https?:|data:|mailto:)/i.test(cleanSrc)) return null;

    // Build candidate resolved paths.
    const candidates = new Set<string>();
    if (chapterDir && chapterDir !== '.') {
      const normalized = path.posix
        .normalize(`${chapterDir}/${cleanSrc}`)
        .replace(/^\/+/, '');
      candidates.add(normalized);
    }
    candidates.add(cleanSrc.replace(/^\/+/, ''));
    if (cleanSrc.includes('\\')) {
      candidates.add(cleanSrc.replace(/\\/g, '/').replace(/^\/+/, ''));
    }

    for (const cand of candidates) {
      if (epub.entries.has(cand)) return path.posix.basename(cand);
      // EPUB readers tolerate case-mismatched filenames; some sloppy
      // exporters do too. Walk the entry key list looking for a
      // case-insensitive match. Cost is O(imageFiles × chapters) per
      // missing src, but typical books have <100 images so this is
      // fine.
      const wanted = cand.toLowerCase();
      for (const key of entryKeys) {
        if (key.toLowerCase() === wanted) return path.posix.basename(key);
      }
    }
    return null;
  };
}

interface ResolvedCover {
  /** Absolute path to a sidecar file holding the cover bytes. Builder
   *  reads from this path; we delete the file after the build. */
  path: string;
  /** Extension (without the dot), used by the builder for media-type
   *  detection. Mirrored in the output `EPUB/images/cover.<ext>`. */
  ext: string;
  /** The source-EPUB entry name (e.g. `OEBPS/Images/cover.png`).
   *  Used by `collectInteriorImages` to skip the cover row, so we don't
   *  double-emit the cover file. */
  sourceEntry: string;
}

/** Locate the cover image in a parsed source EPUB and write its bytes
 *  to a sidecar file next to the output EPUB. Returns `null` when the
 *  source has no cover (in which case the builder emits no cover
 *  branch and the AI cover generator's own route can fill the gap).
 *
 *  Three resolution strategies, in order (matches `extractCoverFromEpub`
 *  in `epub-cover.ts`):
 *   1. `<meta name="cover" content="<id>">` → manifest `<item id="<id>">` → href
 *   2. `<item ... properties="cover-image" ... href="<href>">` → href
 *   3. Any file named `cover.<ext>` in the ZIP (case-insensitive)
 *
 *  The OPF-relative href is resolved against `path.dirname(opfPath)`,
 *  which is the same rule the parser uses for spine HTML. */
function resolveSourceCover(epub: import('./epub-parser').ParsedEpub): ResolvedCover | null {
  const opfDir = path.dirname(epub.opfPath);
  const resolveOpfRelative = (href: string): string =>
    (opfDir && opfDir !== '.' ? `${opfDir}/${href}` : href).replace(/^\/+/, '');

  let coverEntryName: string | null = null;

  // Strategy 1: <meta name="cover" content="<id>">
  const metaM = epub.opfContent.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/i);
  if (metaM) {
    const coverId = metaM[1];
    const itemRe = new RegExp(`<item[^>]+id="${coverId}"[^>]+href="([^"]+)"`, 'i');
    const itemM = epub.opfContent.match(itemRe);
    if (itemM) coverEntryName = resolveOpfRelative(itemM[1]);
  }

  // Strategy 2: <item ... properties="cover-image" ...>
  if (!coverEntryName) {
    const propM = epub.opfContent.match(/<item[^>]+properties="cover-image"[^>]+href="([^"]+)"/i)
      ?? epub.opfContent.match(/<item[^>]+href="([^"]+)"[^>]*properties="cover-image"/i);
    if (propM) coverEntryName = resolveOpfRelative(propM[1]);
  }

  // Strategy 3: scan for a file named cover.<ext> in the ZIP
  if (!coverEntryName) {
    for (const name of epub.entries.keys()) {
      if (/\/cover\.(jpg|jpeg|png|gif|webp)$/i.test(name) || /^cover\.(jpg|jpeg|png|gif|webp)$/i.test(name)) {
        coverEntryName = name;
        break;
      }
    }
  }

  if (!coverEntryName) return null;

  const buf = epub.entries.get(coverEntryName)?.data;
  if (!buf || buf.length === 0) return null;

  const ext = (path.extname(coverEntryName).slice(1) || 'jpg').toLowerCase();
  // We don't know the output dir until buildEpub gets the path. Use the
  // OS temp dir; the caller is responsible for the post-build cleanup.
  const sidecarPath = path.join(require('os').tmpdir(), `ebook-converter-source-cover-${process.pid}-${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(sidecarPath, buf);
  } catch (err) {
    // Non-fatal: a sidecar write failure should not abort the conversion.
    console.warn('[pipeline] Failed to stage source cover for pass-through:', err);
    return null;
  }
  return { path: sidecarPath, ext, sourceEntry: coverEntryName };
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
 * Strip watermark phrases from HTML content. Three complementary passes:
 *   1. Remove <div>/<p>/<span>/<h*> elements whose ONLY text content
 *      equals one of the watermark phrases (whole-element removal).
 *   2. Remove any <div>/<p>/<span>/<h*> that contains a watermark phrase
 *      and at most 60 chars of "other" text (a thin wrapper).
 *   3. Strip bare occurrences inside other tags.
 *
 * Detection (which phrases to strip) is handled by watermark-detect.ts.
 * This is the conversion-pipeline's own strip pass; watermark-strip.ts
 * has a parallel implementation used by the live reader + on-demand
 * /api/library/[id]/watermarks/apply endpoint. We keep both: this one
 * is tag-agnostic and works against the converted chapter shape, the
 * other is paragraph-aware and works against raw `<p>`-heavy source HTML.
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

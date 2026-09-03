// src/lib/pipeline/conversion-pipeline.ts
// Orchestrates conversion: parse → validate → repair (script-first) → [AI enhance] → build → output
// AI is invoked when:
//   • HTML repair: score < 50 (seriously broken structure)
//   • Metadata: title or author missing
//   • Chapter order: TOC completely absent
//   • aiEnhance: true (user-requested per-chapter AI processing)
//   • deepFormat: true (slow but high-quality Vietnamese-novel formatter)
import { ValidationResult } from './epub-validator';
import { RepairResult } from './epub-repairer';
import { ChapterEntry, EpubImage } from './epub-builder';
import { buildFinalEpub } from './conversion-pipeline-build';
import { runChapterPreparationStage } from './conversion-pipeline-chapters';
import { runPreflightStage } from './conversion-pipeline-preflight';
import { runWatermarkCleanupStage } from './conversion-pipeline-watermark';
import { extractBody, extractTitleFromBody, prepareChapterBodies, stripLeadingHeadings } from './conversion-pipeline-content';
import { extractDataUriImages, rewriteImageSources, stripImages } from './conversion-pipeline-image-ops';
import { writeDeepFormatSidecar, type SidecarChapter } from './deep-format-sidecar';

export interface PipelineOptions {
  inputPath: string;
  outputPath: string;
  originalExt: string;
  /** Book UUID. When provided, the pipeline writes a deep-format sidecar
   *  (`<outputPath>.deepFormat.json`) containing the cleaned chapter text so
   *  the character-bible worker can read from the formatted source instead
   *  of re-parsing the original EPUB. Required to enable sidecar persistence;
   *  leaving it null disables sidecar writes for back-compat with the test
   *  harness. */
  bookId?: string | null;
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
  /** When deepFormat was used and a sidecar was written, the file path +
   *  byte size of the JSON next to the EPUB. null when the sidecar was
   *  skipped or `bookId` wasn't supplied to the pipeline. */
  deepFormatSidecar?: { path: string; bytes: number } | null;
  /** Sidecar write failure reason (non-fatal — see conversion-pipeline.ts). */
  deepFormatSidecarError?: string | null;
}

export async function runConversionPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { inputPath, outputPath, onProgress, onAiCall, aiEnhance = false, aiWatermarkClean = false, deepFormat = false, readerFriendly = false, aiPrompt } = opts;
  const progress = async (pct: number, stage: string) => {
    await onProgress?.(pct, stage);
  };
  const aiUsed = { repair: false, metadata: false, chapters: false, deepFormat: false };
  let deepFormatAiCalls = 0;
  let firstDeepWarning: string | null = null;

  const preflight = await runPreflightStage({
    inputPath,
    originalExt: opts.originalExt,
    onProgress: progress,
  });

  const { epub, validation, repairResult, finalMeta } = preflight;
  aiUsed.repair = preflight.aiUsed.repair;
  aiUsed.metadata = preflight.aiUsed.metadata;

  const chapterStage = await runChapterPreparationStage({
    epub,
    repairResult,
    finalMeta,
    deepFormat,
    readerFriendly,
    aiEnhance,
    aiPrompt,
    onProgress: progress,
    onAiCall: opts.onAiCall,
    onChapterDone: opts.onChapterDone,
  });
  let chapters = chapterStage.chapters;
  const dataUriImages = chapterStage.dataUriImages;
  aiUsed.chapters = chapterStage.aiUsed.chapters;
  aiUsed.deepFormat = chapterStage.aiUsed.deepFormat;
  deepFormatAiCalls = chapterStage.deepFormatAiCalls ?? 0;
  firstDeepWarning = chapterStage.firstDeepWarning ?? null;

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
  if (aiWatermarkClean) {
    const watermarkResult = await runWatermarkCleanupStage(chapters, {
      enabled: true,
      onProgress: progress,
    });
    chapters = watermarkResult.chapters;
  }

  await buildFinalEpub({
    outputPath,
    finalMeta,
    chapters,
    epub,
    dataUriImages,
    fontDir: opts.fontDir,
    readerFriendly,
    onProgress: progress,
  });

  // ── Deep-format sidecar ──────────────────────────────────────────────
  // When the user opted into deepFormat AND we actually have an AI-
  // produced set of chapters, persist the cleaned chapter text next to
  // the EPUB so the character-bible worker can read the SAME text the
  // user sees in their ebook (no mojibake / watermark noise to confuse
  // character extraction). Best-effort: a sidecar write failure never
  // fails the conversion — the bible worker will fall back to the raw
  // EPUB parse.
  let deepFormatSidecar: { path: string; bytes: number } | null = null;
  let deepFormatSidecarError: string | null = null;
  if (aiUsed.deepFormat && opts.bookId) {
    const sidecarChapters: SidecarChapter[] = chapters.map((ch) => ({
      // The bible worker keys everything on chapterIndex (the position
      // in the source EPUB's htmlFiles). We trust the chapter order here
      // because runChapterPreparationStage() preserves the source order
      // (filtered only by `looksLikeCoverPage` at the very start).
      index: chapterIndexForEntry(chapters, ch),
      title: ch.title,
      text: stripHtml(ch.html).slice(0, MAX_CHAPTER_TEXT_CHARS),
    }));
    const result = await writeDeepFormatSidecar({
      outputPath,
      bookId: opts.bookId,
      chapters: sidecarChapters,
      model: opts.aiPrompt ? null : null, // model is plumbed elsewhere
      aiCalls: deepFormatAiCalls,
    });
    if (result.ok) {
      deepFormatSidecar = { path: result.path, bytes: result.bytes };
    } else {
      deepFormatSidecarError = result.error;
    }
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
    deepFormatSidecar,
    deepFormatSidecarError,
  };
}

/** Resolve the position of a `ChapterEntry` within the final chapter list.
 *  `ChapterEntry.id` is stable (e.g. "chapter001") but the bible worker
 *  uses the position-in-htmlFiles index as its key. We track positions
 *  by mapping id→index inside this file because the input chapters array
 *  here is the SAME array as `chapterStage.chapters` (deepFormat +
 *  enhance preserve order). Returns the index, or -1 if not found. */
function chapterIndexForEntry(
  chapters: ChapterEntry[],
  target: ChapterEntry,
): number {
  return chapters.findIndex((c) => c.id === target.id);
}

/** Best-effort HTML→text stripper, scoped to the sidecar use case. We keep
 *  it simple here because the chapter HTML has already been normalized by
 *  `normalizeChapterHtml` + the deep-format stage — script/style tags,
 *  inline styles, and complex media shouldn't survive to this point. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<\/(p|div|section|h[1-6]|li|br)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Hard cap on per-chapter text written to the sidecar. The bible worker
 *  applies its own per-call `bibleChapterChars` truncation on read, so we
 *  only need to prevent absurdly-large chapters from blowing up the JSON.
 *  200 KB of UTF-8 covers ~50k Vietnamese words — far beyond any novel
 *  chapter we've seen (Eragon's longest is ~25 KB). */
const MAX_CHAPTER_TEXT_CHARS = 200_000;

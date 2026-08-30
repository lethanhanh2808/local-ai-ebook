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

import path from 'path';
import { RepairResult } from './epub-repairer';
import { ParsedEpub } from './epub-parser';
import { ChapterEntry, EpubImage } from './epub-builder';
import { runAiEnhancementStage, runDeepFormatStage } from './conversion-pipeline-ai';
import { looksLikeCoverPage } from './conversion-pipeline-content';
import { buildImageResolver } from './conversion-pipeline-assets';
import { normalizeChapterHtml } from './conversion-pipeline-normalize';

export interface ChapterStageInput {
  epub: ParsedEpub;
  repairResult: RepairResult | null;
  finalMeta: Record<string, string>;
  deepFormat?: boolean;
  readerFriendly?: boolean;
  aiEnhance?: boolean;
  aiPrompt?: string;
  onProgress?: (pct: number, stage: string) => void | Promise<void>;
  onAiCall?: (stats: {
    model: string;
    tokens: number;
    promptTokens?: number;
    completionTokens?: number;
    durationMs: number;
    stage: string;
    generationTokensPerSecond?: number;
    promptTokensPerSecond?: number;
  }) => void;
  onChapterDone?: (i: number, total: number, chapterTitle?: string) => void | Promise<void>;
}

export interface ChapterStageResult {
  chapters: ChapterEntry[];
  dataUriImages: EpubImage[];
  aiUsed: { chapters: boolean; deepFormat: boolean };
  deepFormatAiCalls?: number;
  firstDeepWarning?: string;
}

export async function runChapterPreparationStage(opts: ChapterStageInput): Promise<ChapterStageResult> {
  const {
    epub,
    repairResult,
    finalMeta,
    deepFormat = false,
    aiEnhance = false,
    aiPrompt,
    onProgress,
    onAiCall,
    onChapterDone,
  } = opts;

  const progress = async (pct: number, stage: string) => {
    await onProgress?.(pct, stage);
  };

  const aiUsed = { chapters: false, deepFormat: false };
  let firstDeepWarning: string | null = null;

  await progress(75, 'Building chapter list…');
  let chapters: ChapterEntry[] = [];

  const chapterHtmlFiles = epub.htmlFiles.filter(
    (f) => !looksLikeCoverPage(epub.entries.get(f)?.data.toString('utf8') ?? ''),
  );

  const dataUriImages: EpubImage[] = [];

  const hasToc = epub.tocEntries.length > 0;
  if (!hasToc) {
    aiUsed.chapters = true;
    await progress(75, 'Ordering chapters with AI…');
    try {
      const detected = await import('../ai/epub-analyzer').then((m) => m.detectChapters(epub.tocEntries, chapterHtmlFiles));
      chapters = detected.chapters.map((ch, i) => {
        const file = chapterHtmlFiles.find((f) => f.endsWith(ch.file)) ?? chapterHtmlFiles[i];
        const rawHtml = repairResult?.repairedHtml.get(file ?? '') ??
          (file ? epub.entries.get(file)?.data.toString('utf8') : '') ?? '';
        const imageResolver = file ? buildImageResolver(epub, file) : undefined;
        return normalizeChapterHtml({
          index: i,
          tocTitle: ch.title,
          rawHtml,
          lang: finalMeta.language,
          imageResolver,
          dataUriSink: dataUriImages,
        });
      });
    } catch {
      // Fall through to spine-order fallback below
    }
  }

  if (chapters.length === 0) {
    const tocByBasename = new Map<string, string>();
    const tocByFullPath = new Map<string, string>();
    for (const entry of epub.tocEntries) {
      tocByFullPath.set(entry.src, entry.title);
      tocByBasename.set(path.basename(entry.src), entry.title);
    }

    chapters = chapterHtmlFiles.map((file, i) => {
      const rawHtml = repairResult?.repairedHtml.get(file) ?? epub.entries.get(file)?.data.toString('utf8') ?? '';
      const tocTitle =
        tocByFullPath.get(file) ??
        tocByBasename.get(path.basename(file)) ??
        `Chapter ${i + 1}`;
      const imageResolver = buildImageResolver(epub, file);
      return normalizeChapterHtml({
        index: i,
        tocTitle,
        rawHtml,
        lang: finalMeta.language,
        imageResolver,
        dataUriSink: dataUriImages,
      });
    }).filter((ch) => {
      const textContent = ch.html.replace(/<[^>]+>/g, '').trim();
      return textContent.length > 20;
    });
  }

  if (chapters.length === 0) {
    throw new Error('No chapters could be extracted from the source file');
  }

  let deepFormatAiCalls = 0;
  // deepFormat and aiEnhance are now COMPOSABLE: both can run on the same
  // book. deepFormat runs first (restructures/normalizes the HTML), then
  // aiEnhance cleans up any residual artifacts. readerFriendly no longer
  // cancels either stage — it is purely a build-stage CSS swap.
  if (deepFormat && chapters.length > 0) {
    aiUsed.deepFormat = true;
    const deepResult = await runDeepFormatStage(chapters, {
      enabled: true,
      aiPrompt,
      language: finalMeta.language,
      onProgress: progress,
      onAiCall,
      onChapterDone,
    });
    chapters = deepResult.chapters;
    deepFormatAiCalls = deepResult.deepFormatAiCalls;
    firstDeepWarning = deepResult.firstDeepWarning;
  }

  if (aiEnhance && chapters.length > 0) {
    const enhancedResult = await runAiEnhancementStage(chapters, {
      enabled: true,
      aiPrompt,
      language: finalMeta.language,
      onProgress: progress,
      onAiCall,
      onChapterDone,
    });
    chapters = enhancedResult.chapters;
  }

  return {
    chapters,
    dataUriImages,
    aiUsed,
    deepFormatAiCalls: deepFormat ? deepFormatAiCalls : undefined,
    firstDeepWarning: firstDeepWarning ?? undefined,
  };
}

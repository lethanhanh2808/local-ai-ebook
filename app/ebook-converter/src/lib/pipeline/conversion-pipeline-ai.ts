import { buildChapterHtml } from './epub-styler';
import type { ChapterEntry } from './epub-builder';
import { enhanceChaptersParallel } from '../ai/chapter-enhancer';
import { formatChapters as formatChaptersDeep } from '../ai/chapter-formatter';
import { prepareChapterBodies } from './conversion-pipeline-content';

export interface DeepFormatStageOptions {
  enabled: boolean;
  aiPrompt?: string;
  language: string;
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

export interface DeepFormatStageResult {
  chapters: ChapterEntry[];
  deepFormatAiCalls: number;
  firstDeepWarning: string | null;
  wasUsed: boolean;
}

export async function runDeepFormatStage(
  chapters: ChapterEntry[],
  opts: DeepFormatStageOptions,
): Promise<DeepFormatStageResult> {
  const { enabled, aiPrompt, language, onProgress, onAiCall, onChapterDone } = opts;

  if (!enabled || chapters.length === 0) {
    return { chapters, deepFormatAiCalls: 0, firstDeepWarning: null, wasUsed: false };
  }

  let deepFormatAiCalls = 0;
  let firstDeepWarning: string | null = null;
  const total = chapters.length;
  console.log(`[pipeline] Starting DEEP format for ${total} chapters (slow)…`);
  await onProgress?.(66, `Deep format: processing chapter 1/${total}…`);

  const chapterBodies = prepareChapterBodies(chapters);
  const formatted = await formatChaptersDeep(chapterBodies, {
    customSystemPrompt: aiPrompt,
    mode: 'thorough',
    onAiCall,
    onChapterDone,
  });

  const nextChapters = chapters.map((ch) => {
    const out = formatted.get(ch.id);
    if (!out) return ch;
    deepFormatAiCalls += out.aiCalls;
    if (out.warning && !firstDeepWarning) firstDeepWarning = out.warning;
    return {
      ...ch,
      html: buildChapterHtml({ id: ch.id, title: ch.title, body: out.bodyHtml, lang: language }),
    };
  });

  if (firstDeepWarning) {
    console.warn(`[pipeline] Deep format warning (${firstDeepWarning})`);
  }

  await onProgress?.(
    84,
    firstDeepWarning
      ? `Deep format SKIPPED (${firstDeepWarning})`
      : `Deep format complete (${deepFormatAiCalls} AI calls)`,
  );

  return {
    chapters: nextChapters,
    deepFormatAiCalls,
    firstDeepWarning,
    wasUsed: true,
  };
}

export interface AiEnhancementStageOptions {
  enabled: boolean;
  aiPrompt?: string;
  language: string;
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

export interface AiEnhancementStageResult {
  chapters: ChapterEntry[];
  wasUsed: boolean;
}

export async function runAiEnhancementStage(
  chapters: ChapterEntry[],
  opts: AiEnhancementStageOptions,
): Promise<AiEnhancementStageResult> {
  const { enabled, aiPrompt, language, onProgress, onAiCall, onChapterDone } = opts;

  if (!enabled || chapters.length === 0) {
    return { chapters, wasUsed: false };
  }

  const total = chapters.length;
  console.log(`[pipeline] Starting light AI enhancement for ${total} chapters…`);
  await onProgress?.(66, `AI enhancement: processing ${total} chapters…`);

  const chapterBodies = prepareChapterBodies(chapters);
  const enhanced = await enhanceChaptersParallel(
    chapterBodies,
    aiPrompt,
    language,
    (done, tot) => {
      const pct = 66 + Math.round((done / tot) * 18);
      void onProgress?.(pct, `AI enhancement: ${done}/${tot} chapters done`);
    },
    (stats) => {
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
      console.log(`[pipeline] Light enhance ${label}`);
    },
    async (i, totalChapters, chapterId) => {
      const ch = chapters.find((c) => c.id === chapterId);
      await onChapterDone?.(i, totalChapters, ch?.title);
    },
  );

  const nextChapters = chapters.map((ch) => {
    const enhancedBody = enhanced.get(ch.id);
    if (!enhancedBody) return ch;
    return {
      ...ch,
      html: buildChapterHtml({ id: ch.id, title: ch.title, body: enhancedBody, lang: language }),
    };
  });

  await onProgress?.(84, 'AI enhancement complete');

  return {
    chapters: nextChapters,
    wasUsed: true,
  };
}

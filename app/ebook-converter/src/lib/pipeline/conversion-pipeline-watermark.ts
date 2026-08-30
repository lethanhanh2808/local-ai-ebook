import { ChapterEntry } from './epub-builder';
import { stripPhrasesFromHtml } from './conversion-pipeline-text';
import { listWatermarkPhrases, rememberWatermark, touchWatermark } from '../db/watermark-memory';
import { detectFromChaptersHtml } from './watermark-detect';

export interface WatermarkCleanupOptions {
  enabled?: boolean;
  onProgress?: (pct: number, stage: string) => void | Promise<void>;
}

export interface WatermarkCleanupResult {
  chapters: ChapterEntry[];
  memoryPhrases: string[];
  detectedPhrases: string[];
  newOnes: string[];
}

export async function runWatermarkCleanupStage(
  chapters: ChapterEntry[],
  opts: WatermarkCleanupOptions = {},
): Promise<WatermarkCleanupResult> {
  const { enabled = false, onProgress } = opts;

  if (!enabled || chapters.length <= 1) {
    return { chapters, memoryPhrases: [], detectedPhrases: [], newOnes: [] };
  }

  await onProgress?.(85, 'Detecting watermarks…');

  const memoryPhrases = await listWatermarkPhrases();
  const memorySet = new Set(memoryPhrases);
  const detectedPhrases = detectFromChaptersHtml(chapters, { threshold: 0.4 });
  const newOnes = detectedPhrases.filter((p) => !memorySet.has(p));
  const allPhrases = [...memoryPhrases, ...newOnes];

  let cleanedChapters = chapters;

  if (allPhrases.length > 0) {
    console.log(`[pipeline] Stripping ${allPhrases.length} watermark phrase(s) (${memoryPhrases.length} from memory, ${newOnes.length} freshly detected)`);
    cleanedChapters = chapters.map((ch) => ({
      ...ch,
      html: stripPhrasesFromHtml(ch.html, allPhrases),
    }));

    for (const p of memoryPhrases) {
      await touchWatermark(p);
    }
  }

  if (newOnes.length > 0) {
    try {
      for (const p of newOnes) await rememberWatermark(p, 'auto');
      console.log(`[pipeline] Memorized ${newOnes.length} new watermark phrase(s)`);
    } catch (err) {
      console.warn('[pipeline] Failed to persist watermark memory:', err);
    }
  }

  return {
    chapters: cleanedChapters,
    memoryPhrases,
    detectedPhrases,
    newOnes,
  };
}

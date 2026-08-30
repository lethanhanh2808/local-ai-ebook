import path from 'path';
import { generateEpubMetadata } from '../ai/epub-analyzer';
import { repairEpub, repairEpubHeuristic, RepairResult } from './epub-repairer';
import { parseEpub, ParsedEpub } from './epub-parser';
import { validateEpub, ValidationResult } from './epub-validator';
import { buildMinimalEpubFromFile } from './conversion-pipeline-text';

export interface PreflightStageInput {
  inputPath: string;
  originalExt?: string;
  onProgress?: (pct: number, stage: string) => void | Promise<void>;
}

export interface PreflightStageResult {
  epub: ParsedEpub;
  validation: ValidationResult;
  repairResult: RepairResult | null;
  finalMeta: Record<string, string>;
  aiUsed: { repair: boolean; metadata: boolean };
}

export async function runPreflightStage(opts: PreflightStageInput): Promise<PreflightStageResult> {
  const { inputPath, originalExt, onProgress } = opts;
  const progress = async (pct: number, stage: string) => {
    await onProgress?.(pct, stage);
  };

  const aiUsed = { repair: false, metadata: false };
  const ext = (originalExt || path.extname(inputPath)).toLowerCase().replace('.', '');

  await progress(2, 'Reading source file…');

  let epub: ParsedEpub;
  if (ext === 'epub') {
    await progress(5, 'Parsing EPUB structure…');
    epub = await parseEpub(inputPath);
  } else {
    await progress(5, 'Reading source content…');
    epub = await buildMinimalEpubFromFile(inputPath, ext);
  }

  await progress(15, 'Validating EPUB structure…');
  const validation = validateEpub(epub);

  let repairResult: RepairResult | null = null;
  if (epub.htmlFiles.length > 0) {
    if (validation.score < 50) {
      aiUsed.repair = true;
      await progress(20, 'AI-assisted repair (critical issues detected)…');
      repairResult = await repairEpub(epub, async (pct, stage) => {
        await progress(20 + Math.round(pct * 0.45), stage);
      });
    } else {
      await progress(20, 'Repairing HTML…');
      repairResult = await repairEpubHeuristic(epub, async (pct, stage) => {
        await progress(20 + Math.round(pct * 0.45), stage);
      });
    }
  }

  await progress(68, 'Checking metadata…');
  let finalMeta: Record<string, string> = {
    identifier: epub.metadata.identifier ?? '',
    publisher: epub.metadata.publisher ?? '',
    date: epub.metadata.date ?? '',
    ...epub.metadata,
    title: (epub.metadata.title ?? '').trim(),
    author: (epub.metadata.author ?? '').trim(),
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
      const aiMeta = await generateEpubMetadata(finalMeta.title, finalMeta.author, sampleText);
      finalMeta = {
        ...finalMeta,
        title: finalMeta.title || aiMeta.title || 'Untitled',
        author: finalMeta.author || aiMeta.author || 'Unknown',
        language: finalMeta.language || aiMeta.language || 'vi',
        description: finalMeta.description || aiMeta.description || '',
      };
    } catch {
      finalMeta.title = finalMeta.title || 'Untitled';
      finalMeta.author = finalMeta.author || 'Unknown';
    }
  }

  return { epub, validation, repairResult, finalMeta, aiUsed };
}

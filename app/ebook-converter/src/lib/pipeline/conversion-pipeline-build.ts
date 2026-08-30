import fs from 'fs';
import path from 'path';
import { buildEpub, type ChapterEntry, type EpubImage } from './epub-builder';
import { READER_FRIENDLY_CSS } from './epub-styler';
import { collectInteriorImages } from './conversion-pipeline-assets';
import { resolveSourceCover } from './conversion-pipeline-source';

export interface FinalEpubBuildOptions {
  outputPath: string;
  finalMeta: Record<string, string>;
  chapters: ChapterEntry[];
  epub: { entries: Map<string, { data?: Buffer }>; imageFiles: string[]; };
  dataUriImages: EpubImage[];
  fontDir?: string;
  readerFriendly?: boolean;
  onProgress?: (pct: number, stage: string) => void | Promise<void>;
}

export async function buildFinalEpub(opts: FinalEpubBuildOptions): Promise<void> {
  const {
    outputPath,
    finalMeta,
    chapters,
    epub,
    dataUriImages,
    fontDir,
    readerFriendly,
    onProgress,
  } = opts;

  await onProgress?.(85, 'Embedding Literata font…');
  const resolvedFontDir = fontDir ?? path.resolve(process.cwd(), 'public/assets/fonts');
  const fontPaths: Record<string, string> = {};
  for (const f of ['Literata-Regular.ttf', 'Literata-Italic.ttf', 'Literata-Bold.ttf', 'Literata-BoldItalic.ttf']) {
    const fp = path.join(resolvedFontDir, f);
    if (fs.existsSync(fp)) fontPaths[f] = fp;
  }

  const coverInfo = resolveSourceCover(epub as any);
  if (coverInfo) {
    await onProgress?.(88, 'Embedding source cover…');
  }

  const interiorImages: EpubImage[] = [
    ...collectInteriorImages(epub as any, coverInfo?.sourceEntry ?? null),
    ...(dataUriImages ?? []),
  ];

  await onProgress?.(90, 'Building EPUB…');
  await buildEpub(
    {
      title: finalMeta.title,
      author: finalMeta.author,
      language: finalMeta.language,
      description: finalMeta.description,
      chapters,
      fontPaths: readerFriendly ? undefined : fontPaths,
      customCss: readerFriendly ? READER_FRIENDLY_CSS : undefined,
      coverImagePath: coverInfo?.path,
      images: interiorImages.length > 0 ? interiorImages : undefined,
    },
    outputPath,
  );

  if (coverInfo) {
    try { fs.unlinkSync(coverInfo.path); } catch { /* best effort */ }
  }
}

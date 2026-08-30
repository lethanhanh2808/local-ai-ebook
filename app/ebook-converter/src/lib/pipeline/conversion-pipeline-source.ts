import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ParsedEpub } from './epub-parser';

export interface ResolvedCover {
  path: string;
  ext: string;
  sourceEntry: string;
}

export function resolveSourceCover(epub: ParsedEpub): ResolvedCover | null {
  const opfDir = path.dirname(epub.opfPath);
  const resolveOpfRelative = (href: string): string =>
    (opfDir && opfDir !== '.' ? `${opfDir}/${href}` : href).replace(/^\/+/, '');

  let coverEntryName: string | null = null;

  const metaM = epub.opfContent.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/i);
  if (metaM) {
    const coverId = metaM[1];
    const itemRe = new RegExp(`<item[^>]+id="${coverId}"[^>]+href="([^"]+)"`, 'i');
    const itemM = epub.opfContent.match(itemRe);
    if (itemM) coverEntryName = resolveOpfRelative(itemM[1]);
  }

  if (!coverEntryName) {
    const propM = epub.opfContent.match(/<item[^>]+properties="cover-image"[^>]+href="([^"]+)"/i)
      ?? epub.opfContent.match(/<item[^>]+href="([^"]+)"[^>]*properties="cover-image"/i);
    if (propM) coverEntryName = resolveOpfRelative(propM[1]);
  }

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
  const sidecarPath = path.join(os.tmpdir(), `ebook-converter-source-cover-${process.pid}-${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(sidecarPath, buf);
  } catch (err) {
    console.warn('[pipeline] Failed to stage source cover for pass-through:', err);
    return null;
  }
  return { path: sidecarPath, ext, sourceEntry: coverEntryName };
}

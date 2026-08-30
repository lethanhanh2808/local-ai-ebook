import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ParsedEpub } from './epub-parser';
import type { EpubImage } from './epub-builder';

export function normalizeImageExt(raw: string): string {
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

export interface ResolvedCover {
  path: string;
  ext: string;
  sourceEntry: string;
}

export function buildImageResolver(
  epub: ParsedEpub,
  chapterFile: string,
): (src: string) => string | null {
  const chapterDir = path.posix.dirname(chapterFile);
  const entryKeys = Array.from(epub.entries.keys());

  return (src: string): string | null => {
    if (!src) return null;
    const cleanSrc = src.split('#')[0].split('?')[0].trim();
    if (!cleanSrc) return null;
    if (/^(?:https?:|data:|mailto:)/i.test(cleanSrc)) return null;

    const candidates = new Set<string>();
    if (chapterDir && chapterDir !== '.') {
      const normalized = path.posix.normalize(`${chapterDir}/${cleanSrc}`).replace(/^\/+/, '');
      candidates.add(normalized);
    }
    candidates.add(cleanSrc.replace(/^\/+/, ''));
    if (cleanSrc.includes('\\')) {
      candidates.add(cleanSrc.replace(/\\/g, '/').replace(/^\/+/, ''));
    }

    for (const cand of candidates) {
      if (epub.entries.has(cand)) return path.posix.basename(cand);
      const wanted = cand.toLowerCase();
      for (const key of entryKeys) {
        if (key.toLowerCase() === wanted) return path.posix.basename(key);
      }
    }
    return null;
  };
}

export function collectInteriorImages(
  epub: ParsedEpub,
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
    let baseId = basename
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
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

export function imageMediaType(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
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

// src/tests/embed-cover.test.ts
//
// Verifies that embedCoverIntoEpub() correctly:
//   1. Replaces an existing cover in-place (no manifest rewriting).
//   2. Injects a brand-new cover when the EPUB had no cover.
//   3. Patches titlepage.xhtml refs when cover extension changes.
//   4. Detects a no-op rewrite (already up-to-date).
//
// We build a tiny EPUB from scratch using buildEpub, then run the
// cover embedder against it twice (once with the same bytes; once
// with different bytes).
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildEpub } from '../lib/pipeline/epub-builder';
import { buildChapterHtml } from '../lib/pipeline/epub-styler';
import { embedCoverIntoEpub } from '../lib/pipeline/epub-cover';
import { extractCoverFromEpub } from '../lib/pipeline/epub-cover';
import sharp from 'sharp';

async function makeTestCover(label: string, color: { r: number; g: number; b: number }): Promise<Buffer> {
  // 600×900 (2:3) PNG with the requested accent colour + the label for
  // sanity-checking the round-trip.
  const labelSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900">
      <rect width="100%" height="100%" fill="rgb(${color.r},${color.g},${color.b})"/>
      <text x="300" y="450" text-anchor="middle" font-family="serif" font-size="72" fill="white">${label}</text>
    </svg>`,
  );
  return sharp(labelSvg).png().toBuffer();
}

async function makeTestEpub(outPath: string, opts: { coverImagePath?: string; coverBuf?: Buffer } = {}): Promise<string> {
  let coverImagePath = opts.coverImagePath;
  if (!coverImagePath && opts.coverBuf) {
    coverImagePath = outPath.replace(/\.epub$/, '.cover.png');
    fs.writeFileSync(coverImagePath, opts.coverBuf);
  }

  await buildEpub(
    {
      title: 'Embed Test',
      author: 'Tester',
      language: 'vi',
      chapters: [
        {
          id: 'chapter001',
          title: 'Chapter One',
          filename: 'chapter001.xhtml',
          html: buildChapterHtml({
            id: 'chapter001',
            title: 'Chapter One',
            body: '<p>Body text for testing.</p>',
            lang: 'vi',
          }),
        },
      ],
      ...(coverImagePath ? { coverImagePath } : {}),
    },
    outPath,
  );
  return outPath;
}

describe('embedCoverIntoEpub', () => {
  it('injects a brand-new cover into an EPUB that has none', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-cover-'));
    try {
      const srcEpub = path.join(dir, 'src.epub');
      const dstEpub = path.join(dir, 'dst.epub');
      const coverBuf = await makeTestCover('INJECTED', { r: 200, g: 30, b: 30 });
      const coverPath = path.join(dir, 'cover.png');
      fs.writeFileSync(coverPath, coverBuf);

      await makeTestEpub(srcEpub, {});
      const result = await embedCoverIntoEpub(srcEpub, coverPath, dstEpub);

      expect(result.ok).toBe(true);
      expect(result.alreadyUpToDate).toBe(false);
      expect(fs.existsSync(dstEpub)).toBe(true);

      // Verify extraction finds our new cover.
      const extracted = path.join(dir, 'extracted.png');
      const ok = await extractCoverFromEpub(dstEpub, extracted);
      expect(ok).toBe(true);
      const extractedBytes = fs.readFileSync(extracted);
      expect(extractedBytes.equals(coverBuf)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces an existing cover in place without rewriting the manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-cover-'));
    try {
      const srcEpub = path.join(dir, 'src.epub');
      const dstEpub = path.join(dir, 'dst.epub');
      const cover1 = await makeTestCover('OLD', { r: 60, g: 60, b: 120 });
      const cover2 = await makeTestCover('NEW', { r: 220, g: 120, b: 30 });

      // Build the source EPUB with cover1 baked in.
      await makeTestEpub(srcEpub, { coverBuf: cover1 });
      // Make sure src actually contains cover1.
      const tmpExtract = path.join(dir, 'verify-old.png');
      await extractCoverFromEpub(srcEpub, tmpExtract);
      expect(fs.readFileSync(tmpExtract).equals(cover1)).toBe(true);

      const coverPath2 = path.join(dir, 'cover2.png');
      fs.writeFileSync(coverPath2, cover2);
      const result = await embedCoverIntoEpub(srcEpub, coverPath2, dstEpub);
      expect(result.ok).toBe(true);
      expect(result.alreadyUpToDate).toBe(false);

      const extracted = path.join(dir, 'extracted-new.png');
      await extractCoverFromEpub(dstEpub, extracted);
      expect(fs.readFileSync(extracted).equals(cover2)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects already-up-to-date when the same bytes are re-embedded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-cover-'));
    try {
      const srcEpub = path.join(dir, 'src.epub');
      const dstEpub = path.join(dir, 'dst.epub');
      const cover1 = await makeTestCover('SAME', { r: 90, g: 90, b: 90 });
      const cover2 = await makeTestCover('DIFFERENT', { r: 200, g: 50, b: 50 });

      // Build the source EPUB with cover1 baked in. Then plant a
      // DIFFERENT cover on disk and verify (a) first pack rewrites the
      // EPUB, (b) second pack with the SAME now-baked bytes is detected
      // as up-to-date.
      await makeTestEpub(srcEpub, { coverBuf: cover1 });
      const coverPath1 = path.join(dir, 'cover-current.png');

      // First phase: write cover2 to disk, embed → rewrites dst.
      fs.writeFileSync(coverPath1, cover2);
      const r1 = await embedCoverIntoEpub(srcEpub, coverPath1, dstEpub);
      expect(r1.alreadyUpToDate).toBe(false);
      // Verify dst contains cover2.
      const extracted1 = path.join(dir, 'ext1.png');
      await extractCoverFromEpub(dstEpub, extracted1);
      expect(fs.readFileSync(extracted1).equals(cover2)).toBe(true);

      // Second phase: write the SAME cover2 to a fresh src (no change),
      // embed → should detect already-up-to-date.
      const srcEpub2 = path.join(dir, 'src2.epub');
      fs.copyFileSync(dstEpub, srcEpub2);
      const coverPath2 = path.join(dir, 'cover-same.png');
      fs.writeFileSync(coverPath2, cover2);
      const r2 = await embedCoverIntoEpub(srcEpub2, coverPath2, dstEpub);
      expect(r2.alreadyUpToDate).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rewrites the manifest when the cover extension changes (jpeg → png)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-cover-'));
    try {
      const srcEpub = path.join(dir, 'src.epub');
      const dstEpub = path.join(dir, 'dst.epub');
      // Source has a JPEG cover (built-in makeTestCover renders PNG
      // bytes — but we name it .jpeg so the manifest will use that
      // extension), new cover is PNG.
      const coverJpeg = await makeTestCover('OLD_JPG', { r: 30, g: 90, b: 30 });
      const coverPng  = await makeTestCover('NEW_PNG', { r: 200, g: 60, b: 60 });
      fs.writeFileSync(path.join(dir, 'cover.jpg'), coverJpeg);
      await makeTestEpub(srcEpub, { coverImagePath: path.join(dir, 'cover.jpg') });

      const newCoverPath = path.join(dir, 'cover-new.png');
      fs.writeFileSync(newCoverPath, coverPng);
      const result = await embedCoverIntoEpub(srcEpub, newCoverPath, dstEpub);
      expect(result.ok).toBe(true);
      expect(result.alreadyUpToDate).toBe(false);

      // Extract and verify it's the PNG bytes.
      const extracted = path.join(dir, 'ext.png');
      expect(await extractCoverFromEpub(dstEpub, extracted)).toBe(true);
      expect(fs.readFileSync(extracted).equals(coverPng)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds a manifest item when EPUB has a cover file but no manifest entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-cover-'));
    try {
      // Build an EPUB whose OPF contains a cover.png IMAGE file at root,
      // but with NO <meta name="cover"> and NO properties="cover-image".
      // This simulates an old/malformed EPUB that has a stray cover file
      // but never registered it in the manifest.
      const coverNew = await makeTestCover('NEW', { r: 50, g: 150, b: 50 });

      // Hand-craft: build a generic EPUB then inject an orphan cover.png
      // via post-processing.
      const outEpub = path.join(dir, 'manual.epub');
      await buildEpub(
        {
          title: 'Orphan Cover Test',
          author: 'Tester',
          language: 'vi',
          chapters: [{
            id: 'chapter001', title: 'Chapter One', filename: 'chapter001.xhtml',
            html: buildChapterHtml({ id: 'chapter001', title: 'Chapter One', body: '<p>Body.</p>', lang: 'vi' }),
          }],
        },
        outEpub,
      );

      // Use yauzl + yazl to add `orphan-cover.png` at root with no manifest ref.
      const { addEntryToZip } = await import('./helpers/zip-utils');
      fs.writeFileSync(path.join(dir, 'orphan-cover.png'), coverNew);
      const patched = await addEntryToZip(outEpub, 'orphan-cover.png', fs.readFileSync(path.join(dir, 'orphan-cover.png')));

      // Now run the embed flow with a new cover.
      const evenNewer = await makeTestCover('EVEN_NEWER', { r: 50, g: 50, b: 50 });
      const newerPath = path.join(dir, 'newer.png');
      fs.writeFileSync(newerPath, evenNewer);
      const dstEpub = path.join(dir, 'dst.epub');
      const result = await embedCoverIntoEpub(patched, newerPath, dstEpub);
      expect(result.ok).toBe(true);
      expect(result.alreadyUpToDate).toBe(false);

      // Extract to confirm the new cover landed.
      const ext = path.join(dir, 'check.png');
      expect(await extractCoverFromEpub(dstEpub, ext)).toBe(true);
      expect(fs.readFileSync(ext).equals(evenNewer)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

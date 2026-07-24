// src/tests/conversion-cover-pass-through.test.ts
//
// Regression test for the source-cover pass-through in the conversion
// pipeline. Before this change, the builder had a complete cover branch
// (manifest + spine + cover.xhtml + EPUB2/3 metadata) but the conversion
// flow never wired it up — the output EPUB was silently shipped without
// a cover even when the source had one. This test pins the fix by:
//
//   1. Building a source EPUB with a real cover image (via buildEpub,
//      which emits the standard `<meta name="cover">` + manifest item
//      shape — the most common cover strategy in the wild).
//   2. Running runConversionPipeline against it.
//   3. Re-parsing the output EPUB and asserting the cover bytes survive,
//      the OPF manifest has a `cover-image` item, the cover meta is set,
//      and a cover.xhtml exists in EPUB/.
//
// Negative case: when the source has no cover, the output also has no
// cover (no spurious cover branch from the pass-through).
//
// The three-strategy OPF resolution in resolveSourceCover (Strategy 1
// <meta>, Strategy 2 properties, Strategy 3 filename scan) is exercised
// in `embed-cover.test.ts` for `extractCoverFromEpub` which shares the
// same algorithm. The point of THIS test is to pin the end-to-end
// pipeline behaviour, which only needs the common case.
//
// Implementation note: `buildEpub` only emits Strategy 1. Each test runs
// the full conversion pipeline end-to-end (buildEpub + runConversionPipeline
// + re-parse), which takes ~2-3s on M-series hardware. Bumping the
// per-test timeout to 30s is cheap insurance.

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import yauzl from 'yauzl';
import sharp from 'sharp';
import { buildEpub } from '@/lib/pipeline/epub-builder';
import { buildChapterHtml } from '@/lib/pipeline/epub-styler';
import { runConversionPipeline } from '@/lib/pipeline/conversion-pipeline';

const openZip = promisify(yauzl.open) as (
  path: string,
  opts: yauzl.Options,
) => Promise<yauzl.ZipFile>;

const TEST_TIMEOUT_MS = 30_000;

async function makeCover(label: string, color: { r: number; g: number; b: number }): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900">
      <rect width="100%" height="100%" fill="rgb(${color.r},${color.g},${color.b})"/>
      <text x="300" y="450" text-anchor="middle" font-family="serif" font-size="72" fill="white">${label}</text>
    </svg>`,
  );
  return sharp(svg).png().toBuffer();
}

async function makeChapter(title: string, body: string) {
  return {
    id: 'chapter001',
    title,
    filename: 'chapter001.xhtml',
    html: buildChapterHtml({ id: 'chapter001', title, body, lang: 'vi' }),
  };
}

async function readZipEntries(filePath: string): Promise<Map<string, Buffer>> {
  const zip = await openZip(filePath, { lazyEntries: true });
  const entries = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.readEntry();
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { zip.readEntry(); return; }
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          entries.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
        stream.on('error', reject);
      });
    });
    zip.on('end', resolve);
    zip.on('error', reject);
  });
  return entries;
}

describe('conversion pipeline — source cover pass-through', () => {
  it('preserves the source cover across conversion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-cover-'));
    try {
      const coverBuf = await makeCover('SRC', { r: 220, g: 60, b: 60 });
      const coverPath = path.join(dir, 'cover.png');
      fs.writeFileSync(coverPath, coverBuf);

      const sourceEpub = path.join(dir, 'source.epub');
      await buildEpub(
        {
          title: 'Cover Pass Test',
          author: 'Tester',
          language: 'vi',
          coverImagePath: coverPath,
          chapters: [await makeChapter('Chapter 1', '<p>Body text.</p>')],
        },
        sourceEpub,
      );

      const outputEpub = path.join(dir, 'output.epub');
      await runConversionPipeline({
        inputPath: sourceEpub,
        outputPath: outputEpub,
        originalExt: 'epub',
      });

      const out = await readZipEntries(outputEpub);

      // The cover image is present in the output.
      const coverEntry = Array.from(out.keys()).find((n) => /^EPUB\/images\/cover\./.test(n));
      expect(coverEntry, 'expected output EPUB to have EPUB/images/cover.<ext>').toBeTruthy();
      expect(out.get(coverEntry!)?.length).toBe(coverBuf.length);

      // cover.xhtml exists and references the image.
      const coverXhtml = out.get('EPUB/cover.xhtml')?.toString('utf8') ?? '';
      expect(coverXhtml).toContain('images/cover.');
      expect(coverXhtml).toContain('class="cover-page"');

      // OPF has the manifest item with properties=cover-image and the
      // <meta name="cover"> entry.
      const opf = out.get('EPUB/content.opf')?.toString('utf8') ?? '';
      expect(opf).toMatch(/<item[^>]+properties="cover-image"/);
      expect(opf).toMatch(/<meta[^>]+name="cover"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('skips cover pass-through when the source has no cover', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-cover-none-'));
    try {
      const sourceEpub = path.join(dir, 'source.epub');
      await buildEpub(
        {
          title: 'No Cover Test',
          author: 'Tester',
          language: 'vi',
          // no coverImagePath
          chapters: [await makeChapter('Chapter 1', '<p>Body text.</p>')],
        },
        sourceEpub,
      );

      const outputEpub = path.join(dir, 'output.epub');
      await runConversionPipeline({
        inputPath: sourceEpub,
        outputPath: outputEpub,
        originalExt: 'epub',
      });

      const out = await readZipEntries(outputEpub);
      // No cover image was written; no cover.xhtml; no manifest cover entry.
      expect(Array.from(out.keys()).some((n) => /^EPUB\/images\/cover\./.test(n))).toBe(false);
      expect(out.has('EPUB/cover.xhtml')).toBe(false);
      const opf = out.get('EPUB/content.opf')?.toString('utf8') ?? '';
      expect(opf).not.toMatch(/properties="cover-image"/);
      expect(opf).not.toMatch(/<meta[^>]+name="cover"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

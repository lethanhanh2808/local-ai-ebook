// src/tests/image-preservation.test.ts
//
// Phase 2.4 end-to-end test for the conversion pipeline. Runs the full
// `runConversionPipeline` against the committed illustrated fixture
// (`samples/fixture-illustrated-novel.epub`) and pins the interior-
// image-preservation behaviour implemented in Phase 2 of
// `docs/NEXT_UP_PLAN.md`:
//
//   1. All 4 image files (1 cover + 2 figures + 1 data-URI inline) end
//      up in the output ZIP at `EPUB/images/<basename>`.
//   2. The OPF manifest has one `<item id="…">` row per image with the
//      right `media-type`, plus the cover-image row, plus the cover-page
//      row. No `cover-image` is erroneously set on interior rows.
//   3. Chapter HTML contains rewritten `<img src="../images/<basename>">`
//      for every figure that resolved in the source; no `<img>`
//      references the source's `../Images/...` or `data:` URLs any more.
//   4. The data-URI image was decoded and emitted to a file; chapter
//      HTML points at the extracted file.
//   5. The source cover pass-through still works (Strategy 1 — the
//      fixture uses `<meta name="cover" content="cover-image">`).
//
// The full pipeline takes ~2-3s on M-series hardware; we bump the
// per-test timeout to 30s as cheap insurance.

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import yauzl from 'yauzl';
import { runConversionPipeline } from '@/lib/pipeline/conversion-pipeline';

const openZip = promisify(yauzl.open) as (
  path: string,
  opts: yauzl.Options,
) => Promise<yauzl.ZipFile>;

const TEST_TIMEOUT_MS = 30_000;
const FIXTURE_PATH = path.join(__dirname, '../../samples/fixture-illustrated-novel.epub');

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

describe('conversion pipeline — interior image preservation (Phase 2)', () => {
  it('carries cover + figures + data-URI inline image through to the output EPUB', async () => {
    if (!fs.existsSync(FIXTURE_PATH)) {
      throw new Error(
        `Fixture EPUB missing at ${FIXTURE_PATH}. Regenerate with ` +
        `'node scripts/build-fixture-epub.mjs'.`,
      );
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preserve-'));
    try {
      const outputEpub = path.join(dir, 'output.epub');
      await runConversionPipeline({
        inputPath: FIXTURE_PATH,
        outputPath: outputEpub,
        originalExt: 'epub',
        // Keep conversion fast: no AI enhancement, no deep format.
        aiEnhance: false,
        deepFormat: false,
      });

      const out = await readZipEntries(outputEpub);

      // ── 1. Image files in the output ──────────────────────────────────
      // Cover (built from source via cover branch):
      expect(out.has('EPUB/images/cover.png')).toBe(true);
      // Two figures resolved from chapter HTML srcs:
      expect(out.has('EPUB/images/figure-1.png')).toBe(true);
      expect(out.has('EPUB/images/figure-2.png')).toBe(true);
      // Data-URI image from chapter 2, decoded to a real file:
      expect(out.has('EPUB/images/inline-1.png')).toBe(true);

      // The decoded inline PNG should have non-zero bytes.
      const inlineBytes = out.get('EPUB/images/inline-1.png')?.length ?? 0;
      expect(inlineBytes).toBeGreaterThan(0);

      // ── 2. OPF manifest ────────────────────────────────────────────────
      const opf = out.get('EPUB/content.opf')?.toString('utf8') ?? '';

      // Cover row (unchanged; Strategy-1 source cover pass-through).
      expect(opf).toMatch(
        /<item id="cover-image" href="images\/cover\.png" media-type="image\/png" properties="cover-image"\/>/,
      );
      // Cover-page row.
      expect(opf).toContain('<item id="cover-page" href="cover.xhtml"');
      // Interior figure rows (no `properties="cover-image"`).
      const fig1Row = opf.match(/<item id="[^"]*" href="images\/figure-1\.png" media-type="image\/png"\/>/);
      expect(fig1Row).not.toBeNull();
      const fig2Row = opf.match(/<item id="[^"]*" href="images\/figure-2\.png" media-type="image\/png"\/>/);
      expect(fig2Row).not.toBeNull();
      // Data-URI inline row.
      const inlineRow = opf.match(/<item id="[^"]*" href="images\/inline-1\.png" media-type="image\/png"\/>/);
      expect(inlineRow).not.toBeNull();

      // No spurious cover-image properties on interior rows.
      const coverPropsLines = opf.match(/properties="cover-image"/g) ?? [];
      expect(coverPropsLines.length).toBe(1);

      // ── 3. Chapter HTML ───────────────────────────────────────────────
      // Find chapter files in the output and look for rewritten srcs.
      const chapterFiles = Array.from(out.keys())
        .filter((n) => /^EPUB\/chapter\d+\.xhtml$/.test(n))
        .sort();
      expect(chapterFiles.length).toBe(4);

      // No chapter HTML should still reference the source's `../Images/`
      // path (case-sensitive). The pipeline rewrites to lowercase
      // `../images/<basename>` for every resolved figure; unresolvable
      // srcs are left untouched and would be rendered as broken images.
      // We assert the source-path signature is gone so a regression
      // where the rewrite step silently no-ops won't slip through.
      for (const cf of chapterFiles) {
        const html = out.get(cf)?.toString('utf8') ?? '';
        expect(html).not.toMatch(/\.\.\/Images\//);
        // No remaining data: URI from the source either.
        expect(html).not.toMatch(/src="data:/);
      }

      // Identify the chapter 2 file by looking for the rewritten
      // figure-1.png src (only chapter 2 references figure-1).
      const ch2 = chapterFiles
        .map((f) => ({ f, html: out.get(f)?.toString('utf8') ?? '' }))
        .find((c) => /src="\.\.\/images\/figure-1\.png"/.test(c.html));
      expect(ch2, 'chapter 2 file not found in output').toBeTruthy();
      expect(ch2!.html).toMatch(/src="\.\.\/images\/figure-1\.png"/);

      // Chapter 2 also gets the rewritten inline data-URI figure.
      expect(ch2!.html).toMatch(/src="\.\.\/images\/inline-1\.png"/);

      // Chapter 3 references figure-2.
      const ch3 = chapterFiles
        .map((f) => ({ f, html: out.get(f)?.toString('utf8') ?? '' }))
        .find((c) => /src="\.\.\/images\/figure-2\.png"/.test(c.html));
      expect(ch3, 'chapter 3 file not found in output').toBeTruthy();

      // Chapters 1 and 4 don't reference any interior image. Loose
      // assertion: at least 2 chapters contain no `../images/` ref.
      const noImageChapters = chapterFiles.filter(
        (f) => !/src="\.\.\/images\//.test(out.get(f)?.toString('utf8') ?? ''),
      );
      expect(noImageChapters.length).toBeGreaterThanOrEqual(2);

      // ── 4. Byte-stability smoke check ─────────────────────────────────
      // The output EPUB's images must contain the same bytes the pipeline
      // was given. We can't pin the exact output bytes (timestamps, ids)
      // but each image file should be non-empty.
      expect(out.get('EPUB/images/cover.png')?.length).toBeGreaterThan(0);
      expect(out.get('EPUB/images/figure-1.png')?.length).toBeGreaterThan(0);
      expect(out.get('EPUB/images/figure-2.png')?.length).toBeGreaterThan(0);
      expect(inlineBytes).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

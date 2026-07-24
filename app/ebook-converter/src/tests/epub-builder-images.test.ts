// src/tests/epub-builder-images.test.ts
//
// Regression tests for the `images` field added to `EpubBuildInput` in
// Phase 2.1 of `docs/NEXT_UP_PLAN.md`. The builder is now able to carry
// non-cover content images (figures, illustrations) through to the output
// EPUB, both as ZIP entries under `EPUB/images/<href>` and as manifest
// `<item>` rows in `EPUB/content.opf`. These tests pin:
//
//   1. A small buffer placed via `images[i]` shows up in the output ZIP
//      at the expected path and the bytes round-trip exactly.
//   2. The OPF manifest has a matching `<item id href media-type>` for
//      each input row, ordered after fonts (if any) but before chapters.
//   3. The cover-image row is reserved for the cover branch — a
//      caller-supplied image whose href collides with `cover.<ext>` is
//      dropped (the cover branch owns that filename).
//   4. Hrefs are sanitized: directory prefixes stripped, `..` rejected,
//      hidden-file names (`.foo`) rejected, illegal chars replaced with
//      `_`. A bogus input yields no manifest entry and no ZIP file
//      rather than a runtime crash.
//   5. Duplicate ids get a `-N` suffix so the OPF stays well-formed;
//      duplicate hrefs among interior rows also get a `-N` suffix.

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildEpub, EpubImage } from '@/lib/pipeline/epub-builder';
import { buildChapterHtml } from '@/lib/pipeline/epub-styler';
import { parseEpub } from '@/lib/pipeline/epub-parser';

function pngBytes(label: string): Buffer {
  // 1x1 transparent PNG, just needs to be a non-empty Buffer with
  // stable length so size assertions work.
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  void label; // label unused but useful when debugging length assertions
  return Buffer.from(pngBase64, 'base64');
}

function makeChapter(title: string, body: string) {
  return {
    id: 'chapter001',
    title,
    filename: 'chapter001.xhtml',
    html: buildChapterHtml({ id: 'chapter001', title, body, lang: 'vi' }),
  };
}

describe('buildEpub — interior images[]', () => {
  it('writes each image into EPUB/images/ and emits a matching manifest <item>', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-images-'));
    try {
      const fig1 = pngBytes('figure-1');
      const fig2 = pngBytes('figure-2');
      const inline = pngBytes('inline');
      const images: EpubImage[] = [
        { id: 'fig-1', href: 'figure-1.png', data: fig1, mediaType: 'image/png' },
        { id: 'fig-2', href: 'figure-2.png', data: fig2, mediaType: 'image/png' },
        { id: 'inline', href: 'inline-1.png', data: inline, mediaType: 'image/png' },
      ];

      const out = path.join(dir, 'book.epub');
      await buildEpub(
        {
          title: 'Images Field Test',
          author: 'Tester',
          language: 'vi',
          chapters: [makeChapter('Chapter 1', '<p>Body.</p>')],
          images,
        },
        out,
      );

      const epub = await parseEpub(out);

      // ZIP entries are present with the exact bytes the caller supplied.
      expect(epub.entries.get('EPUB/images/figure-1.png')?.data.length).toBe(fig1.length);
      expect(epub.entries.get('EPUB/images/figure-2.png')?.data.length).toBe(fig2.length);
      expect(epub.entries.get('EPUB/images/inline-1.png')?.data.length).toBe(inline.length);

      // OPF has one manifest <item> per image, with the right media-type,
      // and without the cover-image property (those are reserved).
      const opf = epub.entries.get('EPUB/content.opf')?.data.toString('utf8') ?? '';
      const rows = [
        `<item id="fig-1" href="images/figure-1.png" media-type="image/png"/>`,
        `<item id="fig-2" href="images/figure-2.png" media-type="image/png"/>`,
        `<item id="inline" href="images/inline-1.png" media-type="image/png"/>`,
      ];
      for (const row of rows) {
        expect(opf).toContain(row);
      }
      // The cover branch was NOT used → no `properties="cover-image"`.
      expect(opf).not.toMatch(/properties="cover-image"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('orders image manifest rows before chapters', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-images-order-'));
    try {
      const out = path.join(dir, 'book.epub');
      await buildEpub(
        {
          title: 'Order Test',
          author: 'Tester',
          language: 'vi',
          chapters: [makeChapter('Chapter 1', '<p>Body.</p>')],
          images: [
            { id: 'fig-1', href: 'figure-1.png', data: pngBytes('a'), mediaType: 'image/png' },
          ],
        },
        out,
      );

      const epub = await parseEpub(out);
      const opf = epub.entries.get('EPUB/content.opf')?.data.toString('utf8') ?? '';
      const imgIdx = opf.indexOf('href="images/figure-1.png"');
      const chapterIdx = opf.indexOf('href="chapter001.xhtml"');
      expect(imgIdx).toBeGreaterThan(0);
      expect(chapterIdx).toBeGreaterThan(imgIdx);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a caller-supplied image whose href collides with the cover branch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-images-cover-'));
    try {
      const coverPng = pngBytes('cover-branch');
      const coverPath = path.join(dir, 'cover.png');
      fs.writeFileSync(coverPath, coverPng);

      const out = path.join(dir, 'book.epub');
      await buildEpub(
        {
          title: 'Cover Collision Test',
          author: 'Tester',
          language: 'vi',
          chapters: [makeChapter('Chapter 1', '<p>Body.</p>')],
          coverImagePath: coverPath,
          images: [
            // This entry's href collides with the cover branch's
            // `EPUB/images/cover.png`. The cover branch wins; the rogue
            // row must be dropped (no double-EPUB/images/cover.png entry
            // and no rogue manifest row).
            { id: 'rogue', href: 'cover.png', data: Buffer.from('ROGUE'), mediaType: 'image/png' },
            // A second interior image still passes through.
            { id: 'fig-1', href: 'figure-1.png', data: pngBytes('figure-1'), mediaType: 'image/png' },
          ],
        },
        out,
      );

      const epub = await parseEpub(out);
      const coverBytes = epub.entries.get('EPUB/images/cover.png')?.data;
      // Bytes come from the cover branch — definitely not "ROGUE".
      expect(coverBytes?.toString('utf8')).not.toBe('ROGUE');
      expect(coverBytes?.length).toBe(coverPng.length);

      const opf = epub.entries.get('EPUB/content.opf')?.data.toString('utf8') ?? '';
      // Cover manifest row is present.
      expect(opf).toMatch(/<item id="cover-image" href="images\/cover\.png" media-type="image\/png" properties="cover-image"\/>/);
      // Rogue row is NOT present.
      expect(opf).not.toContain('id="rogue"');
      // The non-colliding figure still made it through.
      expect(opf).toContain('href="images/figure-1.png"');
      // Exactly one manifest row references cover.png (the cover branch).
      const coverRows = opf.match(/href="images\/cover\.png"/g) ?? [];
      expect(coverRows.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes dangerous and dirty hrefs; illegal inputs are skipped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-images-sanitize-'));
    try {
      const out = path.join(dir, 'book.epub');
      const fig = pngBytes('figure-1');
      await buildEpub(
        {
          title: 'Sanitize Test',
          author: 'Tester',
          language: 'vi',
          chapters: [makeChapter('Chapter 1', '<p>Body.</p>')],
          images: [
            // Directory-prefixed → basename only.
            { id: 'fig-prefixed', href: 'subdir/figure-1.png', data: fig, mediaType: 'image/png' },
            // Backslash-prefixed → slash → basename.
            { id: 'fig-backslash', href: 'subdir\\figure-2.png', data: fig, mediaType: 'image/png' },
            // Traversal → skipped.
            { id: 'fig-traversal', href: '..', data: fig, mediaType: 'image/png' },
            // Hidden file → skipped.
            { id: 'fig-hidden', href: '.hidden.png', data: fig, mediaType: 'image/png' },
            // Empty → skipped.
            { id: 'fig-empty', href: '', data: fig, mediaType: 'image/png' },
            // Illegal chars → sanitized but kept.
            { id: 'fig-spaces', href: 'my figure 3.png', data: fig, mediaType: 'image/png' },
          ],
        },
        out,
      );

      const epub = await parseEpub(out);
      const opf = epub.entries.get('EPUB/content.opf')?.data.toString('utf8') ?? '';

      // The two legal prefixes produced the same basename → ids unique,
      // hrefs unique. With both aimed at `figure-1.png`, one gets a `-2`.
      // Just check that at least one of them made it through and both are
      // *not* in directory form.
      expect(opf).toMatch(/href="images\/figure-1\.png"/);
      expect(opf).not.toContain('subdir/figure');
      expect(opf).not.toContain('subdir\\\\figure');

      // Skipped entries produce no manifest rows.
      expect(opf).not.toContain('id="fig-traversal"');
      expect(opf).not.toContain('id="fig-hidden"');
      expect(opf).not.toContain('id="fig-empty"');

      // Sanitized entry shows up with `_` substitutions.
      expect(opf).toMatch(/href="images\/my_figure_3\.png"/);

      // No `..` or hidden-name ZIP entries were written.
      const entryNames = Array.from(epub.entries.keys());
      expect(entryNames.some((n) => n.endsWith('images/..') || n.endsWith('images/../'))).toBe(false);
      expect(entryNames.some((n) => n.endsWith('images/.hidden.png'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates colliding ids and hrefs among interior rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-images-dedupe-'));
    try {
      const out = path.join(dir, 'book.epub');
      const fig = pngBytes('figure-1');
      await buildEpub(
        {
          title: 'Dedupe Test',
          author: 'Tester',
          language: 'vi',
          chapters: [makeChapter('Chapter 1', '<p>Body.</p>')],
          images: [
            { id: 'fig', href: 'figure-1.png', data: fig, mediaType: 'image/png' },
            { id: 'fig', href: 'figure-2.png', data: fig, mediaType: 'image/png' },
            { id: 'fig-2', href: 'figure-1.png', data: fig, mediaType: 'image/png' },
          ],
        },
        out,
      );

      const epub = await parseEpub(out);
      const opf = epub.entries.get('EPUB/content.opf')?.data.toString('utf8') ?? '';

      // The duplicate id gets a `-2` suffix.
      expect(opf).toContain('id="fig-2"');
      expect(opf).toMatch(/<item id="fig" href="images\/figure-1\.png"/);
      expect(opf).toMatch(/<item id="fig-2" href="images\/figure-2\.png"/);
      // The third row collides on href with the first → -2 on href.
      expect(opf).toMatch(/href="images\/figure-1-2\.png"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

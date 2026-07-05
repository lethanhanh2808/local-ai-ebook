// src/tests/epub-builder.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildEpub } from '../lib/pipeline/epub-builder';
import { buildChapterHtml } from '../lib/pipeline/epub-styler';
import { parseEpub } from '../lib/pipeline/epub-parser';

describe('buildEpub', () => {
  it('creates EPUB3 navigation with landmarks and nested heading anchors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-builder-'));
    const out = path.join(dir, 'book.epub');
    try {
      await buildEpub(
        {
          title: 'Standard Test',
          author: 'Author',
          language: 'vi',
          chapters: [
            {
              id: 'chapter001',
              title: 'Chapter One',
              filename: 'chapter001.xhtml',
              html: buildChapterHtml({
                id: 'chapter001',
                title: 'Chapter One',
                body: '<h2>Section A</h2><p>Text</p>',
                lang: 'vi',
              }),
            },
          ],
        },
        out,
      );

      const epub = await parseEpub(out);
      expect(epub.entries.get('mimetype')?.data.toString('utf8')).toBe('application/epub+zip');
      const nav = epub.entries.get('EPUB/nav.xhtml')?.data.toString('utf8') ?? '';
      expect(nav).toContain('epub:type="toc"');
      expect(nav).toContain('epub:type="landmarks"');
      expect(nav).toContain('chapter001.xhtml#chapter001');
      expect(nav).toContain('chapter001.xhtml#chapter001-h2-1');
      const opf = epub.entries.get('EPUB/content.opf')?.data.toString('utf8') ?? '';
      expect(opf).toContain('properties="nav"');
      expect(opf).toContain('schema:accessibilityFeature');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

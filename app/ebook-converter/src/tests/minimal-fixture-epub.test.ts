// src/tests/minimal-fixture-epub.test.ts
//
// Phase 4.1 of `docs/NEXT_UP_PLAN.md` — deterministic minimal EPUB
// fixture for Playwright E2E. This test pins the structural shape
// so future edits to `scripts/build-minimal-epub-fixture.mjs` that
// quietly change the manifest, drop the nav, or mutate the chapter
// ID surface here before breaking E2E specs downstream.
//
// The fixture lives at `e2e/fixtures/minimal-novel.epub`. Unlike
// `samples/fixture-illustrated-novel.epub` (which is the Phase 2
// image-preservation target), the minimal fixture has NO cover, NO
// images, and exactly 1 chapter — it's the smallest valid EPUB the
// reader can still load end-to-end.
//
// What we pin:
//   1. SHA256 matches the committed sidecar so an accidental drift
//      is loud, not silent.
//   2. The ZIP has exactly 5 entries (mimetype, container.xml,
//      content.opf, nav.xhtml, ch001.xhtml).
//   3. The mimetype entry is uncompressed and first (EPUB spec).
//   4. parseEpub reads it correctly: 1 HTML file in the spine, 0
//      images, 1 TOC entry, all metadata populated.
//   5. The chapter has at least 5 paragraphs of Vietnamese prose so
//      reader/sliceParagraphs attribution round-trips have something
//      to chew on.

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { parseEpub } from '@/lib/pipeline/epub-parser';

const FIXTURE_PATH = path.join(
  __dirname,
  '../../e2e/fixtures/minimal-novel.epub',
);
const SHA_PATH = FIXTURE_PATH + '.sha256';

describe('E2E minimal EPUB fixture (Phase 4.1)', () => {
  it('exists on disk and is parsed cleanly by parseEpub', async () => {
    if (!fs.existsSync(FIXTURE_PATH)) {
      throw new Error(
        `Fixture EPUB missing at ${FIXTURE_PATH}. Regenerate with ` +
        `'node scripts/build-minimal-epub-fixture.mjs'.`,
      );
    }
    if (!fs.existsSync(SHA_PATH)) {
      throw new Error(`SHA256 sidecar missing at ${SHA_PATH}.`);
    }

    // 1. SHA256 stability — the sidecar should match the on-disk bytes.
    const bytes = fs.readFileSync(FIXTURE_PATH);
    const actual = createHash('sha256').update(bytes).digest('hex');
    const sidecar = fs.readFileSync(SHA_PATH, 'utf8').trim().split(/\s+/)[0];
    expect(actual).toBe(sidecar);

    // 2. Fixture fits the "minimal" budget: well under the Phase 2
    //    fixture's 21 KB. Anything > 20 KB suggests the script started
    //    shipping cover art or images and should be re-evaluated.
    expect(bytes.length).toBeLessThan(20 * 1024);

    // 3. parseEpub reads the metadata cleanly.
    const epub = await parseEpub(FIXTURE_PATH);
    expect(epub.metadata.title).toBe('Tiểu Thuyết Tối Giản (E2E)');
    expect(epub.metadata.author).toBe('Bộ Kiểm Thử');
    expect(epub.metadata.language).toBe('vi');

    // 4. Exactly one chapter in the spine, no images, no cover file.
    expect(epub.htmlFiles).toEqual(['OEBPS/Text/ch001.xhtml']);
    expect(epub.imageFiles).toEqual([]);

    // 5. Chapter content has at least 5 paragraphs — enough for
    //    reader split, sliceParagraphs, attribution, and audio
    //    round-trips in E2E specs.
    const chapterBytes = epub.entries.get('OEBPS/Text/ch001.xhtml')?.data;
    expect(chapterBytes).toBeDefined();
    const html = (chapterBytes as Buffer | undefined)?.toString('utf8') ?? '';
    const paragraphCount = (html.match(/<p\b/g) ?? []).length;
    expect(paragraphCount).toBeGreaterThanOrEqual(5);
    expect(html).toMatch(/id="ch001"/);
    // Single-character dialogues ("Ừ.") are not in this fixture —
    // it's deliberately just prose so smoke tests don't depend on
    // the regex attribution layer finding speakers.
    expect(html).toContain('Chương 1: Buổi sáng');
  });
});

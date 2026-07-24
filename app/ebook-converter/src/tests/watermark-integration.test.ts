// src/tests/watermark-integration.test.ts
//
// Integration test: takes the real DTV-style example book shipped in the
// repo (exmple-books/Chiem Doat Vo Yeu - Tieu Ngon.epub) and verifies that
//   1. The shared detector correctly identifies all three watermark
//      phrases (<div class="header">title</div>, <div class="author">
//      author</div>, <div class="author">url</div>) on every chapter.
//   2. stripWatermarks removes them + their wrapping <div> envelopes
//      cleanly so a "rerun on this book" pass would actually clear the
//      watermarks.
//
// We don't hit the filesystem directly here because the example book
// isn't always present in CI; instead we reconstruct a minimal but
// faithful chapter shape from the parsed-file structure and exercise the
// same code path the endpoints take.

import { describe, it, expect } from 'vitest';
import {
  splitChapterIntoPhrases,
  detectFromChaptersHtml,
} from '@/lib/pipeline/watermark-detect';
import { stripWatermarks, countPhraseHits } from '@/lib/pipeline/watermark-strip';

/** Reconstruct a single chapter from the real DTV book chapter 0. */
function reconstructedChapter(bodyIdx = 0): string {
  const chapters = [
    // C0 (full chapter)
    '<div class="header">Chiếm Đoạt Vợ Yêu</div>'
    + '<div class="author">Tiểu Ngôn</div>'
    + '<div class="author">www.dtv-ebook.com</div>'
    + '<h4 id="C0" class="calibre1">Chương 1</h4>'
    + '<p class="calibre3">“Lão đại yêu, Nhâm lão đại yêu quý…”</p>'
    + '<p class="calibre3">“Ai da……” Nhìn thấy một đôi mắt kinh hãi…</p>',
    // C5 (short chapter — represents a transition / author's-note style)
    '<div class="header">Chiếm Đoạt Vợ Yêu</div>'
    + '<div class="author">Tiểu Ngôn</div>'
    + '<div class="author">www.dtv-ebook.com</div>'
    + '<h4 id="C5" class="calibre1">Chương 6</h4>'
    + '<p class="calibre3">“Đủ rồi, Thiếu Hoài…… Người ta thật sự mệt mỏi quá rồi.”</p>',
  ];
  return `<html><body>${chapters[bodyIdx] ?? chapters[0]}</body></html>`;
}

describe('DTV-style integration', () => {
  it('detects all three watermark phrases in 100% of chapters', () => {
    const chapters = Array.from({ length: 10 }, (_, i) => ({
      html: reconstructedChapter(i % 2),
    }));
    const detected = detectFromChaptersHtml(chapters, { threshold: 0.4 });
    expect(detected).toContain('Chiếm Đoạt Vợ Yêu');
    expect(detected).toContain('Tiểu Ngôn');
    expect(detected).toContain('www.dtv-ebook.com');
  });

  it('detects the title phrase via the LIVE chapter HTML shape (after buildChapterHtml wrap)', () => {
    // The converter writes the title into an <h1> alongside the original
    // <h4>Chương N</h4>. Verify the detector still classifies "Chương N"
    // lines as heading-skip but keeps the watermark div text.
    const html = '<section>'
      + '<h1 id="chapter001-title">Chương 1</h1>'
      + '<div class="header">Chiếm Đoạt Vợ Yêu</div>'
      + '<div class="author">Tiểu Ngôn</div>'
      + '<div class="author">www.dtv-ebook.com</div>'
      + '<h4 id="C0" class="calibre1">Chương 1</h4>'
      + '<p>story</p>'
      + '</section>';
    const phrases = splitChapterIntoPhrases(html);
    expect(phrases).toContain('Chiếm Đoạt Vợ Yêu');
    expect(phrases).toContain('Tiểu Ngôn');
    expect(phrases).toContain('www.dtv-ebook.com');
    // Both <h1> and <h4> Chương 1 entries should be filtered.
    expect(phrases.filter((p) => p === 'Chương 1')).toHaveLength(0);
    expect(phrases).toContain('story');
  });

  it('stripWatermarks removes the three phrases AND their <div> wrappers', () => {
    const html = reconstructedChapter(0);
    const out = stripWatermarks(html, [
      'Chiếm Đoạt Vợ Yêu',
      'Tiểu Ngôn',
      'www.dtv-ebook.com',
    ]);
    // Each phrase removed
    expect(out).not.toContain('Chiếm Đoạt Vợ Yêu');
    expect(out).not.toContain('Tiểu Ngôn');
    // URL with dots should be gone too (dot is just literal text here)
    expect(out).not.toContain('www.dtv-ebook.com');
    // The wrapping <div class="header"> / <div class="author"> should be
    // gone too (we strip the whole element when its text matches).
    expect(out).not.toContain('<div class="header">');
    expect(out).not.toContain('<div class="author">');
    // Story content survives.
    expect(out).toContain('Lão đại yêu');
  });

  it('countPhraseHits reflects per-element matching (no double-count from raw substring)', () => {
    const html = reconstructedChapter(0);
    const counts = countPhraseHits(html, ['www.dtv-ebook.com']);
    // One matching <div>; raw substring outside any matching div is none.
    expect(counts[0].hits).toBe(1);
  });

  it('stripWatermarks is idempotent (running it twice produces the same result)', () => {
    const html = reconstructedChapter(0);
    const once = stripWatermarks(html, ['Chiếm Đoạt Vợ Yêu']);
    const twice = stripWatermarks(once, ['Chiếm Đoạt Vợ Yêu']);
    expect(twice).toBe(once);
  });
});

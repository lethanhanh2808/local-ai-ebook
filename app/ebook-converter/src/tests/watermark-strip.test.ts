// src/tests/watermark-strip.test.ts
//
// Verifies the wrapper-aware strip pass. The legacy <p>-only implementation
// would leave empty <div class="header">/... wrappers behind; we now strip
// any of <p>, <div>, <span>, <h1>..<h6> whose plain text contains the saved
// phrase.

import { describe, it, expect } from 'vitest';
import { stripWatermarks, countPhraseHits } from '@/lib/pipeline/watermark-strip';

describe('stripWatermarks', () => {
  it('drops a whole <div class="header"> wrapping a saved phrase', () => {
    const html = '<div class="header">Chiếm Đoạt Vợ Yêu</div>'
      + '<p>Real chapter content.</p>';
    const out = stripWatermarks(html, ['Chiếm Đoạt Vợ Yêu']);
    expect(out).not.toContain('Chiếm Đoạt Vợ Yêu');
    expect(out).not.toContain('<div class="header">');
    expect(out).toContain('Real chapter content.');
  });

  it('drops <span> wrappers containing the phrase (entire paragraph when span is inside)', () => {
    // When the watermark is inside a <p>, the wrapper-aware Pass 1 strips
    // the WHOLE paragraph (because the paragraph's plain text contains the
    // phrase). This is intentional — splitting the paragraph would leave
    // an awkward orphan structure behind. A standalone <span> outside any
    // paragraph is also dropped.
    const insideP = '<p>before <span class="author">Tiểu Ngôn</span> after.</p><p>Story.</p>';
    const out1 = stripWatermarks(insideP, ['Tiểu Ngôn']);
    expect(out1).not.toContain('Tiểu Ngôn');
    // Whole paragraph gone, "Story." survives.
    expect(out1).toContain('Story.');
    expect(out1).not.toContain('before');
    expect(out1).not.toContain('after.');

    // Standalone <span> (not inside another block) gets dropped too.
    const standalone = '<span>Tiểu Ngôn</span><p>Body.</p>';
    const out2 = stripWatermarks(standalone, ['Tiểu Ngôn']);
    expect(out2).not.toContain('Tiểu Ngôn');
    expect(out2).toContain('Body.');
  });

  it('drops <h*> wrappers containing the phrase', () => {
    const html = '<h3>Advert: dtv-ebook.com</h3><p>Story.</p>';
    const out = stripWatermarks(html, ['dtv-ebook.com']);
    expect(out).not.toContain('dtv-ebook.com');
    expect(out).toContain('Story.');
  });

  it('still strips <p>-wrapped watermarks (backwards compat)', () => {
    const html = '<p>Read at www.foo.bar</p><p>Body.</p>';
    const out = stripWatermarks(html, ['www.foo.bar']);
    expect(out).not.toContain('www.foo.bar');
    expect(out).toContain('Body.');
  });

  it('handles a hyperlink inside a paragraph (tag-split watermarks)', () => {
    // The phrase "Đọc thêm tại dtv-ebook.com" matches the entire <p>'s
    // plain text so the whole <p> drops. Adjacent prose paragraphs survive.
    const html = '<p>Đọc thêm tại <a href="https://dtv-ebook.com">dtv-ebook.com</a>.</p>'
      + '<p>Real body.</p>';
    const out = stripWatermarks(html, ['Đọc thêm tại dtv-ebook.com']);
    expect(out).not.toContain('Đọc thêm tại');
    expect(out).not.toContain('<a ');
    expect(out).toContain('Real body.');
  });

  it('processes phrases longest-first (no substring bleed)', () => {
    // Long phrase is inside the whole <p>; it matches first, the entire
    // <p> drops, and the shorter "dtv-ebook.com" no longer has anything
    // to match, so Pass 3 leaves "Body." alone.
    const html = '<p>Đọc thêm tại dtv-ebook.com.vn</p><p>Body.</p>';
    const out = stripWatermarks(html, ['Đọc thêm tại dtv-ebook.com.vn', 'dtv-ebook.com']);
    expect(out).not.toContain('dtv-ebook.com');
    expect(out).toContain('Body.');
  });

  it('drops only the wrapper when the watermark is the element\'s only content', () => {
    // Pure wrapper case: <div>WATERMARK</div> — the <div> drops, no extra
    // surgery. Prose before/after survives.
    const html = '<p>keep this</p><div>WATERMARK</div><p>also keep</p>';
    const out = stripWatermarks(html, ['WATERMARK']);
    expect(out).toContain('keep this');
    expect(out).toContain('also keep');
    expect(out).not.toContain('WATERMARK');
    expect(out).not.toContain('<div');
  });

  it('falls back to bare substring stripping for non-block contexts', () => {
    const html = 'watermark text without any tags<p>Body.</p>';
    const out = stripWatermarks(html, ['watermark text']);
    expect(out).not.toContain('watermark text');
    expect(out).toContain('Body.');
  });

  it('returns the input verbatim when no phrases are provided', () => {
    const html = '<p>nothing here</p>';
    expect(stripWatermarks(html, [])).toBe(html);
  });

  it('trims and dedupes phrases before stripping', () => {
    const html = '<div>x</div><div>x</div><p>body</p>';
    const out = stripWatermarks(html, ['  x  ', 'x']);
    expect(out).not.toContain('>x<');
    expect(out).toContain('body');
  });
});

describe('countPhraseHits', () => {
  it('counts each matching element once (no double-count from raw substring)', () => {
    const html = '<div>watermark</div><div>watermark</div><p>watermark outside any tag</p>';
    const counts = countPhraseHits(html, ['watermark']);
    expect(counts.length).toBe(1);
    expect(counts[0].hits).toBe(3); // 2 divs + 1 raw
  });

  it('zero hits for empty input', () => {
    expect(countPhraseHits('', ['whatever'])).toEqual([{ phrase: 'whatever', hits: 0 }]);
  });

  it('case-insensitive match', () => {
    const html = '<div>UPPERCASE</div><div>uppercase</div><p>Body.</p>';
    const counts = countPhraseHits(html, ['UPPERCASE']);
    expect(counts[0].hits).toBe(2);
  });
});

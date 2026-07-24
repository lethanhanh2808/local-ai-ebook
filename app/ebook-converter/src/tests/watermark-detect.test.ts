// src/tests/watermark-detect.test.ts
//
// Verifies the shared tag-aware watermark detector against the DTV-style
// structure that originally caused the manual "Detect" button to feel
// broken. We construct lightweight chapter HTML strings rather than parsing
// real EPUBs — the splitter doesn't depend on EPUB packaging.

import { describe, it, expect } from 'vitest';
import {
  splitChapterIntoPhrases,
  detectFromChaptersHtml,
  htmlFragmentToText,
} from '@/lib/pipeline/watermark-detect';

/** Build a chapter HTML fragment with the given body content (without
 *  enforcing a particular <section> envelope — the splitter only looks
 *  at block-level separators). */
function chapterWith(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe('htmlFragmentToText', () => {
  it('strips all tags and decodes common entities', () => {
    expect(htmlFragmentToText('<p>Hello &amp; <b>world</b></p>'))
      .toBe('Hello & world');
    expect(htmlFragmentToText('<span>It&#39;s</span> a&nbsp;test'))
      .toBe("It's a test");
  });

  it('collapses extra whitespace and trims', () => {
    expect(htmlFragmentToText('  <p>  a   b  </p>\n  c  ')).toBe('a b c');
  });

  it('preserves Vietnamese tone-marks', () => {
    expect(htmlFragmentToText('<p>Chiếm Đoạt Vợ Yêu</p>'))
      .toBe('Chiếm Đoạt Vợ Yêu');
  });
});

describe('splitChapterIntoPhrases', () => {
  it('captures DTV-style <div class="header"> watermarks as their own phrase', () => {
    const html = chapterWith(
      '<div class="header">Chiếm Đoạt Vợ Yêu</div>' +
      '<div class="author">Tiểu Ngôn</div>' +
      '<div class="author">www.dtv-ebook.com</div>' +
      '<p>Chapter body paragraph one.</p>' +
      '<p>Chapter body paragraph two.</p>',
    );
    const phrases = splitChapterIntoPhrases(html);
    expect(phrases).toContain('Chiếm Đoạt Vợ Yêu');
    expect(phrases).toContain('Tiểu Ngôn');
    expect(phrases).toContain('www.dtv-ebook.com');
  });

  it('skips <h*> heading lines that start with "Chương N"', () => {
    const html = chapterWith(
      '<h4>Chương 1</h4>' +
      '<p>Body paragraph.</p>',
    );
    const phrases = splitChapterIntoPhrases(html);
    expect(phrases).not.toContain('Chương 1');
    expect(phrases).toContain('Body paragraph.');
  });

  it('keeps non-Chương headings (e.g. recurring "Giới thiệu tác giả")', () => {
    const html = chapterWith(
      '<h3>Giới thiệu tác giả</h3>' +
      '<p>...biography text...</p>',
    );
    const phrases = splitChapterIntoPhrases(html);
    expect(phrases).toContain('Giới thiệu tác giả');
  });

  it('drops fragments that are too short (<4 chars)', () => {
    const html = chapterWith('<p>a</p><p>real text here.</p>');
    const phrases = splitChapterIntoPhrases(html);
    expect(phrases).not.toContain('a');
    expect(phrases).toContain('real text here.');
  });

  it('drops fragments that are too long (>200 chars)', () => {
    const longText = 'x'.repeat(201);
    const html = chapterWith(`<p>${longText}</p><p>short one.</p>`);
    const phrases = splitChapterIntoPhrases(html);
    expect(phrases.find((p) => p.length > 200)).toBeUndefined();
    expect(phrases).toContain('short one.');
  });

  it('dedupes within a single chapter', () => {
    const html = chapterWith(
      '<div>Chiếm Đoạt Vợ Yêu</div>' +
      '<div>Chiếm Đoạt Vợ Yêu</div>' + // duplicate
      '<p>story</p>',
    );
    const phrases = splitChapterIntoPhrases(html);
    expect(phrases.filter((p) => p === 'Chiếm Đoạt Vợ Yêu').length).toBe(1);
  });
});

describe('detectFromChaptersHtml', () => {
  function makeBook(headers: { title: string; url: string }, body: string) {
    const chapterCount = 10;
    const chapters = Array.from({ length: chapterCount }, () => ({
      html: chapterWith(
        `<div class="header">${headers.title}</div>` +
        `<div class="author">${headers.url}</div>` +
        body,
      ),
    }));
    return chapters;
  }

  it('flags a phrase appearing in 100% of chapters even at 40% threshold', () => {
    const chapters = makeBook(
      { title: 'Chiếm Đoạt Vợ Yêu', url: 'www.dtv-ebook.com' },
      '<p>Chapter prose.</p>',
    );
    const flags = detectFromChaptersHtml(chapters, { threshold: 0.4 });
    expect(flags).toContain('Chiếm Đoạt Vợ Yêu');
    expect(flags).toContain('www.dtv-ebook.com');
    // Chapter prose only appears once per chapter (different paragraphs
    // each, but our test collapse them); should NOT be flagged because
    // every chapter dedupes to the same single entry => count = 10,
    // but threshold at threshold 0.4 over 10 chapters = 4. So it IS
    // detected here — verify the rule:
    expect(flags).toContain('Chapter prose.');
  });

  it('does NOT flag phrases appearing in < minChapters chapters', () => {
    const chapters = [
      { html: chapterWith('<div>RARE_HEADER_xyz</div>') },
      ...Array.from({ length: 9 }, () => ({
        html: chapterWith('<div>COMMON_HEADER</div>'),
      })),
    ];
    const flags = detectFromChaptersHtml(chapters, { threshold: 0.4, minChapters: 2 });
    expect(flags).not.toContain('RARE_HEADER_xyz'); // 1 chapter
    expect(flags).toContain('COMMON_HEADER'); // 9 chapters
  });

  it('returns empty for single-chapter books', () => {
    expect(detectFromChaptersHtml([{ html: chapterWith('<div>x</div>') }]))
      .toEqual([]);
  });

  it('honours explicit threshold option', () => {
    // 4 chapters, threshold 0.51 → need 3 chapters minimum (ceil(4*0.51)=3).
    const make = (s: string) => ({ html: chapterWith(`<div>${s}</div>`) });
    const chapters = [
      make('alpha'),
      make('beta'),
      make('alpha'),
      make('alpha'),
    ];
    // alpha: 3/4 = 0.75, beta: 1/4 = 0.25.
    expect(detectFromChaptersHtml(chapters, { threshold: 0.5 }))
      .toContain('alpha');
    expect(detectFromChaptersHtml(chapters, { threshold: 0.9 }))
      .toEqual([]);
  });

  it('sorts results by descending chapter count, then by descending length', () => {
    // Build 10 chapters, each contributing all three phrases. With threshold
    // 0.4 over 10 chapters we need ≥4, so all three qualify. The sort is
    // count desc (tied at 10), then phrase length desc, so:
    //   1. LONGER_PHRASE_HERE (18 chars)
    //   2. POPULAR              (7 chars)
    //   3. SHORT                (5 chars)
    const chapters = Array.from({ length: 10 }, () => ({
      html: chapterWith('<div>POPULAR</div><div>SHORT</div><div>LONGER_PHRASE_HERE</div>'),
    }));
    const flags = detectFromChaptersHtml(chapters, { threshold: 0.4 });
    expect(flags.length).toBe(3);
    expect(flags[0]).toBe('LONGER_PHRASE_HERE');
    expect(flags[1]).toBe('POPULAR');
    expect(flags[2]).toBe('SHORT');
  });
});

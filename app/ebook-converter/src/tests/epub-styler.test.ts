// src/tests/epub-styler.test.ts
import { describe, it, expect } from 'vitest';
import { buildChapterHtml, extractChapterBodyFragment, STANDARD_CSS } from '../lib/pipeline/epub-styler';

describe('buildChapterHtml', () => {
  it('produces valid XHTML with doctype', () => {
    const html = buildChapterHtml({ title: 'Chương 1', body: '<p>Nội dung</p>', lang: 'vi' });
    expect(html).toContain('<?xml version="1.0"');
    expect(html).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(html).toContain('Chương 1');
    expect(html).toContain('<p>Nội dung</p>');
    expect(html).toContain('epub:type="chapter"');
  });

  it('escapes XML special chars in title', () => {
    const html = buildChapterHtml({ title: 'A & B <test>', body: '' });
    expect(html).toContain('A &amp; B &lt;test&gt;');
  });

  it('uses custom CSS path when provided', () => {
    const html = buildChapterHtml({ title: 'T', body: '', cssPath: '../css/custom.css' });
    expect(html).toContain('custom.css');
  });

  it('strips a duplicate leading h1 because the builder owns the chapter title', () => {
    const html = buildChapterHtml({ title: 'Chương 1', body: '<h1>Wrong duplicate</h1><p>Nội dung</p>' });
    expect(html).toContain('<h1 id="chapter-title" epub:type="title">Chương 1</h1>');
    expect(html).not.toContain('Wrong duplicate');
  });
});

describe('extractChapterBodyFragment', () => {
  it('returns only editable chapter content from generated XHTML', () => {
    const html = buildChapterHtml({
      id: 'chapter001',
      title: 'Chương 1',
      body: '<p>Đoạn một.</p><p>Đoạn hai.</p>',
      lang: 'vi',
    });
    expect(extractChapterBodyFragment(html)).toBe('<p>Đoạn một.</p><p>Đoạn hai.</p>');
  });

  it('removes imported leading headings before AI formatting', () => {
    const fragment = '<section id="x"><h2>Chương 2</h2><p>Nội dung.</p></section>';
    expect(extractChapterBodyFragment(fragment, 'Chương 2')).toBe('<p>Nội dung.</p>');
  });

  it('preserves a real leading subheading when it is not the chapter title', () => {
    const fragment = '<section id="x"><h1>Chương 2</h1><h2>Buổi sáng</h2><p>Nội dung.</p></section>';
    expect(extractChapterBodyFragment(fragment, 'Chương 2')).toBe('<h2>Buổi sáng</h2><p>Nội dung.</p>');
  });
});

describe('STANDARD_CSS', () => {
  it('references Literata font', () => {
    expect(STANDARD_CSS).toContain("font-family: 'Literata'");
  });

  it('has Vietnamese language rule', () => {
    expect(STANDARD_CSS).toContain(':lang(vi)');
  });

  it('avoids viewport units', () => {
    // viewport units break many e-ink readers
    expect(STANDARD_CSS).not.toMatch(/\b\d+vh\b/);
    expect(STANDARD_CSS).not.toMatch(/\b\d+vw\b/);
  });
});

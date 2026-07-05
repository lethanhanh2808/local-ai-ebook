// src/tests/epub-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateEpub } from '../lib/pipeline/epub-validator';
import type { ParsedEpub } from '../lib/pipeline/epub-parser';

function makeEpub(overrides: Partial<ParsedEpub>): ParsedEpub {
  const entries = new Map([
    ['mimetype', { name: 'mimetype', data: Buffer.from('application/epub+zip') }],
    ['META-INF/container.xml', { name: 'META-INF/container.xml', data: Buffer.from('<container/>') }],
    ['EPUB/nav.xhtml', { name: 'EPUB/nav.xhtml', data: Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter001.xhtml#chapter001">Chapter 1</a></li></ol></nav><nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="chapter001.xhtml#chapter001">Begin Reading</a></li></ol></nav></body></html>') }],
    ['EPUB/toc.ncx', { name: 'EPUB/toc.ncx', data: Buffer.from('<ncx><navMap><navPoint><navLabel><text>Chapter 1</text></navLabel><content src="chapter001.xhtml#chapter001"/></navPoint></navMap></ncx>') }],
    ['EPUB/chapter001.xhtml', { name: 'EPUB/chapter001.xhtml', data: Buffer.from('<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="vi" xml:lang="vi"><head><meta charset="utf-8"/><title>Chapter 1</title></head><body epub:type="bodymatter"><section id="chapter001" epub:type="chapter"><h1 id="chapter001-title">Chapter 1</h1><p>Text</p></section></body></html>') }],
  ]);
  return {
    entries,
    opfPath: 'EPUB/content.opf',
    opfContent: '<package version="3.0"><metadata><meta property="dcterms:modified">2026-07-04T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav"/></manifest><spine/></package>',
    htmlFiles: ['EPUB/chapter001.xhtml'],
    cssFiles: ['EPUB/css/style.css'],
    imageFiles: [],
    metadata: {
      title: 'Test Book',
      author: 'Test Author',
      language: 'vi',
      identifier: 'urn:uuid:test-123',
    },
    tocEntries: [{ title: 'Chapter 1', src: 'EPUB/chapter001.xhtml' }],
    ...overrides,
  };
}

describe('validateEpub', () => {
  it('passes a well-formed EPUB', () => {
    const result = validateEpub(makeEpub({}));
    expect(result.errors).toHaveLength(0);
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  it('flags missing title as critical error', () => {
    const epub = makeEpub({ metadata: { language: 'vi', identifier: 'id-1', author: 'A' } });
    const result = validateEpub(epub);
    expect(result.errors.some((e) => e.includes('dc:title'))).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('flags empty spine', () => {
    const result = validateEpub(makeEpub({ htmlFiles: [] }));
    expect(result.errors.some((e) => e.includes('Spine'))).toBe(true);
  });

  it('warns on missing nav', () => {
    const epub = makeEpub({});
    epub.entries.delete('EPUB/nav.xhtml');
    epub.opfContent = epub.opfContent.replace(' properties="nav"', '');
    const result = validateEpub(epub);
    expect(result.warnings.some((w) => w.includes('nav.xhtml'))).toBe(true);
  });

  it('penalizes score proportionally', () => {
    const bad = makeEpub({ htmlFiles: [], metadata: { language: 'vi' } });
    const result = validateEpub(bad);
    expect(result.score).toBeLessThan(60);
  });
});

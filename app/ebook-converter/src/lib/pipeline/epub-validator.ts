// src/lib/pipeline/epub-validator.ts
// Structural validation of an EPUB (no external tools required)
import { ParsedEpub } from './epub-parser';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
  score: number; // 0-100
}

export function validateEpub(epub: ParsedEpub): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // ── Critical checks ────────────────────────────────────────────────────
  if (!epub.opfPath) errors.push('Missing OPF package document (container.xml malformed or absent)');
  if (epub.htmlFiles.length === 0) errors.push('Spine is empty – no readable HTML documents found');
  if (!epub.metadata.title) errors.push('dc:title is missing from metadata');
  if (!epub.metadata.language) errors.push('dc:language is missing from metadata');
  if (!epub.metadata.identifier) errors.push('dc:identifier is missing from metadata');

  const mimetype = epub.entries.get('mimetype')?.data.toString('utf8').trim();
  if (!mimetype) errors.push('Missing root mimetype file');
  else if (mimetype !== 'application/epub+zip') errors.push('Root mimetype file must contain application/epub+zip');

  if (!epub.entries.has('META-INF/container.xml')) {
    errors.push('Missing META-INF/container.xml');
  }

  if (epub.opfContent && !/<package\b[^>]*\bversion=["']3\./i.test(epub.opfContent)) {
    warnings.push('Package document is not marked as EPUB 3.x');
  }

  // ── Navigation ─────────────────────────────────────────────────────────
  const navEntry = Array.from(epub.entries.values()).find((e) => /nav\.x?html$/i.test(e.name));
  const hasNav = !!navEntry || /<item\b[^>]*properties=["'][^"']*\bnav\b/i.test(epub.opfContent);
  const hasNcx = Array.from(epub.entries.keys()).some((n) => n.endsWith('.ncx'));
  if (!hasNav) warnings.push('No EPUB3 nav.xhtml found (required for EPUB3)');
  if (!hasNcx) warnings.push('No toc.ncx found (recommended for EPUB2 compat / Boox Neo)');
  if (navEntry) {
    const nav = navEntry.data.toString('utf8');
    if (!/<nav\b[^>]*epub:type=["'][^"']*\btoc\b/i.test(nav)) {
      warnings.push('EPUB3 navigation document does not contain a toc nav');
    }
    if (!/<nav\b[^>]*epub:type=["'][^"']*\blandmarks\b/i.test(nav)) {
      warnings.push('EPUB3 navigation document does not contain landmarks');
    }
    if (/<ol>\s*<\/ol>/i.test(nav)) {
      warnings.push('EPUB3 navigation document contains an empty ordered list');
    }
  }
  if (hasNcx) {
    const ncx = Array.from(epub.entries.values()).find((e) => e.name.endsWith('.ncx'))?.data.toString('utf8') ?? '';
    if (!/<navMap\b/i.test(ncx)) warnings.push('toc.ncx is missing navMap');
  }
  if (epub.opfContent && !/<meta\b[^>]*property=["']dcterms:modified["']/i.test(epub.opfContent)) {
    warnings.push('Package metadata is missing dcterms:modified');
  }

  // ── CSS ────────────────────────────────────────────────────────────────
  if (epub.cssFiles.length === 0) warnings.push('No CSS stylesheets found');

  // ── Encoding checks on first HTML file ─────────────────────────────────
  if (epub.htmlFiles.length > 0) {
    const first = epub.entries.get(epub.htmlFiles[0]);
    if (first) {
      const html = first.data.toString('utf8');
      if (!/<meta\b[^>]*charset=["']?utf-8/i.test(html) && !/charset\s*=\s*["']?utf-8/i.test(html)) {
        warnings.push('First HTML file lacks UTF-8 charset declaration');
      }
      if (!html.includes('<!DOCTYPE') && !html.includes('<?xml')) {
        warnings.push('First HTML file lacks DOCTYPE or XML declaration');
      }
      if (!/xmlns=["']http:\/\/www\.w3\.org\/1999\/xhtml["']/i.test(html)) {
        warnings.push('First HTML file lacks XHTML namespace');
      }
      if (!/\bxml:lang=["'][^"']+["']/i.test(html) && !/\blang=["'][^"']+["']/i.test(html)) {
        warnings.push('First HTML file lacks lang/xml:lang');
      }
      if (!/<body\b[^>]*epub:type=["'][^"']*\bbodymatter\b/i.test(html)) {
        warnings.push('First HTML body does not declare bodymatter semantics');
      }
      if (!/<section\b[^>]*(epub:type=["'][^"']*\bchapter\b|role=["']doc-chapter["'])/i.test(html)) {
        warnings.push('First HTML file does not wrap chapter content in a semantic section');
      }
    }
  }

  // ── Duplicate IDs and missing heading IDs ───────────────────────────────
  let duplicateIds = 0;
  let headingWithoutId = 0;
  for (const file of epub.htmlFiles.slice(0, 20)) {
    const html = epub.entries.get(file)?.data.toString('utf8') ?? '';
    const ids = new Set<string>();
    for (const match of html.matchAll(/\sid=["']([^"']+)["']/gi)) {
      if (ids.has(match[1])) duplicateIds++;
      ids.add(match[1]);
    }
    for (const match of html.matchAll(/<h[1-6]\b([^>]*)>/gi)) {
      if (!/\sid\s*=/i.test(match[1])) headingWithoutId++;
    }
  }
  if (duplicateIds > 0) warnings.push(`${duplicateIds} duplicate XHTML id value(s) detected`);
  if (headingWithoutId > 0) warnings.push(`${headingWithoutId} heading(s) without id detected; TOC anchors may be incomplete`);

  // ── Dangling image refs ─────────────────────────────────────────────────
  const imageSet = new Set(epub.imageFiles.map((f) => f.split('/').pop()));
  let brokenImgCount = 0;
  for (const file of epub.htmlFiles.slice(0, 10)) {
    const entry = epub.entries.get(file);
    if (!entry) continue;
    const html = entry.data.toString('utf8');
    const imgRe = /src="([^"]+\.(jpg|jpeg|png|gif|svg|webp))"/gi;
    let m;
    while ((m = imgRe.exec(html)) !== null) {
      const basename = m[1].split('/').pop() ?? '';
      if (!imageSet.has(basename)) brokenImgCount++;
    }
  }
  if (brokenImgCount > 0) warnings.push(`${brokenImgCount} broken image reference(s) detected`);

  // ── Boox Neo specific ──────────────────────────────────────────────────
  const cssContent = epub.cssFiles
    .map((f) => epub.entries.get(f)?.data.toString('utf8') ?? '')
    .join('\n');
  if (cssContent.includes('position:fixed') || cssContent.includes('position: fixed')) {
    warnings.push('CSS uses position:fixed – may break Boox Neo page layout');
  }
  if (cssContent.includes('vh') || cssContent.includes('vw')) {
    warnings.push('CSS uses viewport units (vh/vw) – not supported on all e-ink readers');
  }

  // ── Info ────────────────────────────────────────────────────────────────
  info.push(`${epub.htmlFiles.length} spine document(s)`);
  info.push(`${epub.imageFiles.length} image(s)`);
  info.push(`${epub.cssFiles.length} stylesheet(s)`);
  info.push(`TOC entries: ${epub.tocEntries.length}`);
  info.push(`Language: ${epub.metadata.language ?? 'unknown'}`);

  const penaltyPer = { error: 20, warning: 5 };
  const score = Math.max(
    0,
    100 -
      errors.length * penaltyPer.error -
      warnings.length * penaltyPer.warning,
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
    score,
  };
}

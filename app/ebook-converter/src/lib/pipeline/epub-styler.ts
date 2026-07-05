// src/lib/pipeline/epub-styler.ts
// Generate standardized CSS for output EPUBs (Literata font, EPUB3 compliant)
export const STANDARD_CSS = `
/* Ebook Converter standard stylesheet v2.
   EPUB3-friendly, reflowable, and intentionally conservative for Kobo,
   Kindle, Apple Books, Google Play Books, and e-ink readers. */

@charset "UTF-8";
@namespace epub "http://www.idpf.org/2007/ops";

/* Font face declarations ------------------------------------------------- */
@font-face {
  font-family: 'Literata';
  font-style: normal;
  font-weight: 400;
  src: url('../fonts/Literata-Regular.ttf') format('truetype');
}
@font-face {
  font-family: 'Literata';
  font-style: italic;
  font-weight: 400;
  src: url('../fonts/Literata-Italic.ttf') format('truetype');
}
@font-face {
  font-family: 'Literata';
  font-style: normal;
  font-weight: 700;
  src: url('../fonts/Literata-Bold.ttf') format('truetype');
}
@font-face {
  font-family: 'Literata';
  font-style: italic;
  font-weight: 700;
  src: url('../fonts/Literata-BoldItalic.ttf') format('truetype');
}

/* Reset ------------------------------------------------------------------ */
* {
  -webkit-box-sizing: border-box;
  box-sizing: border-box;
}

/* Body ------------------------------------------------------------------- */
body {
  font-family: 'Literata', 'Georgia', 'Times New Roman', serif;
  font-size: 1em;
  line-height: 1.65;
  color: #1a1a1a;
  background-color: #ffffff;
  text-align: justify;
  -webkit-hyphens: auto;
  hyphens: auto;
  margin: 0 5%;
  overflow-wrap: break-word;
}

section[epub|type~="chapter"],
section[role="doc-chapter"] {
  page-break-before: always;
  break-before: page;
}

body > section:first-child {
  page-break-before: auto;
  break-before: auto;
}

/* Headings --------------------------------------------------------------- */
h1, h2, h3, h4, h5, h6 {
  font-family: 'Literata', 'Georgia', serif;
  font-weight: 700;
  line-height: 1.3;
  margin: 2em 0 0.75em;
  text-align: center;
  page-break-after: avoid;
  break-after: avoid;
}
h1 { font-size: 1.75em; margin-top: 12%; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.2em; }

/* Chapter title decoration */
h1::before {
  display: block;
  content: '';
  border-top: 1px solid #ccc;
  margin-bottom: 1em;
}
h1::after {
  display: block;
  content: '';
  border-bottom: 1px solid #ccc;
  margin-top: 1em;
}

/* Paragraphs ------------------------------------------------------------- */
p {
  margin: 0;
  padding: 0;
  text-indent: 1.5em;
  orphans: 3;
  widows: 3;
}
p + p { margin-top: 0.05em; }

/* First paragraph after a heading */
h1 + p,
h2 + p,
h3 + p,
h4 + p,
blockquote + p,
hr + p {
  text-indent: 0;
}

/* Scene separator */
hr {
  border: none;
  text-align: center;
  margin: 2em auto;
}
hr::after {
  content: '— ✦ —';
  font-size: 0.9em;
  color: #999;
}

/* Links ------------------------------------------------------------------ */
a { color: inherit; text-decoration: none; }

/* Images ----------------------------------------------------------------- */
img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1em auto;
}

/* Cover page ------------------------------------------------------------- */
.cover-page {
  text-align: center;
  page-break-after: always;
  break-after: page;
}
.cover-page img {
  max-height: 100%;
  width: auto;
}

/* TOC -------------------------------------------------------------------- */
nav[epub|type~="toc"] ol,
nav[epub|type~="toc"] ul,
nav#toc ol,
nav#toc ul {
  list-style: none;
  padding: 0;
}
nav[epub|type~="toc"] li,
nav#toc li { margin: 0.35em 0; }
nav[epub|type~="toc"] ol ol,
nav#toc ol ol {
  margin-left: 1.25em;
  font-size: 0.95em;
}
nav[epub|type~="toc"] a,
nav#toc a { text-decoration: none; }

/* Block quotes ----------------------------------------------------------- */
blockquote {
  margin: 1.5em 2em;
  font-style: italic;
}

/* Vietnamese-specific ---------------------------------------------------- */
:lang(vi) {
  word-spacing: 0.05em;
}

/* Page breaks ------------------------------------------------------------ */
.page-break {
  page-break-after: always;
  break-after: page;
}

/* Utility ---------------------------------------------------------------- */
.centered { text-align: center; }
.right    { text-align: right; }
.small    { font-size: 0.85em; }
.drop-cap p:first-child::first-letter {
  float: left;
  font-size: 3.2em;
  line-height: 0.8;
  margin: 0.05em 0.1em 0 0;
  font-weight: 700;
}
`;

export function buildChapterHtml(opts: {
  title: string;
  body: string;
  id?: string;
  lang?: string;
  cssPath?: string;
}): string {
  const { title, body, id = 'chapter', lang = 'vi', cssPath = 'css/style.css' } = opts;
  const safeId = normalizeId(id);
  // The EPUB builder owns the canonical chapter title. Keep this guard even
  // though AI prompts now forbid <h1>, because imported books can already have
  // a leading heading in the body fragment.
  const cleanedBody = body.replace(/^\s*<h1[\s>][^]*?<\/h1>\s*/i, '');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" epub:prefix="z3998: http://www.daisy.org/z3998/2012/vocab/structure/" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="${cssPath}"/>
</head>
<body epub:type="bodymatter">
  <section id="${safeId}" epub:type="chapter" role="doc-chapter">
    <h1 id="${safeId}-title" epub:type="title">${escapeXml(title)}</h1>
    ${cleanedBody}
  </section>
</body>
</html>`;
}

export function extractChapterBodyFragment(html: string, title?: string): string {
  let fragment = html.trim();
  const bodyMatch = fragment.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) fragment = bodyMatch[1].trim();

  const sectionMatch = fragment.match(/^\s*<section\b[^>]*>([\s\S]*?)<\/section>\s*$/i);
  if (sectionMatch) fragment = sectionMatch[1].trim();

  // Remove generated/imported chapter headings at the very start. The caller
  // keeps the title separately and rebuilds it with buildChapterHtml().
  fragment = fragment.replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, '').trim();
  if (title) {
    let previous = '';
    while (previous !== fragment) {
      previous = fragment;
      fragment = stripDuplicateLeadingHeading(fragment, title);
    }
  }

  return fragment;
}

function stripDuplicateLeadingHeading(fragment: string, title: string): string {
  const match = fragment.match(/^\s*<h([2-3])\b[^>]*>([\s\S]*?)<\/h\1>\s*/i);
  if (!match) return fragment;
  const headingText = normalizeHeadingText(match[2]);
  const titleText = normalizeHeadingText(title);
  return headingText && headingText === titleText ? fragment.slice(match[0].length).trim() : fragment;
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeId(value: string) {
  const id = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || 'chapter';
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

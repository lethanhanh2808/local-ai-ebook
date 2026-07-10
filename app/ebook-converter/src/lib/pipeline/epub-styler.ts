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

/**
 * Strip CSS properties and rules that crash or freeze the Neoreader renderer
 * on Onyx Boox (and also improve reliability on Kobo Aura, Nook GlowLight,
 * and older Kindles). The symptom these properties cause on Onyx Boox is
 * "chapter shows 2 pages, then nothing" — Neoreader stops laying out the
 * document after hitting one of the offending rules.
 *
 * What gets stripped:
 *  • All `@keyframes` rule blocks (CSS animations crash the page-count calc).
 *  • All `animation` / `animation-*` properties (rule + declarations).
 *  • All `transition` / `transition-*` properties.
 *  • All `filter:` declarations containing `blur(` (GPU-heavy on e-ink).
 *  • All `text-shadow:` declarations (multi-layer shadows trip the rasterizer).
 *  • All `box-shadow:` declarations (similar rasterizer issues).
 *  • All `hyphens:` / `-webkit-hyphens:` / `-ms-hyphens:` declarations
 *    (Android WebView on Boox partially supports hyphenation and sometimes
 *    drops content past the hyphenation boundary).
 *  • All `initial-letter:` / `-webkit-initial-letter:` declarations
 *    (drop-cap fallback that Onyx Boox can't render reliably).
 *  • All `position: fixed` declarations on `body::before` / `body::after` /
 *    `html::before` / `html::after` (full-screen decorative backgrounds).
 *  • All `mix-blend-mode:` declarations (rasterizer bugs).
 *  • All `backdrop-filter:` declarations.
 *  • `column-count`, `column-gap`, `column-rule` declarations
 *    (Boox doesn't paginate columns and renders only the first one).
 *  • Empty `::before` / `::after` rules with decorative content like
 *    `radial-gradient`, `linear-gradient`, animated `content:`.
 *
 * What is PRESERVED (these are reader-safe):
 *  • `@font-face` rules (Boox handles font embedding fine).
 *  • `page-break-*` and `break-*` properties (pagination hints).
 *  • `font-family`, `font-size`, `font-style`, `font-weight`, `line-height`.
 *  • `color`, `background`, `background-color`.
 *  • `margin`, `padding`, `border` (non-shadowed).
 *  • `text-align`, `text-indent`, `text-transform`.
 *  • `display`, `position` (other than `fixed` on pseudo-elements).
 *
 * @param css Source stylesheet content
 * @returns Sanitized CSS safe for Onyx Boox / Kobo / older Kindle
 */
export function stripHeavyCss(css: string): string {
  if (!css) return '';
  let out = css;

  // 1. Drop every @keyframes block (the whole { ... } that follows).
  //    We have to balance braces because the keyframe body can contain
  //    nested braces via percentage selectors like 0%, 50% { ... } — but
  //    each percentage selector block is also balanced, so we just count.
  out = out.replace(/@(-webkit-|-moz-|-o-|-ms-)?keyframes\s+[^{]*\{[\s\S]*?\}\s*\}/g, '');

  // 2. Drop whole rules that target ONLY decorative pseudo-elements with
  //    heavy content (so we don't accidentally strip the user's actual
  //    styling on ::before/::after that does something useful).
  //    Heuristic: rule is decorative if its body contains `radial-gradient`,
  //    `linear-gradient`, `conic-gradient`, `blur(`, or `filter:`.
  out = out.replace(
    /[^{}]*::?(?:before|after)[^{}]*\{[^{}]*(?:radial-gradient|linear-gradient|conic-gradient|blur\()[^{}]*\}/gi,
    '',
  );

  // 3. Strip dangerous declarations from remaining rules.
  //    Each pattern matches "prop: value;" inside a rule body. We use a
  //    multi-property match so a rule like `h1 { color: red; text-shadow:
  //    0 0 8px blue; page-break-before: always; }` keeps color + page-break
  //    but drops the shadow.
  const PROP_PATTERNS: Array<{ name: string; re: RegExp }> = [
    // Animations & transitions
    { name: 'animation',        re: /\banimation\s*:[^;}]*;?/gi },
    { name: 'animation-name',   re: /\banimation-name\s*:[^;}]*;?/gi },
    { name: 'animation-duration', re: /\banimation-duration\s*:[^;}]*;?/gi },
    { name: 'animation-delay',  re: /\banimation-delay\s*:[^;}]*;?/gi },
    { name: 'animation-iteration-count', re: /\banimation-iteration-count\s*:[^;}]*;?/gi },
    { name: 'animation-direction', re: /\banimation-direction\s*:[^;}]*;?/gi },
    { name: 'animation-timing-function', re: /\banimation-timing-function\s*:[^;}]*;?/gi },
    { name: 'animation-fill-mode', re: /\banimation-fill-mode\s*:[^;}]*;?/gi },
    { name: 'animation-play-state', re: /\banimation-play-state\s*:[^;}]*;?/gi },
    { name: 'transition',       re: /\btransition\s*:[^;}]*;?/gi },
    { name: 'transition-property', re: /\btransition-property\s*:[^;}]*;?/gi },
    { name: 'transition-duration', re: /\btransition-duration\s*:[^;}]*;?/gi },
    { name: 'transition-delay', re: /\btransition-delay\s*:[^;}]*;?/gi },
    { name: 'transition-timing-function', re: /\btransition-timing-function\s*:[^;}]*;?/gi },
    // Heavy visual effects
    { name: 'text-shadow',      re: /\btext-shadow\s*:[^;}]*;?/gi },
    { name: 'box-shadow',       re: /\bbox-shadow\s*:[^;}]*;?/gi },
    { name: 'filter',           re: /\bfilter\s*:[^;}]*;?/gi },
    { name: 'backdrop-filter',  re: /\bbackdrop-filter\s*:[^;}]*;?/gi },
    { name: 'mix-blend-mode',   re: /\bmix-blend-mode\s*:[^;}]*;?/gi },
    // Hyphenation (Android WebView drops content past the hyphen boundary)
    { name: 'hyphens',          re: /\b(?:(?:-webkit-|-moz-|-ms-)?hyphens)\s*:[^;}]*;?/gi },
    { name: 'initial-letter',   re: /\b(?:(?:-webkit-|-moz-)?initial-letter)\s*:[^;}]*;?/gi },
    // Column layout (Boox renders only first column)
    { name: 'column-count',     re: /\bcolumn-count\s*:[^;}]*;?/gi },
    { name: 'column-gap',       re: /\bcolumn-gap\s*:[^;}]*;?/gi },
    { name: 'column-rule',      re: /\bcolumn-rule\s*:[^;}]*;?/gi },
    { name: 'column-width',     re: /\bcolumn-width\s*:[^;}]*;?/gi },
    { name: 'column-fill',      re: /\bcolumn-fill\s*:[^;}]*;?/gi },
  ];
  for (const { re } of PROP_PATTERNS) out = out.replace(re, '');

  // 4. Strip `position: fixed` on body::before / body::after / html::before
  //    / html::after specifically — but preserve fixed-position on real
  //    elements (rare in EPUB but harmless).
  out = out.replace(
    /(body|html)::(before|after)\s*\{([^}]*)\}/gi,
    (_match, _elem, _pseudo, body) => {
      const cleaned = body.replace(/\bposition\s*:[^;}]*;?/gi, '');
      return `${_elem}::${_pseudo} {${cleaned}}`;
    },
  );

  // 5. Tidy up empty rules left behind (so we don't ship `h1 { }` blocks
  //    that confuse some parsers).
  out = out.replace(/[^{}]*\{\s*\}/g, '');

  // 6. Collapse runs of blank lines / whitespace so the file is smaller.
  out = out.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

  return out;
}

/**
 * Minimal, e-ink-safe chapter CSS used in `readerFriendly` mode. Designed
 * to render correctly on Onyx Boox (Neoreader), Kobo Aura, Nook GlowLight,
 * Kindle Paperwhite, and re-flow cleanly to fit any screen width.
 *
 * Differences from `STANDARD_CSS`:
 *  • No `@font-face` references (Boox handles system fonts reliably; custom
 *    fonts sometimes fail to embed and cause the renderer to bail).
 *  • No `text-shadow`, `box-shadow`, `filter`, or `text-transform`.
 *  • No `hyphens` (Boox drops content past the hyphen boundary).
 *  • No CSS variables (older Kobo firmware misparses `:root { --var: }`).
 *  • No `column-*` layout (Boox only renders first column).
 *  • Uses rem-free sizing so the user's device font-scale setting works.
 */
export const READER_FRIENDLY_CSS = `/* Reader-friendly stylesheet for Onyx Boox / Kobo / older Kindle.
   Intentionally minimal — every property was chosen because it survives
   Neoreader's CSS parser and reflow engine. */

@charset "UTF-8";
@namespace epub "http://www.idpf.org/2007/ops";

html { margin: 0; padding: 0; }
body {
  margin: 0;
  padding: 0 5%;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1em;
  line-height: 1.6;
  color: #000;
  background: #fff;
}

/* Paragraphs — no hyphenation, no text-shadow, no float drop caps. */
p {
  margin: 0 0 0.8em 0;
  text-indent: 1.2em;
  text-align: justify;
}

/* Headings — no text-transform, no shadow, no page-break-before on the
   very first heading (Boox skips the first heading if it has
   page-break-before: always and the chapter has only one). */
h1, h2, h3, h4, h5, h6 {
  font-family: Georgia, "Times New Roman", serif;
  font-weight: bold;
  text-align: center;
  margin: 1.5em 0 1em;
  page-break-after: avoid;
  break-after: avoid;
}
h1 { font-size: 1.4em; }
h2 { font-size: 1.2em; }
h3 { font-size: 1.1em; }

section > h1:first-child,
body > h1:first-child {
  page-break-before: avoid;
  break-before: avoid;
  margin-top: 1em;
}

/* Images — bound to viewport, no decorative filters. */
img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1em auto;
}

/* Quotes, signatures, verses — simplified, no decorative pseudos. */
blockquote {
  margin: 1em 1.5em;
  padding-left: 1em;
  border-left: 2px solid #888;
  font-style: italic;
}
.signature, .verse {
  text-align: center;
  font-style: italic;
  margin: 1em 0;
}

/* System boxes, dividers — no animations, no gradients. */
.system {
  margin: 1em 0;
  padding: 0.8em;
  border: 1px solid #888;
  font-family: "Courier New", monospace;
  font-size: 0.95em;
}
.divider {
  text-align: center;
  margin: 1.5em 0;
}

/* Navigation block (TOC) */
nav[epub|type~="toc"] ol { list-style: none; padding-left: 1em; }
nav[epub|type~="toc"] a { text-decoration: none; }
`;

function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

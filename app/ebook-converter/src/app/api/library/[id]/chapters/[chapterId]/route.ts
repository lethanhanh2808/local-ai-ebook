// GET /api/library/[id]/chapters/[chapterId]
// Returns chapter HTML for iframe display.
// ?raw=1      → JSON { title, html }
// ?theme=light|dark|sepia
// ?font=serif|sans|mono
// ?size=16    → font size in px
// ?lh=1.8    → line height
// ?width=720  → max-width in px (scroll mode only)
// ?layout=scroll|spread → scroll = single-column scrollable; spread = two-column paginated
import { NextResponse, NextRequest } from 'next/server';
import { getBook, getBookWatermarks } from '@/lib/db/books';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { resolveBookPath } from '@/lib/storage';
import { stripWatermarks } from '@/lib/pipeline/watermark-strip';
import { prisma } from '@/lib/db/client';
import fs from 'fs';
import path from 'path';

const THEME_COLORS = {
  light: { bg: '#fafaf9', text: '#1c1c1e', htmlBg: '#fafaf9' },
  dark:  { bg: '#1a1a2e', text: '#e2e2e8', htmlBg: '#1a1a2e' },
  // SEPIA — 2-tone palette shared with the reader UI:
  //   • `bg`     = the actual reading surface (lighter cream) — body bg +
  //                readerSurface `input` bg + slider thumb fills.
  //   • `htmlBg` = the "chrome around the spread" tone (darker cream) —
  //                readerSurface `panel` + `header` so the iframe's html
  //                background blends seamlessly with the surrounding UI.
  //   • `text`   = warm dark brown, the single text color (currentColor).
  // Subtle border tone `#c8b89a` and accent copper `#a07840` live in the
  // reader UI; the chapter route only needs currentColor + these three
  // roles so the highlight accent bar (which IS currentColor) tints brown
  // for sepia.
  sepia: { bg: '#f4ede4', text: '#3b2f20', htmlBg: '#ede0ce' },
};

const FONT_STACK = {
  serif: "'Georgia', 'Times New Roman', 'Noto Serif', serif",
  sans:  "'Inter', 'Segoe UI', 'Helvetica Neue', sans-serif",
  mono:  "'JetBrains Mono', 'Consolas', 'Courier New', monospace",
};

/** Shared typographic styles (used in both scroll and spread modes) */
function buildTypoCss(f: string, size: number, lh: number, text: string, indent: number): string {
  const indentEm = indent.toFixed(2);
  return `
  h1, h2, h3, h4, h5, h6 {
    font-weight: 700; line-height: 1.3; text-align: center;
    margin: 2em 0 0.75em; break-after: avoid; column-span: none;
  }
  h1 { font-size: ${Math.round(size * 1.45)}px; margin-top: 1.5em; }
  h1::before { display:block; content:''; border-top:1px solid currentColor; opacity:0.15; margin-bottom:0.75em; }
  h1::after  { display:block; content:''; border-bottom:1px solid currentColor; opacity:0.15; margin-top:0.75em; }
  h2 { font-size: ${Math.round(size * 1.2)}px; }
  h3 { font-size: ${Math.round(size * 1.05)}px; }
  p {
    /* Vietnamese novel style: flush-left paragraphs separated by blank lines.
       text-indent uses the user's indent setting (0 by default = no indent,
       classic book style = 1.5em). First paragraph after a heading is
       always flush-left regardless of the indent value. */
    margin: 0.65em 0;
    text-indent: ${indentEm}em;
    orphans: 3; widows: 3;
  }
  /* First paragraph after a heading has no indent — standard book layout.
     Also reset indent for the very first paragraph in the spread. */
  p:first-of-type, h1 + p, h2 + p, h3 + p, h4 + p { text-indent: 0; }
  hr { border: none; text-align: center; margin: 1.5em auto; column-span: all; }
  hr::after { content: '— ✦ —'; font-size: 0.85em; opacity: 0.4; }
  a { color: inherit; text-decoration: none; border-bottom: 1px solid rgba(128,128,128,0.3); }
  a:hover { border-bottom-color: currentColor; }
  img { max-width: 100%; height: auto; display: block; margin: 1.5em auto; border-radius: 4px; }
  /* AI-generated chapter illustration. Rendered at the top of the chapter
     above the title; tinted border + soft shadow fit both light and dark
     themes via currentColor. */
  figure.chapter-illustration {
    margin: 0 auto 1.5em;
    max-width: 80%;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  figure.chapter-illustration img {
    max-height: 55vh;
    width: auto;
    margin: 0 auto;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    border: 1px solid rgba(128,128,128,0.25);
  }
  figure.chapter-illustration figcaption {
    margin-top: 0.5em;
    text-align: center;
    font-size: 0.85em;
    font-style: italic;
    opacity: 0.65;
    text-indent: 0;
  }
  blockquote { margin: 1.5em 2em; font-style: italic; border-left: 3px solid rgba(128,128,128,0.4); padding-left: 1em; }
  .calibre7, .calibre8 { font-size: inherit; }
  /* BUGFIX 2026-07-11 — Vietnamese/Calibre EPUBs often ship with embedded CSS
     like p { columns: 2 } or section { columns: 2 } to mimic newspaper
     layout. When that combines with our .epub-spread column-count: 2,
     you get nested columns (2 outer x 2 inner = 4 visible). Two layers
     of defense:
       1. stripEmbeddedStyles() (in the route) drops <style> blocks before
          they ever reach the iframe — that removes most rogue rules.
       2. The selector list below prefixes with #epub-clip .epub-spread,
          which raises specificity to (1 ID, 1 class, 1 element) — high
          enough to beat any "p" or "section" rule the EPUB might inject
          via inline style attributes or surviving <style> blocks.
     BUGFIX 2026-07-12 — the previous rule used the \`columns: 1\` shorthand,
     which ALSO sets \`column-width: auto\`. In a multi-column parent, that
     makes each <p> expand to the FULL PARENT WIDTH (820px) instead of the
     current column width (378px), so 3 columns of text bleed into the
     820px clip from neighbouring page tracks. Fix: use \`column-count: 1\`
     alone (no shorthand, no \`column-width: auto\`) so the p's natural
     column-width applies. Also add \`max-width: 100%; box-sizing: border-box\`
     as defense-in-depth in case any future CSS tries to overflow. */
  #epub-clip .epub-spread p,
  #epub-clip .epub-spread section,
  #epub-clip .epub-spread div,
  #epub-clip .epub-spread article,
  #epub-clip .epub-spread blockquote,
  #epub-clip .epub-spread li,
  #epub-clip .epub-spread dd,
  #epub-clip .epub-spread dt {
    column-count: 1 !important;
    max-width: 100%;
    box-sizing: border-box;
  }
  /* Headings and HRs should always span across the spread's columns. */
  h1, h2, h3, h4, h5, h6, hr { column-span: all; }
  section[epub\\:type="chapter"], section[role="doc-chapter"] { display: contents; }
  * { box-sizing: border-box; }
`;
}

function buildScrollCss(
  theme: string, font: string, size: number, lh: number, width: number, indent: number,
  padTop: number, padBottom: number, padInline: number,
): string {
  const t = THEME_COLORS[theme as keyof typeof THEME_COLORS] ?? THEME_COLORS.sepia;
  const f = FONT_STACK[font as keyof typeof FONT_STACK] ?? FONT_STACK.serif;
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: ${t.htmlBg}; }
  body {
    font-family: ${f};
    font-size: ${size}px; line-height: ${lh};
    color: ${t.text}; background: ${t.bg};
    max-width: ${width}px; margin: 0 auto;
    padding: ${padTop}px ${padInline}px ${padBottom}px;
    text-align: justify; word-break: break-word;
  }
  ${buildTypoCss(f, size, lh, t.text, indent)}
`;
}

function buildSpreadCss(
  theme: string, font: string, size: number, lh: number, indent: number,
  padTop: number, padBottom: number, padInline: number, width = 820,
): string {
  const t = THEME_COLORS[theme as keyof typeof THEME_COLORS] ?? THEME_COLORS.dark;
  const f = FONT_STACK[font as keyof typeof FONT_STACK] ?? FONT_STACK.serif;
  // Clip is the visible window for one "page" (one column track = 2 columns).
  // Width MUST equal the spread width so only 2 columns are visible at once;
  // otherwise a wider clip would show 1.5+ page tracks side-by-side, which the
  // user perceives as 3-4 columns. Centered horizontally. Capped at viewport
  // minus padding so it never overflows on narrow screens.
  const clipW = `min(${width}px, calc(100vw - ${2 * padInline}px))`;
  const clipLeft = `max(${padInline}px, calc(50vw - ${width / 2}px))`;
  const clipH = `calc(100vh - ${padTop}px - ${padBottom}px)`;
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { height: 100%; overflow: hidden; background: ${t.htmlBg}; }
  body { height: 100%; overflow: hidden; background: ${t.bg}; }
  /* Fixed clip box: its position/size IS the padding. Body background shows as margins.
     Width = exactly the spread width so only ONE page track (2 columns) is visible
     at a time. The clip scrolls horizontally through page tracks. */
  #epub-clip {
    position: fixed;
    top: ${padTop}px;
    left: ${clipLeft};
    width: ${clipW};
    height: ${clipH};
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  #epub-clip::-webkit-scrollbar { display: none; }
  .epub-spread {
    /* height set via JS to exact clip height for reliable column geometry */
    height: 100%;
    /* NO inline padding — columns fill the clip width exactly.
       column-count: 2 is authoritative — never set to 'auto' (3-column bleed risk) */
    /* !important prevents any inline style="column-count: N" override
       (SPREAD_SCRIPT's narrow-mode path, or a browser extension injecting
       column rules) from blowing the layout up to 3 or 4 columns. Combined
       with the explicit JS threshold sync below, the spread is reliably
       exactly 2 columns whenever the viewport is 400px or wider. */
    column-count: 2 !important;
    column-gap: 4rem;
    column-rule: 1px solid rgba(128,128,128,0.12);
    column-fill: auto;
    font-family: ${f};
    font-size: ${size}px;
    line-height: ${lh};
    color: ${t.text};
    text-align: justify;
    word-break: break-word;
    /* Width equals the clip width (the spread fills the clip edge-to-edge).
       This makes page-track boundary align exactly with clip edges, so the
       visible area is always exactly 2 columns wide. */
    width: 100%;
    /* BUGFIX 2026-07-12 (revised) — MUST stay \`overflow: visible\` (not
       hidden). With column-count:2 + column-fill:auto + a fixed height, the
       content paginates into multiple 2-column "page tracks" that overflow
       the spread horizontally. \`overflow: hidden\` here clips those extra
       tracks, which (a) hides all content past the first 2 columns and
       (b) makes the clip's scrollWidth == clientWidth so the pagination
       script reports only 1 page and can never scroll. The clip's own
       \`overflow-x: auto\` already clips visually at the clip edge, and the
       \`max-width: 100%\` below (plus the per-child max-width:100% rules)
       already prevents any child from exceeding the spread width, so the
       original "leak" concern is covered without clipping pagination. */
    max-width: 100%;
    overflow: visible;
  }
  /* Truly narrow viewport (phone-width iframe): revert to single-column
     scroll. Threshold lowered to 400px so the 2-column layout stays on
     even when the reader iframe is moderately narrowed by an open side
     panel (audio panel, settings) on desktop viewports. */
  @media (max-width: 400px) {
    html { overflow-x: hidden; overflow-y: auto; }
    body { overflow-x: visible; overflow-y: auto; }
    #epub-clip { position: static; width: auto; height: auto; left: auto; overflow: visible; }
    /* !important for parity with the wide-mode rule — guarantees single-column
       even if a browser extension tries to inject column-count: 2 inline. */
    .epub-spread { column-count: 1 !important; column-gap: 0; height: auto; width: auto; padding: 2rem 1.5rem 4rem; }
  }
  ${buildTypoCss(f, size, lh, t.text, indent)}
  /* Spread-specific: allow headings to break across columns */
  h1, h2 { column-span: all; margin-top: 1em; }
`;
}

// Keep old name as alias for compatibility
function buildThemeCss(theme: string, font: string, size: number, lh: number, width: number, indent = 1.5): string {
  return buildScrollCss(theme, font, size, lh, width, indent, 48, 96, 40);
}

/**
 * Render a themed "chapter not found" page so the reader iframe shows a
 * meaningful error instead of a blank iframe displaying raw JSON. Triggered
 * when a TOC click (or any iframe load) hits a chapterId that no longer
 * matches an entry in the parsed EPUB — typically because the EPUB was
 * re-imported and the chapter-id scheme shifted, or a stale URL was opened.
 *
 * Status code is preserved as the actual HTTP status (404 for "not found",
 * 500 for parse failures) so the browser still surfaces the right thing in
 * DevTools and any failure-detection wiring in the parent reader works.
 */
function chapterNotFoundHtml(
  theme: string,
  chapterId: string,
  bookId: string,
  status: number,
): NextResponse {
  const t = THEME_COLORS[theme as keyof typeof THEME_COLORS] ?? THEME_COLORS.sepia;
  const safeId = chapterId.replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Không tìm thấy chương — ${safeId}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      background: ${t.bg};
      color: ${t.text};
      font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', sans-serif;
      display: flex; align-items: center; justify-content: center;
      padding: 2rem; box-sizing: border-box;
    }
    .box {
      max-width: 480px; text-align: center; line-height: 1.55;
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; font-weight: 600; }
    p { margin: 0.5rem 0; opacity: 0.85; font-size: 0.95rem; }
    code {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      background: rgba(127,127,127,0.15); padding: 0.1em 0.35em;
      border-radius: 4px; font-size: 0.9em;
    }
    a {
      color: inherit; text-decoration: underline; opacity: 0.9;
    }
    a:hover { opacity: 1; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Không tìm thấy chương</h1>
    <p>Chương <code>${safeId}</code> không tồn tại trong cuốn sách này. Có thể sách vừa được nhập lại và các mục đã được đánh số lại.</p>
    <p><a href="/library/${bookId}/read">← Quay lại mục lục</a></p>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Rewrite relative img src and anchor href to use our asset API or chapter navigation.
 *
 * Covers every reference shape that the EPUB spec allows:
 *   - <img src="…"> (HTML)
 *   - <image xlink:href="…"> + <image href="…"> (SVG, EPUB covers)
 *   - <a href="…"> that points to an EPUB chapter file (".html", ".xhtml", ".htm")
 *     → converted to `data-epub-chapter="<basename>"` so NAV_SCRIPT can
 *        postMessage to the parent reader instead of trying to navigate.
 *   - <link href="…"> for stylesheets
 *   - CSS `url(...)` inside <style> blocks
 *
 * Bug history (2026-07-08): the original rewrite only matched `.xhtml`
 * chapter hrefs, so Calibre-style EPUBs (which use `.html`) leaked
 * through and the iframe browser tried to resolve `../Text/C0.html`
 * relative to `/api/library/<id>/chapters/chapter002` →
 * `/api/library/<id>/Text/C0.html` → 404. SVG <image xlink:href> was
 * also untouched, so any EPUB that embeds its cover as SVG (very
 * common for Vietnamese novels exported by Calibre) produced a
 * permanent 404 on `cover.jpeg` from chapter 1.
 */
function rewriteAssets(html: string, bookId: string): string {
  // Keep any absolute / external URL untouched. Same for data:, mailto:, javascript:.
  const isAbsolute = (u: string) =>
    u.startsWith('data:') ||
    u.startsWith('http://') ||
    u.startsWith('https://') ||
    u.startsWith('//') ||
    u.startsWith('/api/') ||
    u.startsWith('mailto:') ||
    u.startsWith('javascript:') ||
    u.startsWith('#');

  // Normalize a relative URL by collapsing ../../ etc. We can't truly resolve
  // against the chapter file's directory without knowing it, but for the
  // typical EPUB layout (everything under EPUB/) stripping all `../` gives
  // the correct resource path under /assets.
  const resolveAsset = (src: string) => {
    // Strip query / hash
    const clean = src.split('#')[0].split('?')[0];
    const stripped = clean.replace(/^(\.\.\/)+/, '').replace(/^\//, '');
    return `/api/library/${bookId}/assets/${stripped}`;
  };

  // Pull just the basename without extension from a chapter-file href.
  // e.g. "../Text/C0.html" → "C0", "chapter1.xhtml#sec2" → "chapter1"
  const chapterBasename = (href: string) => {
    const noQuery = href.split('#')[0].split('?')[0];
    const noSlash = noQuery.split('/').pop() ?? '';
    return noSlash.replace(/\.(x?html?|xhtml)$/i, '');
  };

  let out = html;

  // 1. <img src="…">
  out = out.replace(
    /(<img\b[^>]*?)\ssrc=(?:"([^"]*)"|'([^']*)')([^>]*?>)/gi,
    (_match, before, dq, sq, after) => {
      const src = dq ?? sq ?? '';
      if (isAbsolute(src)) {
        return `${before} src="${src}" onerror="this.style.display='none'"${after}`;
      }
      return `${before} src="${resolveAsset(src)}" onerror="this.style.display='none'"${after}`;
    },
  );

  // 2. <image xlink:href="…">  +  <image href="…">   (SVG / EPUB cover)
  out = out.replace(
    /(<image\b[^>]*?\s(?:xlink:)?href=)(?:"([^"]*)"|'([^']*)')/gi,
    (_m, before, dq, sq) => {
      const href = dq ?? sq ?? '';
      if (isAbsolute(href)) return `${before}"${href}"`;
      return `${before}"${resolveAsset(href)}"`;
    },
  );

  // 3. <a href="…"> that points to a chapter file (.xhtml, .html, .htm)
  //    → convert to in-iframe navigation via data-epub-chapter.
  out = out.replace(
    /(<a\b[^>]*?\s)href=(?:"([^"]*)"|'([^']*)')/gi,
    (_m, before, dq, sq) => {
      const href = (dq ?? sq ?? '').trim();
      if (isAbsolute(href) || href === '' || href.startsWith('#')) {
        return `${before}"${href}"`;
      }
      // Only treat as a chapter ref if it ends in a known chapter extension.
      if (!/\.(x?html?|xhtml)$/i.test(href.split('#')[0].split('?')[0])) {
        return `${before}"${href}"`;
      }
      const chId = chapterBasename(href);
      return `${before}"#" data-epub-chapter="${chId}"`;
    },
  );

  // 4. <link href="…"> (stylesheets) — same path-resolution as <img src>.
  out = out.replace(
    /(<link\b[^>]*?)\shref=(?:"([^"]*)"|'([^']*)')([^>]*?>)/gi,
    (_m, before, dq, sq, after) => {
      const href = dq ?? sq ?? '';
      if (isAbsolute(href)) return `${before} href="${href}"${after}`;
      return `${before} href="${resolveAsset(href)}"${after}`;
    },
  );

  // 5. CSS url(...) inside <style> blocks. Match url("...") / url('...') / url(...)
  //    — we keep absolute / external URLs untouched.
  out = out.replace(
    /url\((?:"([^"]*)"|'([^']*)'|([^)"\s]+))\)/gi,
    (_m, dq, sq, bare) => {
      const url = dq ?? sq ?? bare ?? '';
      if (isAbsolute(url)) return `url("${url}")`;
      return `url("${resolveAsset(url)}")`;
    },
  );

  return out;
}

/** Navigation + image-fix script injected into every chapter iframe */
const NAV_SCRIPT = `<script>
(function() {
  // Hide broken/missing images immediately and on error
  function hideBroken(img) {
    if (!img.complete || img.naturalWidth === 0) img.style.display = 'none';
    img.addEventListener('error', function() { this.style.display = 'none'; });
  }
  document.querySelectorAll('img').forEach(hideBroken);
  new MutationObserver(function(muts) {
    muts.forEach(function(m) { m.addedNodes.forEach(function(n) {
      if (n.nodeType === 1) {
        if (n.tagName === 'IMG') hideBroken(n);
        n.querySelectorAll && n.querySelectorAll('img').forEach(hideBroken);
      }
    }); });
  }).observe(document.body, { childList: true, subtree: true });

  // Intercept chapter links and notify parent
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document.documentElement) {
      if (el.tagName === 'A' && el.getAttribute('data-epub-chapter')) {
        e.preventDefault();
        window.parent.postMessage({ type: 'epub-navigate', chapterId: el.getAttribute('data-epub-chapter') }, '*');
        return;
      }
      el = el.parentElement;
    }
  }, true);
})();
</script>`;

/** Two-column spread pagination script.
 * Uses #epub-clip as the scroll container so column overflow never bleeds outside
 * the padded content area — the body background naturally shows as page margins.
 */
const SPREAD_SCRIPT = `<script>
(function() {
  var currentPage = 0;
  var isSingleCol = false;
  var clip = null; // #epub-clip — the actual horizontal scroll container

  function getClip() {
    return clip || (clip = document.getElementById('epub-clip'));
  }

  function setExactColumnGeometry() {
    var spread = document.querySelector('.epub-spread');
    var c = getClip();
    if (!spread || !c || isSingleCol) return;
    // Height = clip client height (already sized to exclude padTop/padBottom via fixed positioning)
    spread.style.height = c.clientHeight + 'px';
  }

  function updateLayout() {
    var spread = document.querySelector('.epub-spread');
    if (!spread) return;
    // Must mirror the CSS @media (max-width: 400px) threshold above — if these
    // drift apart, the JS will switch to single-column at a width where the
    // CSS still wants 2 columns, and you'll see a flash from 2 → 1 columns on
    // every resize.
    var narrow = window.innerWidth < 400;
    if (narrow !== isSingleCol) {
      isSingleCol = narrow;
      if (narrow) {
        spread.style.columnCount = '1';
        spread.style.columnWidth = '';
        spread.style.columnGap = '0';
        spread.style.height = 'auto';
      } else {
        // Clear narrow-mode overrides — CSS column-count:2 takes over
        spread.style.columnCount = '';
        spread.style.columnWidth = '';
        spread.style.columnGap = '';
        setExactColumnGeometry();
      }
      currentPage = 0;
    } else if (!narrow) {
      setExactColumnGeometry();
    }
  }

  // Page width = clip client width (already excludes inline padding via clip positioning)
  function getPageWidth() {
    var c = getClip();
    return c ? Math.max(1, c.clientWidth) : window.innerWidth;
  }

  // Total pages = clip scrollWidth / clip clientWidth (column tracks equal clip width exactly)
  function getTotalPages() {
    if (isSingleCol) return 1;
    var c = getClip();
    if (!c) return 1;
    var pageW = getPageWidth();
    return Math.max(1, Math.round(c.scrollWidth / pageW));
  }

  function goToPage(n) {
    if (isSingleCol) { notifyParent(1); return; }
    var c = getClip();
    if (!c) return;
    var total = getTotalPages();
    currentPage = Math.max(0, Math.min(n, total - 1));
    c.scrollLeft = currentPage * getPageWidth();
    notifyParent(total);
  }

  function notifyParent(total) {
    window.parent.postMessage({
      type: 'page-info',
      current: currentPage,
      total: total != null ? total : getTotalPages()
    }, '*');
  }

  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'next-page') {
      if (isSingleCol) { window.parent.postMessage({ type: 'chapter-end' }, '*'); return; }
      var total = getTotalPages();
      if (currentPage >= total - 1) {
        window.parent.postMessage({ type: 'chapter-end' }, '*');
      } else {
        goToPage(currentPage + 1);
      }
    } else if (e.data.type === 'prev-page') {
      if (currentPage <= 0) {
        window.parent.postMessage({ type: 'chapter-start' }, '*');
      } else {
        goToPage(currentPage - 1);
      }
    } else if (e.data.type === 'go-last-page') {
      goToPage(getTotalPages() - 1);
    }
  });

  window.addEventListener('load', function() {
    clip = document.getElementById('epub-clip');
    updateLayout();
    setTimeout(function() { goToPage(0); }, 80);
  });

  var resizeTimer;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
      clip = document.getElementById('epub-clip');
      updateLayout();
      goToPage(currentPage);
    }, 120);
  });
})();
</script>`;

/** Remove the first duplicate heading if the same text appears twice in a row */
function deduplicateHeading(html: string): string {
  // Match first heading
  const headRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/i;
  const m = headRe.exec(html);
  if (!m) return html;
  const headText = m[2].replace(/<[^>]+>/g, '').trim();
  // Check if the same heading text appears again within the next 2000 chars after the first match
  const afterFirst = html.slice(m.index + m[0].length, m.index + m[0].length + 2000);
  const dupRe = new RegExp(`<h[1-3][^>]*>[\\s\\S]*?${headText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?<\\/h[1-3]>`, 'i');
  if (dupRe.test(afterFirst)) {
    // Remove the FIRST heading occurrence (the outer wrapper duplicate)
    return html.slice(0, m.index) + html.slice(m.index + m[0].length);
  }
  return html;
}

/** Strip known watermark phrases from chapter HTML.
 *  Implementation moved to `@/lib/pipeline/watermark-strip` so it can be
 *  shared between the live reader (this route) and the apply-to-file
 *  endpoint (`/api/library/[id]/watermarks/apply`). */

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> }
) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) {
    const theme = req.nextUrl.searchParams.get('theme') ?? 'sepia';
    if (req.nextUrl.searchParams.get('raw') !== '1') {
      return chapterNotFoundHtml(theme, params.chapterId, params.id, 404);
    }
    return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  }
  const filePath = await resolveBookPath(book);
  if (!fs.existsSync(filePath)) {
    const theme = req.nextUrl.searchParams.get('theme') ?? 'sepia';
    if (req.nextUrl.searchParams.get('raw') !== '1') {
      return chapterNotFoundHtml(theme, params.chapterId, params.id, 404);
    }
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  const wantRaw   = sp.get('raw')    === '1';
  const theme     = sp.get('theme')  ?? 'sepia';
  const font      = sp.get('font')   ?? 'serif';
  const fontSize  = Math.max(12, Math.min(28, parseInt(sp.get('size') ?? '18', 10)));
  const lineH     = Math.max(1.3, Math.min(3.0, parseFloat(sp.get('lh') ?? '1.85')));
  const width     = Math.max(400, Math.min(1200, parseInt(sp.get('width') ?? '720', 10)));
  const layout    = sp.get('layout') ?? 'spread';
  const isSpread  = layout === 'spread';
  const indent    = Math.max(0, Math.min(3, parseFloat(sp.get('indent') ?? '1.5')));
  const padTop    = Math.max(0, Math.min(200, parseInt(sp.get('padt') ?? '48', 10)));
  const padBottom = Math.max(0, Math.min(200, parseInt(sp.get('padb') ?? '96', 10)));
  const padInline = Math.max(0, Math.min(200, parseInt(sp.get('padx') ?? '40', 10)));

  try {
    const [epub, watermarks] = await Promise.all([
      parseEpub(filePath),
      getBookWatermarks(params.id),
    ]);

    const chapterId = params.chapterId;
    const file = epub.htmlFiles.find(
      (f) =>
        path.basename(f, path.extname(f)) === chapterId ||
        path.basename(f) === chapterId,
    );
    // For the iframe case (no ?raw=1), render a themed HTML error page so the
    // user sees a meaningful "chapter not found" message inside the reader
    // instead of a blank iframe showing raw JSON. API callers using ?raw=1
    // still get JSON for programmatic error handling.
    if (!file) {
      if (!wantRaw) return chapterNotFoundHtml(theme, chapterId, params.id, 404);
      return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
    }

    // The Illustration model is keyed on the 0-based index in
    // epub.htmlFiles, which is the same ordering the generator used when
    // it built its `chapters[]` array. Position in htmlFiles = chapterIndex.
    const chapterIndex = epub.htmlFiles.indexOf(file);

    const entry = epub.entries.get(file);
    if (!entry) {
      if (!wantRaw) return chapterNotFoundHtml(theme, chapterId, params.id, 404);
      return NextResponse.json({ error: 'Chapter data missing' }, { status: 404 });
    }

    const rawHtml = entry.data.toString('utf8');
    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const rawBody = bodyMatch ? bodyMatch[1] : rawHtml;

    // Strip embedded <style> blocks from the chapter body BEFORE any other
    // processing. Vietnamese/Calibre EPUBs commonly ship with inline CSS
    // like `p { columns: 2 }` or `section { columns: 2 }` that targets our
    // reader's block-level children — when that nests inside our
    // `.epub-spread { column-count: 2 }`, you get 2 outer × 2 inner = 4
    // visible columns. Embedded <style> blocks also routinely include
    // styles that fight our theme (hard-coded colors, fonts, margins),
    // so removing them is a clean win on top of the higher-specificity
    // override in buildTypoCss. Our <style> in <head> already provides
    // every typographic rule the reader needs.
    const noStyle = rawBody.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

    // Rewrite assets and chapter links, deduplicate headings, strip watermarks
    const rewritten = rewriteAssets(noStyle, params.id);
    const deduped   = deduplicateHeading(rewritten);
    const stripped  = stripWatermarks(deduped, watermarks);

    // Extract title from first heading (after dedup)
    const titleMatch = stripped.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : chapterId;

    // Look up the AI-generated illustration for this chapter (if any) and
    // prepend a <figure> so the reader sees the image at the top of the
    // chapter. Skipped when the caller asked for ?raw=1 (API consumers
    // want pure body HTML, not the decorated reader view). Skipped on
    // DB lookup failure (table missing, schema drift) so a transient
    // prisma error doesn't break the entire reader.
    let bodyContent = stripped;
    if (!wantRaw) {
      let illustrationHtml = '';
      try {
        const ill = await prisma.illustration.findUnique({
          where: {
            bookId_chapterIndex: { bookId: params.id, chapterIndex },
          },
          select: { chapterTitle: true, imageModel: true },
        });
        if (ill) {
          const captionTitle = ill.chapterTitle?.trim() || title;
          const safeTitle = captionTitle
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          illustrationHtml =
            `<figure class="chapter-illustration">` +
              `<img src="/api/library/${params.id}/illustrations/${chapterIndex}" ` +
                   `alt="${safeTitle}" loading="eager" ` +
                   `onerror="this.parentNode.style.display='none'" />` +
            `</figure>`;
        }
      } catch (err) {
        console.warn(`[chapter] illustration lookup failed for ${params.id}/${chapterIndex}:`, err);
      }
      bodyContent = illustrationHtml + stripped;
    }

    if (wantRaw) {
      return NextResponse.json({ title, html: bodyContent });
    }

    let page: string;
    if (isSpread) {
      const spreadCss = buildSpreadCss(theme, font, fontSize, lineH, indent, padTop, padBottom, padInline, width);
      const themeColors = THEME_COLORS[theme as keyof typeof THEME_COLORS] ?? THEME_COLORS.dark;
      page = `<!DOCTYPE html>
<html lang="${book.language ?? 'vi'}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title.replace(/</g, '&lt;')}</title>
  <style>${spreadCss}</style>
</head>
<body style="background:${themeColors.bg}">
<div id="epub-clip"><div class="epub-spread">
${bodyContent}
</div></div>
</body>
${NAV_SCRIPT}
${SPREAD_SCRIPT}
</html>`;
    } else {
      const scrollCss = buildScrollCss(theme, font, fontSize, lineH, width, indent, padTop, padBottom, padInline);
      page = `<!DOCTYPE html>
<html lang="${book.language ?? 'vi'}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title.replace(/</g, '&lt;')}</title>
  <style>${scrollCss}</style>
</head>
<body>
${bodyContent}
</body>
${NAV_SCRIPT}
</html>`;
    }

    return new NextResponse(page, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    console.error('[chapter] error', err);
    return NextResponse.json({ error: 'Failed to read chapter' }, { status: 500 });
  }
}

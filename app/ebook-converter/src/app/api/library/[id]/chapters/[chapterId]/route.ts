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
import fs from 'fs';
import path from 'path';

const THEME_COLORS = {
  light: { bg: '#fafaf9', text: '#1c1c1e', htmlBg: '#fafaf9' },
  dark:  { bg: '#1a1a2e', text: '#e2e2e8', htmlBg: '#1a1a2e' },
  sepia: { bg: '#f4ede4', text: '#3b2f20', htmlBg: '#ede0d0' },
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
  p { margin: 0; text-indent: ${indentEm}em; orphans: 3; widows: 3; }
  p + p { margin-top: 0.08em; }
  p:first-of-type, h1+p, h2+p, h3+p, h4+p { text-indent: 0; }
  hr { border: none; text-align: center; margin: 1.5em auto; column-span: all; }
  hr::after { content: '— ✦ —'; font-size: 0.85em; opacity: 0.4; }
  a { color: inherit; text-decoration: none; border-bottom: 1px solid rgba(128,128,128,0.3); }
  a:hover { border-bottom-color: currentColor; }
  img { max-width: 100%; height: auto; display: block; margin: 1.5em auto; border-radius: 4px; }
  blockquote { margin: 1.5em 2em; font-style: italic; border-left: 3px solid rgba(128,128,128,0.4); padding-left: 1em; }
  .calibre7, .calibre8 { font-size: inherit; }
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
  padTop: number, padBottom: number, padInline: number,
): string {
  const t = THEME_COLORS[theme as keyof typeof THEME_COLORS] ?? THEME_COLORS.dark;
  const f = FONT_STACK[font as keyof typeof FONT_STACK] ?? FONT_STACK.serif;
  const clipW = `calc(100vw - ${2 * padInline}px)`;
  const clipH = `calc(100vh - ${padTop}px - ${padBottom}px)`;
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { height: 100%; overflow: hidden; background: ${t.htmlBg}; }
  body { height: 100%; overflow: hidden; background: ${t.bg}; }
  /* Fixed clip box: its position/size IS the padding. Body background shows as margins.
     Columns overflow inside this box only — zero bleed past edges. */
  #epub-clip {
    position: fixed;
    top: ${padTop}px;
    left: ${padInline}px;
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
    column-count: 2;
    column-gap: 4rem;
    column-rule: 1px solid rgba(128,128,128,0.12);
    column-fill: auto;
    font-family: ${f};
    font-size: ${size}px;
    line-height: ${lh};
    color: ${t.text};
    text-align: justify;
    word-break: break-word;
  }
  /* Narrow viewport: revert to normal page flow */
  @media (max-width: 700px) {
    html { overflow-x: hidden; overflow-y: auto; }
    body { overflow-x: visible; overflow-y: auto; }
    #epub-clip { position: static; width: auto; height: auto; overflow: visible; }
    .epub-spread { column-count: 1; column-gap: 0; height: auto; padding: 2rem 1.5rem 4rem; }
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

/** Rewrite relative img src and anchor href to use our asset API or chapter navigation */
function rewriteAssets(html: string, bookId: string): string {
  // Rewrite img src – handle both single and double quotes
  const rewriteSrc = (src: string) => {
    if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//') || src.startsWith('/api/')) return src;
    // Strip ALL leading ../ and leading /
    const resolved = src.replace(/^(\.\.\/)+/, '').replace(/^\//, '');
    return `/api/library/${bookId}/assets/${resolved}`;
  };

  let out = html.replace(
    /(<img\b[^>]*?)\ssrc=(?:"([^"]*)"|'([^']*)')([^>]*?>)/gi,
    (_match, before, dq, sq, after) => {
      const src = dq ?? sq ?? '';
      const newSrc = rewriteSrc(src);
      return `${before} src="${newSrc}" onerror="this.style.display='none'"${after}`;
    },
  );

  // Rewrite chapter href links to use data attribute for JS navigation
  out = out.replace(
    /(<a\b[^>]*?\s)href="([^"#][^"]*\.xhtml[^"]*)"/gi,
    (_m, before, href) => {
      const chId = path.basename(href, '.xhtml').split('#')[0];
      return `${before}href="#" data-epub-chapter="${chId}"`;
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
    var narrow = window.innerWidth < 700;
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
 *  Removes entire <p> elements whose text content matches a watermark,
 *  and also removes standalone occurrences of the watermark text. */
function stripWatermarks(html: string, watermarks: string[]): string {
  if (!watermarks.length) return html;
  let result = html;
  for (const wm of watermarks) {
    const escaped = wm.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Remove <p> elements whose text content contains (only) the watermark
    result = result.replace(
      new RegExp(`<p[^>]*>\\s*(?:<[^>]+>\\s*)*${escaped}\\s*(?:<\\/[^>]+>\\s*)*<\\/p>`, 'gi'),
      '',
    );
    // Remove standalone watermark text (e.g. in divs, spans, plain text nodes)
    result = result.replace(new RegExp(escaped, 'gi'), '');
  }
  return result;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; chapterId: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const filePath = await resolveBookPath(book);
  if (!fs.existsSync(filePath)) {
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
    if (!file) {
      return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
    }

    const entry = epub.entries.get(file);
    if (!entry) return NextResponse.json({ error: 'Chapter data missing' }, { status: 404 });

    const rawHtml = entry.data.toString('utf8');
    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const rawBody = bodyMatch ? bodyMatch[1] : rawHtml;

    // Rewrite assets and chapter links, deduplicate headings, strip watermarks
    const rewritten = rewriteAssets(rawBody, params.id);
    const deduped   = deduplicateHeading(rewritten);
    const bodyContent = stripWatermarks(deduped, watermarks);

    // Extract title from first heading (after dedup)
    const titleMatch = bodyContent.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : chapterId;

    if (wantRaw) {
      return NextResponse.json({ title, html: bodyContent });
    }

    let page: string;
    if (isSpread) {
      const spreadCss = buildSpreadCss(theme, font, fontSize, lineH, indent, padTop, padBottom, padInline);
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

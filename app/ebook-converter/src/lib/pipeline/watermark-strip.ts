// src/lib/pipeline/watermark-strip.ts
// Single source of truth for stripping watermark phrases from chapter HTML.
// Used by:
//   • /api/library/[id]/chapters/[chapterId]    (live reader)
//   • /api/library/[id]/watermarks/apply        (rewrite EPUB file on disk)
//
// BUGFIX 2026-07-11 — longest-first sort prevents substring bleed:
// when the user has both "DTV-EBOOK" and "Đọc thêm truyện hay tại:
// DTV-EBOOK.com.vn" saved, processing the short one first would strip
// just "DTV-EBOOK" and leave a residue ".com.vn" at the end of the
// long phrase. Sort longest-first so the long phrase is consumed first.
// Word boundaries are NOT added to the per-phrase regex — Vietnamese
// watermarks contain hyphens, slashes, dots, and colons that aren't
// true word separators; tightening the regex would miss legitimate
// standalone matches. Longest-first is the right fix.
//
// BUGFIX 2026-07-11 (also) — handle tag-split watermarks: the auto-
// detector extracts phrases from PLAIN TEXT (tags stripped), so a saved
// phrase like "Đọc thêm truyện hay tại: .com.vn" never matches the raw
// HTML "Đọc thêm truyện hay tại: <a href="https://dtv-ebook.com.vn">
// .com.vn</a>". Solution: for each <p> element, also check its plain
// text — if the plain text contains the phrase, strip the entire <p>.
//
// BUGFIX 2026-07-12 — wrapper-aware pass for DTV-style footers.
// The original implementation only operated on <p>…</p> containers, so
// it silently left <div class="header">…</div> envelopes in place (the
// phrase text inside was stripped but the empty wrapper remained). The
// new "Pass 1" walks <p>, <div>, <span>, <h1>..<h6> containers the same
// way: for each open/close pair, if its plain-text content contains
// the watermark phrase, drop the whole element. This handles the common
// case where a watermark is wrapped in any block-level container — the
// exact match of which tag (p / div / span / h*) varies by publisher.

const PHASE_TAGS = ['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
type PhaseTag = (typeof PHASE_TAGS)[number];

/** Escape a literal phrase for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract plain text from an HTML fragment by stripping all tags and
 *  decoding common entities. Used to compare <p> content against phrases
 *  that the detector extracted from plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find every <tag>…</tag> span in `html` for any tag in PHASE_TAGS.
 *  Returns an array of [startIdx, endIdx) ranges (endIdx is past the
 *  closing </tag>, optionally past a trailing newline). */
function findBlockSpans(html: string, tags: readonly PhaseTag[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const tagPattern = tags.join('|');
  const re = new RegExp(`<(${tagPattern})\\b[^>]*>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const openTag = m[1].toLowerCase();
    const closeIdx = html.toLowerCase().indexOf(`</${openTag}>`, re.lastIndex);
    if (closeIdx === -1) break;
    let endIdx = closeIdx + `</${openTag}>`.length;
    if (html[endIdx] === '\n') endIdx += 1;
    spans.push([m.index, endIdx]);
    re.lastIndex = closeIdx + `</${openTag}>`.length;
  }
  return spans;
}

/** Find every <p>…</p> span in `html`. Returns an array of [startIdx,
 *  endIdx) ranges (endIdx is just past the closing </p>, optionally
 *  past a trailing newline). Kept for callers that explicitly want
 *  paragraph-only behaviour. */
function findParagraphSpans(html: string): Array<[number, number]> {
  return findBlockSpans(html, ['p']);
}

/** Strip known watermark phrases from chapter HTML.
 *
 *  Three passes, all longest-first (so a long composite phrase eats its
 *  own substrings before a shorter one can chew a hole):
 *    1. Wrapper-aware element stripping — for each block-level element
 *       (<p>, <div>, <span>, <h1>..<h6>), compute its plain text. If the
 *       plain text contains a saved phrase, drop the entire element.
 *       Handles the common case where the watermark is wrapped in an
 *       <a> tag inside a <p> or simply lives in a <div class="header">.
 *    2. Block-template regex strip — legacy pass that handles rare cases
 *       where the detector returned an HTML-formatted phrase.
 *    3. Bare-text regex strip — fall back to literal substring match in
 *       the raw HTML. Catches watermarks that aren't wrapped in any
 *       block element at all. */
export function stripWatermarks(html: string, watermarks: string[]): string {
  if (!watermarks.length) return html;
  const sorted = [...new Set(watermarks.map((w) => w.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  if (!sorted.length) return html;

  // ── Pass 1: wrapper-aware element stripping ─────────────────────────────
  // Walk all block-level containers (p / div / span / h1..h6) of the
  // CURRENT html (after Pass 1 deletions, indices shift; we re-scan each
  // iteration since Pass 1 can shrink the document by multiple elements
  // per phrase).
  let result = html;
  for (const wm of sorted) {
    const spans = findBlockSpans(result, PHASE_TAGS);
    if (!spans.length) break;
    const drop: Array<[number, number]> = [];
    for (const [s, e] of spans) {
      const inner = result.slice(s, e);
      const openClose = inner.match(/^<\s*(p|div|span|h[1-6])\b[^>]*>/i);
      const closeOnly = inner.match(/<\/\s*(p|div|span|h[1-6])\s*>$/i);
      if (!openClose || !closeOnly) continue;
      const openLen = openClose[0].length;
      const closeLen = closeOnly[0].length;
      const plain = htmlToText(inner.slice(openLen, inner.length - closeLen));
      if (plain && plain.toLowerCase().includes(wm.toLowerCase())) {
        drop.push([s, e]);
      }
    }
    if (!drop.length) continue;
    // Rebuild result skipping the dropped ranges.
    let rebuilt = '';
    let cursor = 0;
    for (const [s, e] of drop) {
      rebuilt += result.slice(cursor, s);
      cursor = e;
    }
    rebuilt += result.slice(cursor);
    result = rebuilt;
  }

  // ── Pass 2: HTML-template pass (handles HTML-formatted detector output) ─
  // We generalise the legacy <p>-only template to any block-level element,
  // since the detector runs on plain text but the saved phrase might
  // come from a user who added a phrase by sight-copying a div from the
  // rendered EPUB.
  for (const wm of sorted) {
    const escaped = escapeRegExp(wm);
    const tagAlt = PHASE_TAGS.join('|');
    result = result.replace(
      new RegExp(`<(${tagAlt})[^>]*>\\s*(?:<[^>]+>\\s*)*${escaped}\\s*(?:<\\/[^>]+>\\s*)*<\\/\\1>`, 'gi'),
      '',
    );
  }

  // ── Pass 3: bare-text regex fallback ───────────────────────────────────
  for (const wm of sorted) {
    const escaped = escapeRegExp(wm);
    // Literal substring in raw HTML
    result = result.replace(new RegExp(escaped, 'gi'), '');
  }

  return result;
}

/** Count case-insensitive occurrences of each phrase. Counts come from
 *  two sources, deduped so a single element is counted at most once:
 *    1. Block-level elements (<p>, <div>, <span>, <h1..h6>) whose plain
 *       text contains the phrase — contributes one hit per matching
 *       element.
 *    2. Raw-HTML substring matches OUTSIDE any matching element — used
 *       to catch watermarks that aren't wrapped in any block at all.
 *  This mirrors what the apply pass actually removes and avoids
 *  double-counting. */
export function countPhraseHits(html: string, watermarks: string[]): { phrase: string; hits: number }[] {
  return watermarks.map((wm) => {
    const phrase = wm.trim();
    if (!phrase) return { phrase, hits: 0 };
    const escaped = escapeRegExp(phrase);

    // 1. Find every block-level element whose plain text contains the
    //    phrase. Record the (start, end) of each such element so we can
    //    exclude them from the raw-HTML pass below.
    const matchingSpans: Array<[number, number]> = [];
    const spans = findBlockSpans(html, PHASE_TAGS);
    for (const [s, e] of spans) {
      const inner = html.slice(s, e);
      const openClose = inner.match(/^<\s*(p|div|span|h[1-6])\b[^>]*>/i);
      const closeOnly = inner.match(/<\/\s*(p|div|span|h[1-6])\s*>$/i);
      if (!openClose || !closeOnly) continue;
      const openLen = openClose[0].length;
      const closeLen = closeOnly[0].length;
      const plain = htmlToText(html.slice(s + openLen, e - closeLen));
      if (plain && plain.toLowerCase().includes(phrase.toLowerCase())) {
        matchingSpans.push([s, e]);
      }
    }

    // 2. Raw-HTML substring matches OUTSIDE the matching element spans.
    let deDuped = html;
    for (const [s, e] of matchingSpans) {
      deDuped = deDuped.slice(0, s) + ' '.repeat(e - s) + deDuped.slice(e);
    }
    const rawHits = deDuped.match(new RegExp(escaped, 'gi'))?.length ?? 0;

    return { phrase, hits: matchingSpans.length + rawHits };
  });
}

// Re-export for tests / direct callers that want the paragraph-only spans.
export const __internal__ = { findParagraphSpans, findBlockSpans, htmlToText };

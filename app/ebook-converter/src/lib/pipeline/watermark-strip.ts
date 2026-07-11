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

/** Find every <p>…</p> span in `html`. Returns an array of [startIdx,
 *  endIdx) ranges (endIdx is just past the closing </p>, optionally
 *  past a trailing newline). */
function findParagraphSpans(html: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /<p\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const closeIdx = html.indexOf('</p>', re.lastIndex);
    if (closeIdx === -1) break;
    let endIdx = closeIdx + '</p>'.length;
    if (html[endIdx] === '\n') endIdx += 1;
    spans.push([m.index, endIdx]);
    // Continue scanning past this <p>
    re.lastIndex = closeIdx + 4;
  }
  return spans;
}

/** Strip known watermark phrases from chapter HTML.
 *
 *  Two passes, both longest-first (so a long composite phrase eats its
 *  own substrings before a shorter one can chew a hole):
 *    1. Tag-tolerant <p> stripping — for each <p> element, compute its
 *       plain text. If the plain text contains a saved phrase, drop the
 *       entire <p>. This handles the common case where the watermark is
 *       wrapped in an <a> tag (e.g. <p>Đọc thêm truyện hay tại:
 *       <a href="…"> .com.vn</a></p>).
 *    2. Bare-text regex strip — fall back to literal substring match in
 *       the raw HTML. Catches watermarks that aren't wrapped in <p>.
 */
export function stripWatermarks(html: string, watermarks: string[]): string {
  if (!watermarks.length) return html;
  const sorted = [...new Set(watermarks.map((w) => w.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  if (!sorted.length) return html;

  // ── Pass 1: tag-tolerant <p> stripping ─────────────────────────────────
  // Walk paragraphs of the ORIGINAL html (no in-place mutation), decide
  // which to drop, then rebuild.
  let result = html;
  for (const wm of sorted) {
    const spans = findParagraphSpans(result);
    if (!spans.length) break;
    const drop: Array<[number, number]> = [];
    for (const [s, e] of spans) {
      const inner = result.slice(s, e);
      const openClose = inner.match(/<p\b[^>]*>/i);
      const closeOnly = inner.match(/<\/p>/i);
      if (!openClose || !closeOnly) continue;
      const innerStart = s + openClose[0].length;
      const innerEnd = s + closeOnly.index!;
      const plain = htmlToText(result.slice(innerStart, innerEnd));
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

  // ── Pass 2: bare-text regex fallback ───────────────────────────────────
  for (const wm of sorted) {
    const escaped = escapeRegExp(wm);
    // Same <p>-wrapper template as before (kept for chapters where the
    // detector returned an HTML-formatted phrase).
    result = result.replace(
      new RegExp(`<p[^>]*>\\s*(?:<[^>]+>\\s*)*${escaped}\\s*(?:<\\/[^>]+>\\s*)*<\\/p>`, 'gi'),
      '',
    );
    // Literal substring in raw HTML
    result = result.replace(new RegExp(escaped, 'gi'), '');
  }

  return result;
}

/** Count case-insensitive occurrences of each phrase. Counts come from
 *  two sources, deduped so a single <p> element is counted at most once:
 *    1. <p> elements whose plain text contains the phrase — contributes
 *       one hit per matching <p>.
 *    2. Raw-HTML substring matches OUTSIDE any matching <p> — used to
 *       catch watermarks that aren't wrapped in <p> at all.
 *  This mirrors what the apply pass actually removes and avoids
 *  double-counting (e.g. "truyện hay" inside a watermark <p> shouldn't
 *  be counted both as a raw substring match AND as a plain-text <p> match). */
export function countPhraseHits(html: string, watermarks: string[]): { phrase: string; hits: number }[] {
  return watermarks.map((wm) => {
    const phrase = wm.trim();
    if (!phrase) return { phrase, hits: 0 };
    const escaped = escapeRegExp(phrase);

    // 1. Find every <p> whose plain text contains the phrase. Record
    //    the (start, end) of each such <p> so we can exclude them from
    //    the raw-HTML pass below.
    const matchingPSpans: Array<[number, number]> = [];
    const spans = findParagraphSpans(html);
    for (const [s, e] of spans) {
      const inner = html.slice(s, e);
      const openClose = inner.match(/<p\b[^>]*>/i);
      const closeOnly = inner.match(/<\/p>/i);
      if (!openClose || !closeOnly) continue;
      const innerStart = s + openClose[0].length;
      const innerEnd = s + closeOnly.index!;
      const plain = htmlToText(html.slice(innerStart, innerEnd));
      if (plain && plain.toLowerCase().includes(phrase.toLowerCase())) {
        matchingPSpans.push([s, e]);
      }
    }

    // 2. Raw-HTML substring matches OUTSIDE the matching <p> spans.
    //    Build a "haystack with matching <p> regions blanked" then
    //    count substring matches in what's left.
    let deDuped = html;
    for (const [s, e] of matchingPSpans) {
      deDuped = deDuped.slice(0, s) + ' '.repeat(e - s) + deDuped.slice(e);
    }
    const rawHits = deDuped.match(new RegExp(escaped, 'gi'))?.length ?? 0;

    return { phrase, hits: matchingPSpans.length + rawHits };
  });
}
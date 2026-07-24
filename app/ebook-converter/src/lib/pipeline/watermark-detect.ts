// src/lib/pipeline/watermark-detect.ts
//
// Single source of truth for "which phrases look like watermarks in this
// chunk of chapter HTML?". Two entry points:
//
//   detectFromChaptersHtml(chapters)
//     Tag-aware frequency scan over an array of full chapter HTML strings.
//     Used by the conversion pipeline at upload time.
//
//   detectFromChapterHtml(rawHtml)
//     Per-chapter splitter that returns phrase candidates for ONE chapter.
//     Used by /api/library/[id]/watermarks (the manual Detect button).
//
// Both rely on the same tag-aware splitting: close-of block-level tags
// (`</p>`, `</h*>`, `</div>`, `</li>`, `</blockquote>`, `</pre>`, `</tr>`)
// or `<br/>` or a hard newline act as separators, so a `<div class="header">
// book title </div>` line is treated as its own phrase. The previous
// version of this logic lived inline in conversion-pipeline.ts and only
// ran at upload time, which meant the per-book Detect UI was running a
// completely different (and worse) punctuation-splitter — making it look
// broken for any DTV-style book. Now both paths share the same engine.
//
// 2026-07-12 — PRECISION FIXES
//   * Drop the hardcoded "Chiếm Đoạt | Tiểu Ngôn | dtv-ebook" whitelist
//     from the previous implementation. It worked for one specific book
//     and silently dropped every other publisher's metadata footer.
//   * Instead, skip ONLY true `<h*>` heading lines (e.g. <h4>Chương N</h4>)
//     whose inside text starts with "Chương N". We do this by checking the
//     original block tag, not by string-matching the book title — so a
//     `<div class="header">Hoàng Tộc Tổ Địa Bật Hack 20 Năm…</div>` is no
//     longer filtered just because the author chose a long title.
//   * Lower default frequency threshold to 0.4 (was 0.6). At 0.6, watermarks
//     that appear on every chapter EXCEPT a few side-content chapters
//     (e.g. an "Author's note" chapter) were missed. 0.4 still catches the
//     watermark while keeping noise floor low for normal repeating phrases
//     like character names (those never appear verbatim in 40% of paragraphs
//     after tag stripping).
//   * Add length bounds check (4..200 chars) and a "looks like prose"
//     dedupe pass so we don't return identical 1-sentence fragments that
//     matched by accident.

export interface WatermarkDetectOptions {
  /** Minimum share of chapters the phrase must appear in (0..1). Default 0.4. */
  threshold?: number;
  /** Override the minimum absolute chapter count. Default 2. */
  minChapters?: number;
}

const BLOCK_END_RE = /<\/(?:p|h[1-6]|div|li|blockquote|pre|tr)>|<\s*br\s*\/?\s*>|\r?\n/i;
const HEADING_END_RE = /^<\s*h[1-6]\b/i;

/** Plain-text length of an HTML fragment after stripping tags + entities. */
export function htmlFragmentToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
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

/** Pull the leading block-level tag out of an HTML fragment (matches the
 *  same set we use as separators), or null if there's none. We use this to
 *  tell `<div>...</div>` from `<h4>...</h4>` without having to re-parse.
 *
 *  We also peek through wrapper tags that aren't in our split set —
 *  `<section>`, `<article>`, `<main>` etc. — because the converter wraps
 *  every chapter in a `<section>` and we still want to know whether the
 *  first BLOCK element inside is a heading. */
function leadingBlockTag(fragment: string): string | null {
  const trimmed = fragment.trimStart();
  // Up to two wrapper hops before the real content tag. Keeps this
  // bounded so a deeply-nested fragment doesn't cause runaway matching.
  let cursor = 0;
  for (let hops = 0; hops < 4; hops++) {
    const rest = trimmed.slice(cursor);
    const m = rest.match(/^<\s*(p|h[1-6]|div|li|blockquote|pre|tr|br)\b/i);
    if (m) return m[1].toLowerCase();
    const wrapper = rest.match(/^<\/?\s*(section|article|main|aside|nav|header|footer|figure|figcaption|details|summary)\b[^>]*>/i);
    if (!wrapper) return null;
    cursor += wrapper[0].length;
  }
  return null;
}

/** Per-chapter candidate splitter. Given a single chapter's HTML, return
 *  the set of "phrase candidates" — short, block-level text fragments
 *  that could be either chapter heading, watermark header, or chapter
 *  body. Filtering for *frequency* is the caller's job.
 *
 *  This is intentionally conservative: it never returns anything it isn't
 *  confident is a single block-level unit. Whitespace between blocks is
 *  collapsed so `<div>X</div>   <div>Y</div>` produces two distinct phrases. */
export function splitChapterIntoPhrases(rawHtml: string): string[] {
  // Pull only the body so we don't pick up <style>/<script> blocks.
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : rawHtml;

  // Strip embedded <style>/<script> defensively (Calibre-style EPUBs often
  // put CSS rules inline; we don't want those rule strings to pollute the
  // candidate set).
  const clean = body
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');

  const blocks = clean.split(BLOCK_END_RE);
  const out: string[] = [];
  for (const block of blocks) {
    const tag = leadingBlockTag(block);
    const text = htmlFragmentToText(block);
    if (!text || text.length < 4 || text.length > 200) continue;
    // Skip pure heading lines (e.g. "<h4>Chương 5</h4>" or
    // "<h1>Chương 5: Trở về</h1>"). We DO want to keep them when the
    // heading contains the *whole* chapter title repeated — i.e. most
    // novels — so we only filter headings whose textual content STARTS
    // with the literal "Chương N" prefix. Other repeated headings such as
    // a recurring "Giới thiệu tác giả" line stay in the candidate set
    // and surface for the user to decide.
    if (tag && /^h[1-6]$/.test(tag) && /^Chương\s+\d+/i.test(text)) {
      continue;
    }
    out.push(text);
  }
  // Dedupe within a single chapter so each chapter contributes at most 1
  // count toward any given phrase.
  return Array.from(new Set(out));
}

/** Frequency-scanner across all chapters. Returns phrases that appear in
 *  at least `threshold` fraction of chapters (default 40%), sorted by
 *  descending chapter count so the most common watermarks float to the
 *  top of the UI list.
 *
 *  Phrases are returned with their plain text content (already
 *  tag-stripped + entity-decoded) so the strip pass can use them as
 *  literal substrings without having to re-escape. */
export function detectFromChaptersHtml(
  chapters: { html: string }[],
  opts: WatermarkDetectOptions = {},
): string[] {
  const total = chapters.length;
  if (total < 2) return [];

  const threshold = opts.threshold ?? 0.4;
  const minChapters = Math.max(2, Math.floor(opts.minChapters ?? 2));

  const required = Math.max(
    minChapters,
    Math.ceil(total * threshold),
  );

  const counts = new Map<string, number>();
  for (const ch of chapters) {
    const phrases = splitChapterIntoPhrases(ch.html);
    for (const phrase of phrases) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  const out: { phrase: string; count: number }[] = [];
  for (const [phrase, count] of counts) {
    if (count >= required) {
      out.push({ phrase, count });
    }
  }
  // Stable order: most common first, ties broken by phrase length desc
  // (longer phrases are usually more specific / fewer false positives).
  out.sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length);
  return out.map((x) => x.phrase);
}

/** Same as `detectFromChaptersHtml` but for a single chapter — the API
 *  layer's per-book Detect endpoint can split each chapter, collect
 *  candidate phrases, then run AI confirmation on the de-duped set. */
export function detectFromChapterHtml(
  rawHtml: string,
  totalChapters = 1,
): string[] {
  return Array.from(new Set(splitChapterIntoPhrases(rawHtml)));
}

// src/lib/ai/emoji-stripper.ts
//
// Defense-in-depth against emoji / emoticon pollution from AI-enhanced
// chapter text. The system prompts in chapter-formatter.ts and
// chapter-enhancer.ts explicitly forbid inserting emoji, but smaller local
// models occasionally slip one in. We post-process the output to remove any
// emoji-range codepoint that wasn't present in the original source — that way
// legitimate emoji already in the EPUB (rare but possible) are preserved.
//
// What we strip:
//   • Unicode emoji & supplemental symbols (U+1F000–U+1FFFF)
//   • Misc Symbols / Dingbats (U+2600–U+27BF)
//   • Variation selectors (U+FE0F) and ZWJ joiners (U+200D) used to compose
//     multi-codepoint emoji sequences
//   • Common ASCII emoticons (":)", ":D", "=)", "^^", ";)", ":(" …) that the
//     AI sometimes sprinkles between paragraphs
//
// What we KEEP:
//   • Vietnamese diacritics, em-dash (U+2014), ellipsis (U+2026), quotation
//     marks, parentheses — none of these are in the stripped ranges
//   • Any emoji-range codepoint that was already in the original source —
//     we never remove content that the author's text already contained

// Unicode ranges that contain emoji-like glyphs. Variation selectors
// (U+FE0F) and ZWJ (U+200D) join multiple codepoints into a single emoji.
const EMOJI_RANGES: RegExp =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

// ASCII-style emoticons. Each pattern is anchored so we only match the
// standalone form, not legitimate prose like "URL:)" or "T-shirt:(".
// We strip them and the surrounding single space (if any), then collapse
// any double-space that results.
const ASCII_EMOTICON_PATTERNS: RegExp[] = [
  / :(?:\)|D|P|\() /g,
  / =\) /g,
  / \^\^ /g,
  / ;-?\) /g,
  / T_T /g,
  / TT /g,
];

/** Strip emoji / emoticons introduced by the AI that weren't in the source.
 *  Order: strip ASCII emoticons first (replace with single space), then
 *  strip emoji-range codepoints that are absent from the source. */
export function stripIntroducedEmoji(source: string, output: string): string {
  // Build a set of codepoints present in the source — anything else in the
  // emoji ranges is treated as introduced-by-AI and removed.
  const sourceCodepoints = new Set<number>();
  for (const ch of source) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) sourceCodepoints.add(cp);
  }

  let cleaned = output;

  // 1. ASCII emoticons — replace with a single space, then collapse runs.
  for (const re of ASCII_EMOTICON_PATTERNS) {
    cleaned = cleaned.replace(re, ' ');
  }
  cleaned = cleaned.replace(/ {2,}/g, ' ');

  // 2. Unicode emoji ranges — strip codepoints not in source.
  cleaned = cleaned.replace(EMOJI_RANGES, (m) => {
    const cp = m.codePointAt(0);
    return cp !== undefined && sourceCodepoints.has(cp) ? m : '';
  });

  return cleaned;
}
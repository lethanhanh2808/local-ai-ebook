// src/lib/tts/text-sanitizer.ts
//
// Strip decorative ornaments from text before sending to TTS.
//
// The reader's HTML often contains visual-only runs that look clean on the
// page but confuse the TTS voice — at best the model goes silent, at worst
// it reads glyph names like "em dash star em dash" (jarring). Examples
// encountered in Vietnamese light-novel epubs:
//
//   <p>—★—</p>                       chapter divider
//   <p>❀ ❀ ❀</p>                     ornament cluster (whitespace-padded)
//   <p>*** Chương 5 ***</p>          framed chapter title
//   <p>── Tiết 2 ──</p>              framed section title
//   <p>──────────────────────</p>    horizontal rule
//   <p>❉ ❉ ❉</p>                    ornament row
//
// Two helpers:
//   • cleanTextForTTS(text): remove decorative runs inline
//     so e.g. "Trước —★— rồi" → "Trước rồi". Use every time you
//     embed a paragraph into the /api/tts body.
//   • isDecorativeOnly(text): true if no readable letter or digit
//     remains after cleaning (so `—★—` returns true; `Chương 5`
//     returns false). Used to skip the network call entirely.
//
// Rules are conservative: legitimate Vietnamese text containing
// quotes, ellipses, single asterisks, in-word dashes is preserved.
//
// Implementation notes:
//   1. Ornaments are matched via Set.has() rather than a regex
//      character class — unicode regex char classes can accidentally
//      form codepoint ranges from adjacent characters (e.g. `–—` =
//      "en-dash to em-dash" range, absorbing anything between), which
//      is unsound. Set membership is safe across all unicode planes.
//   2. Whitespace BETWEEN ornaments extends a decorative cluster, but
//      whitespace between an ornament and prose terminates it. This
//      catches patterns like `❀ ❀ ❀` while leaving prose spacing
//      like `— thân —` alone for the leading/trailing-ornament pass.

const ORNAMENTS: ReadonlySet<string> = new Set<string>([
  // Dashes / horizontal rules
  '-', '–', '—', '─', '━', '┄', '┈',
  // Math-y rule chars
  '_', '=',
  // Bullets & dots
  '~', '·', '•',
  '●', '○', '◯', '◎', '◦', '°',
  // Stars (4-point + sparkles)
  '★', '☆', '✦', '✧', '✩', '✪', '✫', '✬', '✭', '✮', '✯', '✨', '❂',
  // Stars (6-point)
  '✱', '✲', '✳', '✴', '✵', '✶', '✷', '✸', '✹', '✺', '✻',
  // Floral / sparkle dingbats
  '✼', '✽', '✾', '✿', '❀', '❁', '❃',
  // Snow / ornament dingbats
  '❄', '❅', '❆', '❇', '❈', '❉', '❊', '❋', '❍', '❖',
  // Cards / hearts
  '♥', '♡', '♦', '♣', '♠', '❤', '❥', '❦', '❧',
  // Arrow tips
  '➤', '➜', '➔', '➝', '➞', '➟', '↠', '⤍', '⤏',
  // ASCII asterisks (single * inside text is preserved; runs of 3+ are stripped)
  '*',
]);

const isOrnament = (ch: string): boolean => ORNAMENTS.has(ch);
const isWhitespace = (ch: string): boolean => /\s/.test(ch);

// Any letter or digit codepoint (any script) — used by isDecorativeOnly.
const READABLE_RE = /\p{L}|\p{N}/u;

/**
 * Strip runs of ≥3 ornament characters (including whitespace-padded
 * ornament clusters) and any leading/trailing ornaments. Whitespace
 * is collapsed AFTER stripping so a sentence like
 * `"Trước —★— rồi"` becomes `"Trước rồi"` (not `"Trướcrồi"`).
 */
export function cleanTextForTTS(input: string | null | undefined): string {
  if (!input) return '';

  // Pass 1 — drop ornament clusters (maximal substrings where every
  // char is either an ornament or whitespace, starting AND ending with
  // an ornament, and containing ≥3 ornament chars).
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (!isOrnament(input[i])) {
      out += input[i];
      i++;
      continue;
    }
    // Found an ornament — extend the cluster as long as the chars are
    // ornaments or whitespace that bridges ornaments.
    let j = i + 1;
    while (j < input.length) {
      if (isOrnament(input[j])) {
        j++;
      } else if (isWhitespace(input[j])) {
        // Look ahead past any whitespace to decide if it's bridging.
        let k = j + 1;
        while (k < input.length && isWhitespace(input[k])) k++;
        if (k < input.length && isOrnament(input[k])) {
          // Whitespace bridges two ornaments → keep it in the cluster.
          j = k;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    // Trim at most one trailing whitespace from the cluster so we don't
    // eat prose spacing (e.g., `*** Chương 5` → trim only the space
    // before `Chương` — but we trimmed it already; the remaining
    // cluster `***` is what we want to drop).
    let clusterEnd = j;
    if (clusterEnd > i && isWhitespace(input[clusterEnd - 1]) &&
        clusterEnd >= 2 && isOrnament(input[clusterEnd - 2])) {
      clusterEnd--;
    }
    // Count ornaments and strip if ≥3.
    let ornCount = 0;
    for (let k = i; k < clusterEnd; k++) {
      if (isOrnament(input[k])) ornCount++;
    }
    if (ornCount >= 3) {
      // drop the cluster
    } else {
      out += input.slice(i, clusterEnd);
    }
    // Emit any whitespace / text we skipped past so it isn't lost.
    if (clusterEnd < j) out += input.slice(clusterEnd, j);
    i = j;
  }

  // Pass 2 — strip leading/trailing ornaments of any length.
  let start = 0, end = out.length;
  while (start < end && isOrnament(out[start])) start++;
  while (end > start && isOrnament(out[end - 1])) end--;
  out = out.slice(start, end);

  // Pass 3 — collapse whitespace gaps left by removal.
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*\n\s*\n+/g, '\n\n')
    .trim();
  return out;
}

/**
 * `true` if cleaning leaves nothing readable — i.e. the paragraph is
 * purely decorative and should be skipped at the TTS layer.
 */
export function isDecorativeOnly(text: string | null | undefined): boolean {
  const cleaned = cleanTextForTTS(text);
  if (cleaned.length === 0) return true;
  for (const ch of cleaned) {
    if (READABLE_RE.test(ch)) return false;
  }
  return true;
}

// ── Silent WAV placeholder ─────────────────────────────────────────────
// Used by prefetchParagraph when it short-circuits for a decorative-only
// paragraph. The blob is cached at module load — every decorative-only
// paragraph shares the same ~640-byte file. Generated programmatically
// instead of inlining as base64 so we don't bloat the bundle.
//
// 0.1 s of silence at 16 kHz mono 16-bit PCM. Tiny enough to decode in
// microseconds; long enough that audio.ended reliably fires before any
// race with the .play() resolution path.
export const SILENT_WAV_BLOB: Blob = (() => {
  const SECONDS = 0.1;
  const SAMPLE_RATE = 16000;
  const samples = Math.floor(SECONDS * SAMPLE_RATE);
  const dataSize = samples * 2; // 16-bit mono → 2 bytes/sample
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  // RIFF header
  view.setUint32(0, 0x52494646, false);          // 'RIFF'
  view.setUint32(4, 36 + dataSize, true);        // file size − 8
  view.setUint32(8, 0x57415645, false);          // 'WAVE'
  // fmt sub-chunk (16 bytes)
  view.setUint32(12, 0x666d7420, false);         // 'fmt '
  view.setUint32(16, 16, true);                  // subchunk size
  view.setUint16(20, 1, true);                   // PCM (uncompressed)
  view.setUint16(22, 1, true);                   // channels = 1
  view.setUint32(24, SAMPLE_RATE, true);         // sample rate
  view.setUint32(28, SAMPLE_RATE * 2, true);     // byte rate
  view.setUint16(32, 2, true);                   // block align
  view.setUint16(34, 16, true);                  // bits per sample
  // data sub-chunk
  view.setUint32(36, 0x64617461, false);         // 'data'
  view.setUint32(40, dataSize, true);
  // Body already zero (silence)
  return new Blob([buffer], { type: 'audio/wav' });
})();

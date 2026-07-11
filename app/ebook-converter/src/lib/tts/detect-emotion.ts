// src/lib/tts/detect-emotion.ts
//
// Heuristic Vietnamese emotion/sentiment → TTS parameter mapper for the
// read-aloud pipeline. Pure function (no React, no closures) so it can be
// unit-tested in isolation and shared between the live reader and any
// future pre-generation worker.
//
// Resolution rule: each branch contributes a candidate. We pick the one
// whose match is furthest into the text — "last match wins" gives the
// closing beat more weight, matching how listeners remember paragraph
// mood. Ties are broken by branch order (action > angry > sad > romantic
// > tense > calm) so paragraphs where two branches match at the same
// offset keep legacy priority — no regression on existing behaviour.
//
// `intensity` ∈ [0, 1]. At 1.0 we emit the full-strength delta (label
// still returned so the UI chip is visible). At 0.0 the speed/noise
// come back unchanged from base — only the label flips on. Linear
// interpolation: speed_out = base + (target - base) * intensity.
//
// Some branches fall back on punctuation density (angry = many "!").
// We synthesise a position from the LAST occurrence of that punctuation
// when the threshold is met.
//
// NOTE (2026-07-11): the "tense = many … or ..." density fallback was
// removed — ellipsis (`...` or `…`) is read by VieNeu as a natural
// short pause already, and using it as an emotion trigger made every
// trailing-thought paragraph sound "căng thẳng". `lastEllipsis` is
// kept here only as a no-op so dependent callers (and the test cases)
// don't need to change; the tense branch below no longer consults it.
//
// 💕 Romantic / tender: "nụ cười" / "mỉm cười" (a smile / gentle smile)
// are intentionally OMITTED — they appear in narration all the time
// ("cô ấy có một nụ cười dịu dàng") without any romance implication.
// Including them used to mark every paragraph containing a smile as
// "lãng mạn" → "[cười]" marker injected into nearly every sentence.

export interface EmotionResult {
  label: string;
  emoji: string;
  /** Sentiment token used by the TTS server (excited, angry, sad, romantic, tense, calm, neutral). */
  emotion: 'excited' | 'angry' | 'sad' | 'romantic' | 'tense' | 'calm' | 'neutral';
  /** Final speed to send to /api/tts. Always ∈ [0.5, 2.5]. */
  speed: number;
  /** Final expressiveness (noise_scale). Always ∈ [0.25, 0.95]. */
  noiseScale: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Position (in chars from start of `t`) of the LAST match for the given
 * global regex, or -1 if it doesn't match. Used to decide which branch
 * "wins" — see branches[] below.
 *
 * Word-boundary check: a match is only counted when the character before
 * AND after the match is either absent (string edge) or NOT a letter
 * (`\p{L}` or `\p{M}` — covers Vietnamese letters with diacritics).
 * Without this, plain-substring matches false-positive: e.g. "không"
 * contains "hôn" (the romantic kiss keyword), "phòng" too, etc. JS's
 * built-in `\b` is ASCII-only, so we can't use it for Vietnamese.
 */
function lastIdxOf(t: string, re: RegExp): number {
  let last = -1;
  for (const m of t.matchAll(re)) {
    const idx  = m.index ?? -1;
    if (idx < 0) continue;
    const end  = idx + m[0].length;
    const prev = idx > 0          ? t[idx - 1] : '';
    const next = end < t.length   ? t[end]     : '';
    // Letter predicate — \p{L} and \p{M} together cover both base letters
    // and combining marks (diacritics) from any script, including Latin +
    // Vietnamese extensions. We need /u for Unicode property escapes.
    const isLetter = (c: string) => /[\p{L}\p{M}]/u.test(c);
    if ((prev === '' || !isLetter(prev)) && (next === '' || !isLetter(next))) {
      last = idx;
    }
  }
  return last;
}

interface Branch {
  label: string;
  emoji: string;
  emotion: EmotionResult['emotion'];
  speedMul: number;
  noiseDelta: number;
  pos: number;
}

export function detectEmotion(
  text: string,
  baseSpeed: number,
  baseNoise: number,
  intensity: number = 1.0,
): EmotionResult {
  const t = text.toLowerCase();
  const exclaims  = (text.match(/!/g) ?? []).length;
  const lerp = (base: number, target: number) => base + (target - base) * intensity;

  const lastExclaim   = exclaims >= 3 ? text.lastIndexOf('!')    : -1;
  // BUGFIX (2026-07-11): ellipsis used to inflate the "tense" branch via
  // lastEllipsis — see the long comment at the top of this file. The
  // tense branch below now keys off its keyword list only; the value
  // here stays a no-op so any consumer reading tts-emotion traces is
  // not surprised by a missing identifier.
  const lastEllipsis = -1;

  const branches: Branch[] = [
    { label: 'hành động', emoji: '⚡', emotion: 'excited', speedMul: 1.22, noiseDelta: +0.26,
      pos: lastIdxOf(t, /kiếm|đao|thương|chiến|tấn công|bùng nổ|cuộn trào|huyết mạch|linh lực|chân khí|đánh|giết|chém|đâm|phá cảnh|huyết chiến|giao chiến|công kích|đại chiến|hủy diệt/g) },
    { label: 'tức giận',   emoji: '😤', emotion: 'angry',   speedMul: 1.18, noiseDelta: +0.22,
      // B2 fix (2026-07-08): punctuation boost is allowed only when no
      // non-punctuation branch matched (see the demotion block below).
      // The pos keeps the angry-keyword position if found, else falls
      // back to the last "!" position so that ≥3 "!" alone still
      // produces tức giận for the punctuation-density fallback test.
      pos: (() => {
        const kwPos = lastIdxOf(t, /phản bội|căm hận|thù hận|tức giận|giận dữ|phẫn nộ|không tha thứ|kẻ thù|nghịch nhân|hét lên|gầm lên|thét/g);
        if (kwPos >= 0) return Math.max(kwPos, lastExclaim);
        return lastExclaim;  // pure-punctuation fallback path
      })() },
    { label: 'buồn',       emoji: '💧', emotion: 'sad',     speedMul: 0.80, noiseDelta: -0.25,
      pos: lastIdxOf(t, /nước mắt|khóc|rơi lệ|sầu|buồn|thất vọng|đau lòng|mất đi|ra đi|không trở về|vĩnh biệt|cô đơn|cô quạnh|tiếc nuối|hối hận/g) },
    { label: 'lãng mạn',   emoji: '💕', emotion: 'romantic',speedMul: 0.88, noiseDelta: -0.12,
      pos: lastIdxOf(t, /tim đập|yêu nhau|ngại ngùng|e thẹn|má đỏ|ôm lấy|vòng tay|ánh mắt ấm|nhìn nhau|yêu thương|đôi ta|nắm tay|hôn|hôn nhau|trao nhau|nụ hôn/g) },
    { label: 'căng thẳng', emoji: '😰', emotion: 'tense',   speedMul: 1.07, noiseDelta: +0.10,
      // BUGFIX (2026-07-11): ellipsis density is no longer a fallback
      // — see the top-of-file comment. The tense branch now only
      // matches against explicit tense keywords ("nguy hiểm",
      // "căng thẳng", "rùng mình", etc.). Trailing "..." in prose now
      // reads as a natural pause instead of forcing the voice into
      // "căng thẳng".
      pos: lastIdxOf(t, /nguy hiểm|căng thẳng|hồi hộp|bóng tối|im lặng đột|tiến lại|vây quanh|rùng mình|phục kích|kẻ địch xuất/g) },
    { label: 'bình yên',   emoji: '🍃', emotion: 'calm',    speedMul: 0.90, noiseDelta: -0.18,
      pos: lastIdxOf(t, /yên tĩnh|bình yên|thanh thản|nhẹ nhàng|thư thái|gió thổi nhẹ|ánh trăng|bình thản|thong thả|an bình/g) },
  ];

  let best = -1;
  let bestIdx = -1;
  // B2 fix (2026-07-08): if any NON-punctuation branch (action / sad /
  // romantic / calm) matched a keyword, fully demote angry to -1.
  // Punctuation-only "angry" fallback (many "!!!") still fires when
  // nothing else matched, but it loses to any real keyword hit
  // ("Cô chạy nhanh lắm!!! ..." → action wins on "chạy", NOT angry
  // on the trailing "!!! ").
  //
  // BUGFIX (2026-07-11): tense is no longer in the punctuation-fallback
  // set — see the top-of-file comment. It still gets demoted here
  // because its position is always a keyword position now (so this is
  // effectively a no-op for tense, but kept for symmetry in case a
  // future branch adds a punctuation fallback).
  const anyKeywordMatched = branches.some(
    (b, i) => b.pos >= 0 && i !== 1,  // angry demotion only now
  );
  if (anyKeywordMatched) {
    branches[1].pos = -1;  // angry demoted
  }
  for (let i = 0; i < branches.length; i++) {
    if (branches[i].pos > bestIdx) {
      bestIdx = branches[i].pos;
      best = i;
    }
  }

  let label = '';
  let emoji = '';
  let emotionName: EmotionResult['emotion'] = 'neutral';
  let targetSpeed = baseSpeed;
  let targetNoise = baseNoise;
  if (best >= 0) {
    const b = branches[best];
    label = b.label;
    emoji = b.emoji;
    emotionName = b.emotion;
    targetSpeed = clamp(baseSpeed * b.speedMul, 0.5, 2.5);
    targetNoise = clamp(baseNoise + b.noiseDelta, 0.25, 0.95);
  }

  return {
    label,
    emoji,
    emotion: emotionName,
    speed: clamp(lerp(baseSpeed, targetSpeed), 0.5, 2.5),
    noiseScale: clamp(lerp(baseNoise, targetNoise), 0.25, 0.95),
  };
}

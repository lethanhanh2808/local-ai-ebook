import { describe, expect, it } from 'vitest';
import { detectEmotion } from '@/lib/tts/detect-emotion';

// Tests for the heuristic Vietnamese emotion → TTS parameter mapper used
// by the read-aloud pipeline.
//
// Resolution rule under test: when multiple branches match a paragraph,
// the branch whose keyword appears LAST in the text wins ("closing beat"
// wins). Ties broken by branch order (action > angry > sad > romantic >
// tense > calm). Empty/no-match text returns the neutral fallback with
// base speed + base noise preserved.
//
// Speed/noise targets (full-strength, intensity=1):
//   action    : ×1.22 speed, +0.26 noise
//   angry     : ×1.18 speed, +0.22 noise
//   sad       : ×0.80 speed, -0.25 noise
//   romantic  : ×0.88 speed, -0.12 noise
//   tense     : ×1.07 speed, +0.10 noise
//   calm      : ×0.90 speed, -0.18 noise
//
// Intensity ∈ [0,1] lerps base → target linearly. At 0, label still flips
// but speed/noise equal base. At 1, full strength.

const BASE_SPEED = 1.0;
const BASE_NOISE = 0.667;
const EPS = 1e-9;

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Helper — call detectEmotion at full intensity so the targets below are
 * applied verbatim. */
const full = (text: string) => detectEmotion(text, BASE_SPEED, BASE_NOISE, 1.0);

describe('detectEmotion — single-emotion paragraphs', () => {
  it('classifies clear action prose as hành động', () => {
    const r = full('Hắn rút kiếm chém xuống.');
    expect(r.label).toBe('hành động');
    expect(r.emoji).toBe('⚡');
    expect(r.emotion).toBe('excited');
  });

  it('classifies clear calm prose as bình yên', () => {
    expect(full('Gió nhẹ thổi qua, đêm yên tĩnh.').label).toBe('bình yên');
    expect(full('Gió nhẹ thổi qua, đêm yên tĩnh.').emotion).toBe('calm');
  });

  it('classifies clear sad prose as buồn', () => {
    expect(full('Nàng bật khóc, nước mắt rơi xuống.').label).toBe('buồn');
    expect(full('Nàng bật khóc, nước mắt rơi xuống.').emotion).toBe('sad');
  });
});

describe('detectEmotion — last-match-wins resolution', () => {
  it('opener calm + closer action → hành động (closing dominates)', () => {
    const r = full('Đêm yên tĩnh lắm. Rồi bỗng nhiên kiếm va nhau chói lóa!');
    expect(r.label).toBe('hành động');
  });

  it('opener action + closer sad → buồn (closing note lingers)', () => {
    const r = full('Hắn phóng kiếm đến, huyết tươi bắn tung tóe. Rồi hắn đứng lặng, nước mắt rơi.');
    expect(r.label).toBe('buồn');
  });

  it('opener calm + closer romantic → lãng mạn', () => {
    const r = full('Đêm bình yên, gió thổi nhẹ. Họ nhìn nhau, nắm tay nhau rồi hôn nhau.');
    expect(r.label).toBe('lãng mạn');
  });

  it('opener calm + closer romantic (lower case) → lãng mạn', () => {
    expect(full('đêm yên tĩnh rồi cùng nhau nắm tay').label).toBe('lãng mạn');
  });

  it('"kiếm đánh rồi buồn lắm" — closing sad beats earlier action', () => {
    // This is the canonical regression test for the last-wins refactor.
    // Legacy "first match wins" returned hành động; current last-wins
    // resolves the closing beat (buồn) which is what listeners remember.
    expect(full('kiếm đánh rồi buồn lắm.').label).toBe('buồn');
  });
});

describe('detectEmotion — punctuation density fallbacks', () => {
  it('three or more "!" → tức giận regardless of keyword presence', () => {
    const r = full('Hắn hét lên! Hắn gầm lên! Hắn thét lên!');
    expect(r.label).toBe('tức giận');
    expect(r.emotion).toBe('angry');
  });

  it('two or more "…" → căng thẳng', () => {
    expect(full('Anh ta lặng lẽ… rồi bước đi… không ai biết điều gì sắp xảy ra…').label).toBe('căng thẳng');
  });

  it('mixed "..." and "…" both count', () => {
    expect(full('Chờ đợi... rồi lại chờ đợi…').label).toBe('căng thẳng');
  });

  it('fewer than 3 "!" with sad words → sad (not angry)', () => {
    expect(full('Một giọt nước mắt lặng lẽ rơi! Không ai biết.').label).toBe('buồn');
  });
});

describe('detectEmotion — neutral fallback', () => {
  it('returns empty label + neutral for empty text', () => {
    const r = full('');
    expect(r.label).toBe('');
    expect(r.emoji).toBe('');
    expect(r.emotion).toBe('neutral');
    expect(r.speed).toBe(BASE_SPEED);
    expect(r.noiseScale).toBe(BASE_NOISE);
  });

  it('returns empty label + neutral for text with no keyword hits', () => {
    const r = full('Đây là một câu bình thường không có từ khóa cảm xúc nào.');
    expect(r.label).toBe('');
    expect(r.emotion).toBe('neutral');
    expect(round(r.speed)).toBe(round(BASE_SPEED));
    expect(round(r.noiseScale)).toBe(round(BASE_NOISE));
  });

  it('returns base values for no-match when base ≠ 1.0', () => {
    const r = detectEmotion('Xin chào, hôm nay thế nào?', 1.2, 0.5, 1.0);
    expect(r.emotion).toBe('neutral');
    expect(r.speed).toBe(1.2);
    expect(round(r.noiseScale)).toBe(round(0.5));
  });
});

describe('detectEmotion — numeric deltas at full intensity', () => {
  it('action target: ×1.22 speed, base+0.26 noise', () => {
    const r = full('Thanh kiếm va chạm, đao pháp tung hoành.');
    expect(round(r.speed)).toBe(round(BASE_SPEED * 1.22));
    expect(round(r.noiseScale)).toBe(round(BASE_NOISE + 0.26));
  });

  it('sad target: ×0.80 speed, base-0.25 noise (clamped ≥0.25)', () => {
    const r = full('Nước mắt rơi xuống lặng lẽ, hối hận tràn ngập.');
    expect(round(r.speed)).toBe(round(BASE_SPEED * 0.80));
    // BASE_NOISE (0.667) - 0.25 = 0.417, well above the 0.25 floor.
    expect(round(r.noiseScale)).toBe(round(BASE_NOISE - 0.25));
  });

  it('calm target: ×0.90 speed, base-0.18 noise', () => {
    const r = full('Đêm bình yên, gió thổi nhẹ, trăng sáng vằng vặc.');
    expect(round(r.speed)).toBe(round(BASE_SPEED * 0.90));
    expect(round(r.noiseScale)).toBe(round(BASE_NOISE - 0.18));
  });

  it('angry target: ×1.18 speed, base+0.22 noise', () => {
    const r = full('Hắn gầm lên, mặt đỏ tía, kẻ thù phải run rẩy.');
    expect(round(r.speed)).toBe(round(BASE_SPEED * 1.18));
    expect(round(r.noiseScale)).toBe(round(BASE_NOISE + 0.22));
  });
});

describe('detectEmotion — intensity lerp', () => {
  const ACTION_TEXT = 'Kiếm va nhau, đao chạm nhau, đại chiến bùng nổ.';

  it('intensity=1 returns full target deltas (action)', () => {
    const r = detectEmotion(ACTION_TEXT, BASE_SPEED, BASE_NOISE, 1.0);
    expect(round(r.speed)).toBe(round(BASE_SPEED * 1.22));
    expect(round(r.noiseScale)).toBe(round(BASE_NOISE + 0.26));
  });

  it('intensity=0 returns base values but keeps the label', () => {
    const r = detectEmotion(ACTION_TEXT, BASE_SPEED, BASE_NOISE, 0.0);
    // Label still flips on — UI chip is visible, audio is flat.
    expect(r.label).toBe('hành động');
    expect(r.emoji).toBe('⚡');
    expect(round(r.speed)).toBe(round(BASE_SPEED));
    expect(round(r.noiseScale)).toBe(round(BASE_NOISE));
  });

  it('intensity=0.5 lerps halfway between base and target', () => {
    const r = detectEmotion(ACTION_TEXT, BASE_SPEED, BASE_NOISE, 0.5);
    const expectedSpeed     = BASE_SPEED + (BASE_SPEED * 1.22 - BASE_SPEED) * 0.5;
    const expectedNoise     = BASE_NOISE + (BASE_NOISE + 0.26   - BASE_NOISE) * 0.5;
    expect(round(r.speed)).toBe(round(expectedSpeed));
    expect(round(r.noiseScale)).toBe(round(expectedNoise));
  });

  it('intensity=0 with neutral text still returns base (no delta to lerp)', () => {
    const r = detectEmotion('plain text', BASE_SPEED, BASE_NOISE, 0.0);
    expect(r.emotion).toBe('neutral');
    expect(round(r.speed)).toBe(round(BASE_SPEED));
    expect(round(r.noiseScale)).toBe(round(BASE_NOISE));
  });
});

describe('detectEmotion — clamps', () => {
  it('clamps speed into [0.5, 2.5] even when target would exceed', () => {
    // Manually drive target into the ceiling by using a very high baseSpeed
    // and the action multiplier.
    const r = detectEmotion('Đại chiến bùng nổ.', 2.4, BASE_NOISE, 1.0);
    expect(r.speed).toBeLessThanOrEqual(2.5);
  });

  it('clamps noiseScale into [0.25, 0.95]', () => {
    // Sad branch tries base - 0.25. With baseNoise=0.4 → 0.15 → clamped to 0.25.
    const r = detectEmotion('Cô bật khóc, sầu não, hối hận.', BASE_SPEED, 0.4, 1.0);
    expect(r.noiseScale).toBeGreaterThanOrEqual(0.25);
  });
});

describe('detectEmotion — emoji mapping', () => {
  it('all 6 emotions return matching emoji', () => {
    expect(detectEmotion('Kiếm va nhau đại chiến.',    BASE_SPEED, BASE_NOISE).emoji).toBe('⚡');
    expect(detectEmotion('Hắn gầm lên, kẻ thù run.',   BASE_SPEED, BASE_NOISE).emoji).toBe('😤');
    expect(detectEmotion('Nước mắt rơi lệ buồn.',      BASE_SPEED, BASE_NOISE).emoji).toBe('💧');
    expect(detectEmotion('Họ nhìn nhau, hôn nhau.',     BASE_SPEED, BASE_NOISE).emoji).toBe('💕');
    expect(detectEmotion('Nguy hiểm... căng thẳng...',  BASE_SPEED, BASE_NOISE).emoji).toBe('😰');
    expect(detectEmotion('Đêm yên tĩnh bình yên.',      BASE_SPEED, BASE_NOISE).emoji).toBe('🍃');
  });
});

describe('detectEmotion — Vietnamese word-boundary safety', () => {
  it('"không" does not false-positive as romantic "hôn"', () => {
    // "không" contains the substring "hôn". Without the word-boundary
    // check in lastIdxOf, this paragraph would be labelled lãng mạn.
    const r = detectEmotion('Một giọt nước mắt lặng lẽ rơi! Không ai biết.', BASE_SPEED, BASE_NOISE);
    // sad should win on "nước mắt" / "rơi" (sad) being later in the text
    // than the spurious "hôn" match that no longer fires.
    expect(r.label).toBe('buồn');
  });

  it('"phòng" does not false-positive as romantic "hôn"', () => {
    expect(detectEmotion('Anh ta đứng trong phòng một mình.', BASE_SPEED, BASE_NOISE).emotion).toBe('neutral');
  });

  it('"thông" does not false-positive as romantic "hôn"', () => {
    expect(detectEmotion('Cô thông báo cho mọi người.', BASE_SPEED, BASE_NOISE).emotion).toBe('neutral');
  });

  it('standalone "hôn" still matches as romantic', () => {
    expect(detectEmotion('Cuối cùng họ hôn nhau.', BASE_SPEED, BASE_NOISE).label).toBe('lãng mạn');
  });

  it('"cô đơn" matches sad (multi-word keyword)', () => {
    expect(detectEmotion('Anh ta sống cô đơn nhiều năm.', BASE_SPEED, BASE_NOISE).label).toBe('buồn');
  });
});

describe('detectEmotion — B2 regression: punctuation no longer overrides keyword', () => {
  // B2 fix (2026-07-08): punctuation alone (≥3 "!" or ≥2 "...") used to
  // upgrade a paragraph to angry/tense even without any keyword match.
  // The corrected rule: punctuation is a FALLBACK only — it fires when
  // no other branch (action/sad/romantic/calm) matched a keyword in the
  // paragraph. Once any real keyword wins, the trailing "..."/"!!!" no
  // longer hijacks the label to tense/angry.
  it('"yên tĩnh" + trailing "..." → calm wins (not tense)', () => {
    // Calm's "yên tĩnh" hits at index ~10; the trailing "..." is at the
    // very end. Pre-B2-fix the trailing punctuation gave tense a higher
    // position and stole the label. Now any keyword hit demotes tense
    // back to -1, so calm wins on its own merits.
    const r = full('Anh ngồi yên tĩnh... chờ đợi.');
    expect(r.emotion).toBe('calm');
  });

  it('action keyword + "!!!" → action wins (not angry)', () => {
    const r = full('Cô chém kiếm nhanh lắm!!! Và té xuống đất.');
    // Action's "chém"/"kiếm" wins; the trailing "!!!" no longer promotes
    // angry because a non-punctuation keyword branch already matched.
    // (Pure "!!!" with no other keyword would still fall back to angry —
    // see the punctuation-density test above.)
    expect(r.emotion).not.toBe('angry');
    expect(r.emotion).toBe('excited');
  });

  it('angry keyword + "!!!" together still win as angry', () => {
    const r = full('Hắn gầm lên: phản bội!!!');
    expect(r.label).toBe('tức giận');
    expect(r.emotion).toBe('angry');
  });

  it('tense keyword + "..." together still win as tense', () => {
    const r = full('Bóng tối vây quanh... không ai dám thở.');
    expect(r.label).toBe('căng thẳng');
    expect(r.emotion).toBe('tense');
  });
});

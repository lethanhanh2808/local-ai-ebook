import { describe, expect, it } from 'vitest';
import {
  attributeByConversation,
  isNonSpokenQuotedParagraph,
  sliceParagraphs,
  type CharacterLite,
  type ParagraphRange,
} from '../lib/attribution';

const characters: CharacterLite[] = [
  { name: 'Lan', aliases: [], gender: 'female' },
  { name: 'Minh', aliases: [], gender: 'male' },
  { name: 'Bà nội', aliases: ['bà'], gender: 'female' },
];

function p(texts: string[]): ParagraphRange[] {
  let cursor = 0;
  return texts.map((text, index) => {
    const row = { index, start: cursor, end: cursor + text.length, text };
    cursor += text.length + 1;
    return row;
  });
}

describe('stateful conversation attribution', () => {
  it('slices HTML by reader-visible blocks before falling back to sentences', () => {
    const rows = sliceParagraphs('<h2>Chương 1</h2><p>Lan nói: “Chào.” Minh gật đầu.</p><p>“Ừ.”</p>');
    expect(rows.map((row) => row.text)).toEqual([
      'Chương 1',
      'Lan nói: “Chào.” Minh gật đầu.',
      '“Ừ.”',
    ]);
  });

  it('uses dialogue history to resolve an unattributed alternating turn', () => {
    const paragraphs = p([
      'Lan nói với Minh: “Chào Minh.”',
      '“Chào Lan.”',
    ]);
    const out = attributeByConversation({
      paragraphs,
      characters,
      regexOut: {
        0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
      },
    });

    expect(out[0].speaker).toBe('Lan');
    expect(out[1].speaker).toBe('Minh');
    expect(out[1].source).toBe('conversation');
    expect(out[1].evidence?.some((e) => e.source === 'history')).toBe(true);
  });

  it('blends regex evidence into the stateful conversation fusion', () => {
    const paragraphs = p(['Minh nhìn Lan rồi nói: “Đi thôi.”']);
    const out = attributeByConversation({
      paragraphs,
      characters,
      regexOut: {
        0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
      },
    });

    expect(out[0].speaker).toBe('Lan');
    expect(out[0].confidence).toBeGreaterThan(0.4);
  });

  it('resolves gendered pronouns from current scene participants', () => {
    const paragraphs = p([
      'Lan ngồi xuống cạnh Minh. Lan nói: “Anh đợi lâu chưa?”',
      'Cô mỉm cười, “Mình đi thôi.”',
    ]);
    const out = attributeByConversation({
      paragraphs,
      characters,
      regexOut: {
        0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
      },
    });

    expect(out[1].speaker).toBe('Lan');
    expect(out[1].evidence?.some((e) => e.source === 'pronoun')).toBe(true);
  });

  // Sensitivity regression (2026-07-08): previously, a quote paragraph
  // that mentions NO character name would flip-flop to the other active
  // speaker via the 2-speaker alternation heuristic. This produced
  // wrong attribution for one-sided monologues and pronoun-only turns
  // ("Em yêu anh." → "Anh yêu em." → ...). The fix routes no-name
  // quotes to the strong continuation branch, so the same speaker
  // keeps the floor across consecutive paragraphs.
  it('keeps the previous speaker when a quote has no character name', () => {
    const paragraphs = p([
      'Lan nói với Minh: “Chào Minh.”',
      '“Em yêu anh.”',
      '“Em sẽ không bao giờ quên anh.”',
    ]);
    const out = attributeByConversation({
      paragraphs,
      characters,
      regexOut: {
        0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
      },
    });

    expect(out[0].speaker).toBe('Lan');
    // P[1] and P[2] contain no character names (only pronouns), so the
    // alternation heuristic must NOT flip them to Minh.
    expect(out[1].speaker).toBe('Lan');
    expect(out[2].speaker).toBe('Lan');
  });

  it('keeps silent thoughts on the narrator despite dialogue history', () => {
    const paragraphs = p([
      'Lan nói: “Em sẽ đi.”',
      'Lan nghĩ thầm: “Mình không thể quay lại.”',
    ]);
    const out = attributeByConversation({
      paragraphs,
      characters,
      regexOut: {
        0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
        1: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
      },
    });
    expect(out[0].speaker).toBe('Lan');
    expect(out[1]).toBeUndefined();
  });

  it('distinguishes written quotes from a thought followed by audible speech', () => {
    expect(isNonSpokenQuotedParagraph('Lan đọc bức thư “Hẹn gặp lại.”')).toBe(true);
    expect(isNonSpokenQuotedParagraph('Lan nghĩ một lúc rồi nói: “Đi thôi.”')).toBe(false);
    expect(isNonSpokenQuotedParagraph('“Không được.” Lan nghĩ thầm.')).toBe(true);
  });

  // Phase 3.3 — D9 actor alternation bump parity. The previous JS code
  // applied a flat 0.36 weight to `roles.actor` regardless of scene
  // shape. The bump raises that to 0.48 whenever the previous two
  // turns in `state.dialogueHistory` were spoken by different
  // characters (i.e. the conversation is in detected ping-pong
  // alternation). Behaviour outside alternation is unchanged.
  it('bumps roles.actor to 0.48 inside detected alternation, keeps 0.36 outside', () => {
    // Three paragraphs building the alternation history:
    //   P0: Lan speaks
    //   P1: Minh speaks (alternation kicks in at P2)
    //   P2: implicit actor quote where MINH's name appears — actor
    //       should weight at the bumped 0.48 because alternation is
    //       detected between P0 (Lan) and P1 (Minh).
    const alternating = p([
      'Lan nói: “Em đi rồi.”',
      'Minh nói: “Anh đợi em.”',
      'Minh nhìn cô. “Được.”',
    ]);
    const out = attributeByConversation({
      paragraphs: alternating,
      characters,
      regexOut: {
        0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
        1: { speaker: 'Minh', confidence: 0.55, source: 'regex' },
      },
    });
    // P2 resolves to Minh via the actor timeline branch. Confidence
    // is the actor bucket score clamped — multiple buckets compound
    // on top of the actor weight, so we probe the evidence list
    // directly: a timeline bucket with weight 0.48 MUST be present.
    expect(out[2]?.speaker).toBe('Minh');
    const timelineBump = out[2]?.evidence?.find(
      (e) => e.source === 'timeline' && e.weight >= 0.46 && e.weight <= 0.5,
    );
    expect(timelineBump, 'expected a 0.48 timeline evidence row from the actor bump').toBeDefined();
    expect(timelineBump?.detail).toMatch(/alternating turn — bumped/);

    // Same paragraph shape but with the previous two turns by the
    // same speaker → no alternation → actor stays at base 0.36.
    //
    // With alternation OFF, the actor timeline weight is 0.36 — below
    // the 0.42 default floor by itself — so the actor bucket alone
    // cannot resolve the paragraph against the scene-memory
    // continuation branch (which adds 0.38 to the current speaker).
    // The continuation bucket for Lan clears the floor on its own and
    // wins, so the paragraph resolves to Lan (the previous speaker),
    // not Minh. This is the explicit "bump turned off" signal.
    const noAlternation = p([
      'Lan nói: “Em đi rồi.”',
      'Lan nói: “Anh đợi em.”',
      'Minh nhìn cô. “Được.”',
    ]);
    const flat = attributeByConversation({
      paragraphs: noAlternation,
      characters,
      regexOut: {
        0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
        1: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
      },
    });
    // Without the bump, actor weight (0.36) can't out-score the
    // continuation branch (0.38 to current speaker) → paragraph
    // resolves to the previous speaker (Lan), proving the bump
    // mechanic is conditioned on alternation being detected.
    expect(flat[2]?.speaker).toBe('Lan');
    // No "alternating turn — bumped" detail should appear when the
    // previous two speakers are identical.
    const flatTimeline = flat[2]?.evidence?.filter((e) => e.source === 'timeline') ?? [];
    expect(flatTimeline.some((e) => /alternating turn — bumped/.test(e.detail))).toBe(false);
  });
});

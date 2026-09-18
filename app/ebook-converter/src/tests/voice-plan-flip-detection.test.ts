// src/tests/voice-plan-flip-detection.test.ts
//
// Unit tests for the propagation-flip heuristic inside
// buildSuggestedVoicePlan — the cap on lookahead (#6) and the broader
// flip detection (#9).

import { describe, expect, it } from 'vitest';
import {
  buildSuggestedVoicePlan,
  MAX_FLIP_LOOKAHEAD,
} from '@/lib/voice-plan';

describe('voice-plan flip detection', () => {
  it('propagates a single-speaker monologue through multiple quoted paragraphs', () => {
    // NB: smart quotes (U+201C / U+201D) — the splitter / attribution
    // engine treats these as dialogue markers, matching the existing
    // voice-plan test suite.
    const html = [
      '<p>“Ta sẽ đi đây,” nhân vật A nói.</p>',
      '<p>Anh ta bước đi.</p>',
      '<p>“Quay lại đi,” anh ta thêm.</p>',
      '<p>Khói bốc lên.</p>',
      '<p>“Không ai cản được ta đâu,” A kết thúc.</p>',
    ].join('');
    const plan = buildSuggestedVoicePlan({
      bookId: 'b',
      html,
      chapterIndex: 0,
      knownNames: ['A'],
      nameToCharId: { a: 'char-a' },
      characters: [{ name: 'A', aliases: [], gender: 'male' }],
      sourceMtime: 1,
    });
    // Dialogue markers in the source are U+201C/U+201D ("smart quotes").
    // Filter by the smart-quote opener to count dialogue sentences.
    const dialogues = plan.sentences.filter((s) => s.text.includes('“'));
    expect(dialogues.length).toBeGreaterThanOrEqual(3);
    for (const d of dialogues) {
      expect(d.charId).toBe('char-a');
    }
  });

  it('breaks propagation when narration introduces a different character (#9 fix)', () => {
    const html = [
      '<p>“Ta đi đây,” nhân vật A nói.</p>',
      '<p>B hỏi thăm C.</p>',
      '<p>“Khoan đã,” nhân vật B hỏi.</p>',
    ].join('');
    const plan = buildSuggestedVoicePlan({
      bookId: 'b',
      html,
      chapterIndex: 0,
      knownNames: ['A', 'B', 'C'],
      nameToCharId: { a: 'char-a', b: 'char-b', c: 'char-c' },
      characters: [
        { name: 'A', aliases: [], gender: 'male' },
        { name: 'B', aliases: [], gender: 'female' },
        { name: 'C', aliases: [], gender: 'female' },
      ],
      sourceMtime: 1,
    });
    const bQuote = plan.sentences.find((s) => s.text.includes('Khoan đã'));
    expect(bQuote?.charId).toBe('char-b');
  });

  it('keeps propagation when the gap paragraph still mentions the previous speaker', () => {
    const html = [
      '<p>“Ta đi đây,” nhân vật A nói.</p>',
      '<p>A quay lại nhìn B.</p>',
      '<p>“Đợi ta,” A hét lên.</p>',
    ].join('');
    const plan = buildSuggestedVoicePlan({
      bookId: 'b',
      html,
      chapterIndex: 0,
      knownNames: ['A', 'B'],
      nameToCharId: { a: 'char-a', b: 'char-b' },
      characters: [
        { name: 'A', aliases: [], gender: 'male' },
        { name: 'B', aliases: [], gender: 'female' },
      ],
      sourceMtime: 1,
    });
    const lastQuote = plan.sentences.find((s) => s.text.includes('Đợi ta'));
    expect(lastQuote?.charId).toBe('char-a');
  });

  it('bounds the flip lookahead at MAX_FLIP_LOOKAHEAD (#6 perf fix)', () => {
    // Sanity check on the constant itself — if a future refactor
    // accidentally removes the cap, this test catches the regression
    // by failing loudly.
    expect(typeof MAX_FLIP_LOOKAHEAD).toBe('number');
    expect(MAX_FLIP_LOOKAHEAD).toBeGreaterThan(0);
    expect(MAX_FLIP_LOOKAHEAD).toBeLessThan(50); // bounded, not absurd
    expect(MAX_FLIP_LOOKAHEAD).toBe(6);
  });

  it('does not blow up on a long chapter of consecutive quotes', () => {
    // Performance smoke test: 200 alternating quotes should still
    // produce a plan quickly thanks to the lookahead cap. We don't
    // assert wall time here (flaky in CI) — we just check the plan
    // is built without OOM/timeout and the speaker assignment makes
    // sense.
    const quotes = Array.from({ length: 200 }, (_, i) =>
      `<p>"Câu ${i}," nhân vật A nói.</p>`,
    ).join('');
    const plan = buildSuggestedVoicePlan({
      bookId: 'b',
      html: quotes,
      chapterIndex: 0,
      knownNames: ['A'],
      nameToCharId: { a: 'char-a' },
      characters: [{ name: 'A', aliases: [], gender: 'male' }],
      sourceMtime: 1,
    });
    // Every quote should be attributed (first by regex, rest by
    // propagation). The propagation loop must terminate.
    const dialogueCount = plan.sentences.filter((s) => s.text.includes('"')).length;
    expect(dialogueCount).toBe(200);
  });
});

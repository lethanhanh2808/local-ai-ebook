// src/tests/voice-plan.test.ts
//
// Unit tests for the per-sentence voice-plan helpers in src/lib/voice-plan.ts.
import { describe, expect, it } from 'vitest';
import {
  buildSuggestedVoicePlan,
  deserializePlan,
  serializePlan,
  splitParagraphIntoSentences,
  type VoicePlanSentence,
} from '@/lib/voice-plan';

describe('splitParagraphIntoSentences', () => {
  it('splits on Vietnamese sentence terminators and keeps them attached', () => {
    const out = splitParagraphIntoSentences('Anh ta nói. Cô ấy cười! Sao thế?');
    expect(out).toEqual(['Anh ta nói.', 'Cô ấy cười!', 'Sao thế?']);
  });

  it('keeps a lone dialogue one-liner as its own sentence', () => {
    const out = splitParagraphIntoSentences('Ừ.');
    expect(out).toEqual(['Ừ.']);
  });

  it('does not drop trailing text without a terminator', () => {
    const out = splitParagraphIntoSentences('Câu đầu. Câu cuối không dấu chấm');
    expect(out).toEqual(['Câu đầu.', 'Câu cuối không dấu chấm']);
  });
});

describe('serialize / deserialize round-trip', () => {
  it('preserves sentence fields', () => {
    const sentences: VoicePlanSentence[] = [
      { i: 0, text: 'A.', charId: 'c1', voiceId: 'v1', source: 'character', para: 0 },
      { i: 1, text: 'B.', charId: null, voiceId: null, source: 'narration', para: 0 },
    ];
    const plan = { bookId: 'b', chapterIndex: 3, sentences, sourceMtime: 123 };
    const json = serializePlan(plan);
    const back = deserializePlan('b', 3, json, 123);
    expect(back.sentences).toEqual(sentences);
    expect(back.sourceMtime).toBe(123);
  });
});

describe('buildSuggestedVoicePlan', () => {
  it('marks a quoted sentence attributed to a known character as character source', () => {
    const html = '<p>“Ta đi đây,” Nữ Đế nói. Trời tối rồi.</p>';
    const plan = buildSuggestedVoicePlan({
      bookId: 'b',
      html,
      chapterIndex: 0,
      knownNames: ['Nữ Đế'],
      nameToCharId: { 'nữ đế': 'char-1' },
      characters: [{ name: 'Nữ Đế', aliases: [], gender: 'female' }],
      sourceMtime: 1,
    });
    // The quoted sentence should be suggested as the character; the narration
    // sentence should stay narration.
    const quoted = plan.sentences.find((s) => s.text.includes('Ta đi đây'));
    const narration = plan.sentences.find((s) => s.text.includes('Trời tối'));
    expect(quoted?.charId).toBe('char-1');
    expect(quoted?.source).toBe('character');
    expect(narration?.charId).toBeNull();
    expect(narration?.source).toBe('narration');
  });

  it('keeps narration-only paragraphs as narration even when a character is named', () => {
    const html = '<p>Nữ Đế rất xinh đẹp. Nàng bước đi.</p>';
    const plan = buildSuggestedVoicePlan({
      bookId: 'b',
      html,
      chapterIndex: 0,
      knownNames: ['Nữ Đế'],
      nameToCharId: { 'nữ đế': 'char-1' },
      characters: [{ name: 'Nữ Đế', aliases: [], gender: 'female' }],
      sourceMtime: 1,
    });
    // No quotes → no dialogue → everything is narration (mentioning a character
    // must NOT trigger that character's voice).
    expect(plan.sentences.every((s) => s.source === 'narration')).toBe(true);
  });
});

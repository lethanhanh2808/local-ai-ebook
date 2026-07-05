import { describe, expect, it } from 'vitest';
import {
  attributeByConversation,
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

  it('fuses parser confidence above conflicting regex evidence', () => {
    const paragraphs = p(['Minh nhìn Lan rồi nói: “Đi thôi.”']);
    const out = attributeByConversation({
      paragraphs,
      characters,
      parserOut: {
        0: { speaker: 'Minh', confidence: 0.9, source: 'parser' },
      },
      regexOut: {
        0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
      },
    });

    expect(out[0].speaker).toBe('Minh');
    expect(out[0].confidence).toBeGreaterThan(0.7);
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
});

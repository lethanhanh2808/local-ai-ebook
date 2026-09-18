// src/tests/is-likely-english-prompt.test.ts
//
// Unit tests for the prompt-language gate that decides whether an LLM-emitted
// scene description is safe to forward to the image generator. Pure helper.

import { describe, expect, it } from 'vitest';
import { isLikelyEnglishPrompt } from '@/lib/ai/image-generator';

describe('isLikelyEnglishPrompt', () => {
  it('returns false for null/undefined/empty', () => {
    expect(isLikelyEnglishPrompt(null)).toBe(false);
    expect(isLikelyEnglishPrompt(undefined)).toBe(false);
    expect(isLikelyEnglishPrompt('')).toBe(false);
  });

  it('returns false for short prompts (under the 40-char floor)', () => {
    expect(isLikelyEnglishPrompt('A short prompt.')).toBe(false);
    expect(isLikelyEnglishPrompt('Ảnh Yêu stands here.')).toBe(false); // 21 chars
  });

  it('accepts plain English prose', () => {
    expect(isLikelyEnglishPrompt(
      'A young girl with silver hair stands beneath cherry blossoms, looking at the moon.',
    )).toBe(true);
  });

  it('accepts English prose that contains ONE Vietnamese character name (the bug we just fixed)', () => {
    // Before the fix this was rejected because the regex included the
    // Latin Extended-A range (Vietnamese diacritics). The fix removed
    // that range and added a ratio guard so a single accented word
    // among English prose passes.
    expect(isLikelyEnglishPrompt(
      'Vũ An Bang stands beneath the ancient banyan tree, eyes glowing in the moonlight. ' +
      'The wind ruffles his dark robes as he draws his sword.',
    )).toBe(true);
    expect(isLikelyEnglishPrompt(
      'Ảnh Yêu lifts her lantern high, the flame flickering against the stone walls of the temple.',
    )).toBe(true);
  });

  it('rejects pure Vietnamese paragraphs (high accented-Latin word ratio)', () => {
    // 100% accented Latin → ratio guard fails.
    expect(isLikelyEnglishPrompt(
      'Trong làng có một người đàn ông cảm thấy rất buồn, anh ta cầm lấy thanh kiếm và bước ra ngoài cửa sổ nhìn xuống con đường làng thân thuộc.',
    )).toBe(false);
  });

  it('rejects CJK / Greek / Cyrillic scripts', () => {
    expect(isLikelyEnglishPrompt(
      'A scene with 「这是一段中文」 characters inside dialogue marks of varied typography throughout.',
    )).toBe(false);
    expect(isLikelyEnglishPrompt(
      'Τα αρχαία ελληνικά γράμματα στοιχειώνουν το τοπίο της σκηνής με μυστήριο και γαλήνη.',
    )).toBe(false);
    expect(isLikelyEnglishPrompt(
      'Древнерусские буквы покрывают стены храма в лунном свете тихой безлунной ночи.',
    )).toBe(false);
    expect(isLikelyEnglishPrompt(
      'かなの文字が古びた巻物に並び、月明かりの下で静かに揺れている。',
    )).toBe(false);
  });

  it('counts a high ratio of accented-Latin words as contamination', () => {
    // Construct a prompt where 6/9 words are accented Latin. Threshold
    // is 50% (strictly less than or equal). With 6 accented + 3 ASCII,
    // ratio = 0.666 → reject.
    expect(isLikelyEnglishPrompt(
      'Trong ngôi làng nhỏ ấy có hai người đàn ông quen nhau từ thuở nhỏ.',
    )).toBe(false);
  });

  it('counts a low ratio of accented-Latin words as legitimate', () => {
    // 2/12 words accented Latin — well under the 50% threshold.
    expect(isLikelyEnglishPrompt(
      'A lone warrior named Vũ An Bang walks through the snow-covered forest in silence. ' +
      'He carries a heavy burden on his shoulders. The wind howls across the open plain.',
    )).toBe(true);
  });
});

// src/tests/character-alias-confidence.test.ts
//
// Pure-function tests for computeAliasConfidence / classifyAliasScore —
// the per-alias confidence helper that drives the "needs review" badge
// in CharacterMergeSplitPanel.
//
// We test the scoring function directly (no Prisma mock needed) so the
// tests run fast and stay readable.

import { describe, it, expect } from 'vitest';
import {
  computeAliasConfidence,
  classifyAliasScore,
  LOW_CONFIDENCE_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
} from '@/lib/ai/character-alias-confidence';

describe('computeAliasConfidence', () => {
  it('exact fold → 0.95', () => {
    // Two distinct names that happen to fold via the exact method.
    // (Self-alias, where alias literally equals primary, is a separate
    //  short-circuit that always returns 1.0 — see the test below.)
    expect(computeAliasConfidence('Linh', 'Linh chị', {
      aliasCount: 1,
      foldMethod: 'exact',
      sampleLinesCount: 0,
    })).toBeCloseTo(0.95, 2);
  });

  it('normalized fold → 0.95 (same as exact)', () => {
    expect(computeAliasConfidence('Lộc', 'Loc', {
      aliasCount: 1,
      foldMethod: 'normalized',
      sampleLinesCount: 0,
    })).toBeCloseTo(0.95, 2);
  });

  it('substring fold → 0.85', () => {
    expect(computeAliasConfidence('Linh', 'Linh Hồng', {
      aliasCount: 1,
      foldMethod: 'substring',
      sampleLinesCount: 0,
    })).toBeCloseTo(0.85, 2);
  });

  it('levenshtein fold → 0.75', () => {
    expect(computeAliasConfidence('Lan', 'Lann', {
      aliasCount: 1,
      foldMethod: 'levenshtein',
      sampleLinesCount: 0,
    })).toBeCloseTo(0.75, 2);
  });

  it('llm-only fold → 0.60', () => {
    expect(computeAliasConfidence('Linh', 'cô bé bí ẩn', {
      aliasCount: 1,
      foldMethod: 'llm',
      sampleLinesCount: 0,
    })).toBeCloseTo(0.6, 2);
  });

  it('sample-lines bonus caps at +0.20', () => {
    // llm base 0.6 + 4 sample lines × 0.05 = +0.20 → 0.80 total
    expect(computeAliasConfidence('Linh', 'cô bé bí ẩn', {
      aliasCount: 1,
      foldMethod: 'llm',
      sampleLinesCount: 4,
    })).toBeCloseTo(0.8, 2);

    // 10 sample lines × 0.05 = +0.50 → capped at +0.20 → still 0.80
    expect(computeAliasConfidence('Linh', 'cô bé bí ẩn', {
      aliasCount: 1,
      foldMethod: 'llm',
      sampleLinesCount: 10,
    })).toBeCloseTo(0.8, 2);
  });

  it('crowding decay kicks in at alias #4', () => {
    // aliasCount=3 → no decay
    const base = computeAliasConfidence('Linh', 'Linh Hồng', {
      aliasCount: 3,
      foldMethod: 'substring',
      sampleLinesCount: 0,
    });
    expect(base).toBeCloseTo(0.85, 2);

    // aliasCount=4 → ×0.85 = 0.7225
    const after1 = computeAliasConfidence('Linh', 'Linh Hồng', {
      aliasCount: 4,
      foldMethod: 'substring',
      sampleLinesCount: 0,
    });
    expect(after1).toBeCloseTo(0.7225, 2);

    // aliasCount=5 → ×0.85² = 0.614125
    const after2 = computeAliasConfidence('Linh', 'Linh Hồng', {
      aliasCount: 5,
      foldMethod: 'substring',
      sampleLinesCount: 0,
    });
    expect(after2).toBeCloseTo(0.6141, 2);
  });

  it('self-alias returns 1.0 regardless of fold method', () => {
    expect(computeAliasConfidence('Linh', 'linh', {
      aliasCount: 5,
      foldMethod: 'llm',
      sampleLinesCount: 0,
    })).toBe(1.0);
  });

  it('clamps to [0, 1]', () => {
    // Decay would push below 0
    const veryLow = computeAliasConfidence('Linh', 'x', {
      aliasCount: 100,
      foldMethod: 'llm',
      sampleLinesCount: 0,
    });
    expect(veryLow).toBeGreaterThanOrEqual(0);
    expect(veryLow).toBeLessThanOrEqual(1);
  });

  it('rounds to 2 decimal places', () => {
    const result = computeAliasConfidence('Linh', 'Linh chị', {
      aliasCount: 4,
      foldMethod: 'normalized',
      sampleLinesCount: 0,
    });
    // 0.95 × 0.85 = 0.8075 → rounds to 0.81
    expect(result).toBeCloseTo(0.81, 2);
    // Check it's exactly at 2dp (no more precision leaked)
    expect(String(result).match(/\.\d{3}/)).toBeNull();
  });

  it('empty inputs → 0 (safest score)', () => {
    expect(computeAliasConfidence('', 'Linh', {
      aliasCount: 1, foldMethod: 'exact', sampleLinesCount: 0,
    })).toBe(0);
    expect(computeAliasConfidence('Linh', '', {
      aliasCount: 1, foldMethod: 'exact', sampleLinesCount: 0,
    })).toBe(0);
  });
});

describe('classifyAliasScore', () => {
  it('high tier for scores >= 0.8', () => {
    expect(classifyAliasScore(0.95)).toBe('high');
    expect(classifyAliasScore(0.8)).toBe('high');
    expect(classifyAliasScore(1.0)).toBe('high');
  });

  it('medium tier for 0.6..0.8 (exclusive of 0.8)', () => {
    expect(classifyAliasScore(0.79)).toBe('medium');
    expect(classifyAliasScore(0.7)).toBe('medium');
    expect(classifyAliasScore(0.6)).toBe('medium');
  });

  it('low tier for scores < 0.6', () => {
    expect(classifyAliasScore(0.59)).toBe('low');
    expect(classifyAliasScore(0.0)).toBe('low');
  });

  it('threshold constants are non-overlapping', () => {
    expect(HIGH_CONFIDENCE_THRESHOLD).toBeGreaterThan(LOW_CONFIDENCE_THRESHOLD);
    expect(HIGH_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.6);
  });
});

// src/tests/character-bible-build.test.ts
//
// Unit tests for the pure-function parts of the bible build pipeline:
//   - canonicalizeRelationship (label folding)
//   - normKey / alias-aware identity folding helper
//
// The DB-touching bits (sanitizePatches → normalizePatches → queueDiff)
// are integration-tested by hitting the live API; see e2e/05-attribution.spec.ts.
import { describe, it, expect } from 'vitest';
import {
  canonicalizeRelationship,
  normKey,
} from '@/lib/db/character-bible';

describe('canonicalizeRelationship', () => {
  it('folds English variants to canonical snake_case', () => {
    expect(canonicalizeRelationship('mother')).toBe('mother');
    expect(canonicalizeRelationship('Mother')).toBe('mother');
    expect(canonicalizeRelationship('MOTHER')).toBe('mother');
    expect(canonicalizeRelationship('older sister')).toBe('older_sister');
    expect(canonicalizeRelationship('older_brother')).toBe('older_brother');
  });

  it('folds Vietnamese variants to canonical English', () => {
    expect(canonicalizeRelationship('mẹ')).toBe('mother');
    expect(canonicalizeRelationship('Mẹ')).toBe('mother');
    expect(canonicalizeRelationship('cha')).toBe('father');
    expect(canonicalizeRelationship('bố')).toBe('father');
    expect(canonicalizeRelationship('anh trai')).toBe('older_brother');
    expect(canonicalizeRelationship('chị gái')).toBe('older_sister');
    expect(canonicalizeRelationship('em gái')).toBe('younger_sister');
    expect(canonicalizeRelationship('vợ')).toBe('wife');
    expect(canonicalizeRelationship('chồng')).toBe('husband');
    expect(canonicalizeRelationship('thầy')).toBe('mentor');
    expect(canonicalizeRelationship('sư phụ')).toBe('mentor');
    expect(canonicalizeRelationship('bạn thân')).toBe('friend');
    expect(canonicalizeRelationship('kẻ thù')).toBe('enemy');
    expect(canonicalizeRelationship('đồng nghiệp')).toBe('colleague');
  });

  it('returns unknown labels unchanged (no invention)', () => {
    // We deliberately don't invent canonical names for LLM-once-only terms.
    expect(canonicalizeRelationship('huynh đệ')).toBe('huynh đệ');
    expect(canonicalizeRelationship('third cousin once removed')).toBe('third cousin once removed');
    expect(canonicalizeRelationship('')).toBe('');
  });
});

describe('normKey — name folding for identity matching', () => {
  it('is case-insensitive', () => {
    expect(normKey('Linh')).toBe(normKey('linh'));
    expect(normKey('LINH')).toBe(normKey('linh'));
    expect(normKey('Linh')).toBe(normKey('LiNh'));
  });

  it('NFC-normalizes accents', () => {
    // Two NFD vs NFC encodings of "Lâm"
    const nfd = 'L' + 'â' + 'm';
    const nfc = 'Lâ' + 'm';
    expect(normKey(nfd)).toBe(normKey(nfc));
  });

  it('collapses whitespace', () => {
    expect(normKey('Lâm   Đông  Phương')).toBe(normKey('Lâm Đông Phương'));
    expect(normKey('  Linh  ')).toBe(normKey('Linh'));
  });

  it('distinguishes different names', () => {
    expect(normKey('Linh')).not.toBe(normKey('Lan'));
    expect(normKey('An')).not.toBe(normKey('Anh'));
  });
});

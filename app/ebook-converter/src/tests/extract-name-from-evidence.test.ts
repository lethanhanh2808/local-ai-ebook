// src/tests/extract-name-from-evidence.test.ts
//
// Unit tests for the evidence→name heuristic used by applyAcceptedBiblePatch
// when a queued diff arrives without an embedded targetName. Pure helper,
// no DB so we can pin behaviour tightly.

import { describe, expect, it } from 'vitest';
import { extractNameFromEvidence } from '@/lib/ai/character-bible';

describe('extractNameFromEvidence', () => {
  it('captures a properly-capitalised Vietnamese proper name', () => {
    expect(extractNameFromEvidence('Vũ An Bang là một tráng hán thế kỷ XIX.'))
      .toBe('Vũ An Bang');
    expect(extractNameFromEvidence('Y Đằng Ưu Nhi cầm thanh kiếm bước ra.'))
      .toBe('Y Đằng Ưu Nhi');
  });

  it('captures when the verb is mid-list', () => {
    // Used to match the longer phrase before any punctuation/colons.
    expect(extractNameFromEvidence('Trần Hào Thôn nói: "..."'))
      .toBe('Trần Hào Thôn');
  });

  it('rejects common-noun-led phrases that capitalise at sentence start', () => {
    // Each of these previously promoted a ghost Character row via
    // ensureCharacter() in the apply path. They must now return null.
    expect(extractNameFromEvidence('Trong làng có một người đàn ông cảm thấy...'))
      .toBeNull();
    expect(extractNameFromEvidence('Anh ta đứng ở đầu ngõ nhìn ra.'))
      .toBeNull();
    expect(extractNameFromEvidence('Một người phụ nữ chạy vào trong sân.'))
      .toBeNull();
    expect(extractNameFromEvidence('Ngoài cửa sổ, tiếng mưa rơi lộp độp.'))
      .toBeNull();
    expect(extractNameFromEvidence('Bà nội ngồi trên ghế đá.'))
      .toBeNull();
  });

  it('rejects empty / stop-word input', () => {
    expect(extractNameFromEvidence('')).toBeNull();
    expect(extractNameFromEvidence('Trong')).toBeNull();
    // "và" starts with lowercase 'v' so it fails the [A-ZÀ-Ú] gate,
    // never reaching the stop-word check. This protects mid-sentence
    // Vietnamese verbs / conjunctions from being promoted.
    expect(extractNameFromEvidence('và có là một phần của nhóm.')).toBeNull();
  });

  it('strips surrounding quotes before scanning', () => {
    // The heuristic captures everything before the first matching verb
    // (here "nói"), which means trailing descriptors ("lạnh lùng") land
    // in the candidate too. The apply path is expected to prefer the
    // resolved `targetName` over this fallback for any modern diff; the
    // fallback only matters for legacy queued diffs that pre-date the
    // `targetName` field. We pin the documented behaviour rather than
    // promising name precision here.
    expect(extractNameFromEvidence('"Nữ Đế lạnh lùng nói."'))
      .toBe('Nữ Đế lạnh lùng');
    // Smart-quote U+201C/U+201D variants
    expect(extractNameFromEvidence('“Nữ Đế lạnh lùng nói.”'))
      .toBe('Nữ Đế lạnh lùng');
  });

  it('handles "Người của X mặc..." by extracting X (legacy group hint)', () => {
    expect(extractNameFromEvidence('Người của Môn Chủ mặc áo bào xanh.'))
      .toBe('Môn Chủ');
  });

  it('falls back gracefully when no verb marker is found', () => {
    // No Vietnamese verb in the candidate-set — return null rather than
    // guess. The apply path then reports appearance-missing-target and
    // the user picks via the Edit dialog.
    expect(extractNameFromEvidence('A mysterious stranger arrived quietly.'))
      .toBeNull();
  });

  it('accepts only one token when the rest is stop-word-looking', () => {
    // Single capitalized word immediately followed by a verb is the
    // most common shape. Two-word names with a small connecting token
    // also work because the regex is greedy only for non-verb text.
    expect(extractNameFromEvidence('Trang là chị cả.'))
      .toBe('Trang');
  });
});

// src/tests/attribution-whole-chapter.test.ts
//
// Unit tests for the whole-chapter LLM mode added 2026-07-12. Verifies:
//   - Single chatJSON call (no batching, no concurrency).
//   - System prompt + Vietnamese rules block carried over verbatim.
//   - enable_thinking=false (consistent with chunked path).
//   - max_tokens=16384 (hardcoded cap for v1).
//   - onBatch fires exactly once with idx:1, total:1.
//   - JsonChatError fail-closes: empty map + failedBatches=1, never throws.
//   - All paragraphs (resolved + unresolved) shipped — whole-point of mode.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  JsonChatError: class JsonChatError extends Error {
    constructor(message: string, public raw: string) { super(message); }
  },
}));

vi.mock('@/lib/ai/index', () => ({
  chatJSON: ai.chatJSON,
  JsonChatError: ai.JsonChatError,
}));

import {
  attributeByLLMWholeChapter,
  LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS,
  type ParagraphRange,
} from '@/lib/attribution';

function p(texts: string[]): ParagraphRange[] {
  let cursor = 0;
  return texts.map((text, index) => {
    const row = { index, start: cursor, end: cursor + text.length, text };
    cursor += text.length + 1;
    return row;
  });
}

const knownNames = ['Lan', 'Minh'];
const characterContext = [
  { name: 'Lan', aliases: [], gender: 'female' as const },
  { name: 'Minh', aliases: [], gender: 'male' as const },
];

describe('attributeByLLMWholeChapter (added 2026-07-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. makes exactly ONE chatJSON call regardless of paragraph count', async () => {
    ai.chatJSON.mockResolvedValueOnce([]);
    const paragraphs = p(Array.from({ length: 50 }, (_, i) => `Minh nói: "Câu ${i}."`));
    const onBatch = vi.fn();
    await attributeByLLMWholeChapter({
      paragraphs,
      unresolvedIndices: paragraphs.map((x) => x.index),
      knownNames,
      characterContext,
      regexOut: {},
      onBatch,
    });
    expect(ai.chatJSON).toHaveBeenCalledTimes(1);
  });

  it('2. ships every paragraph in the user message (not just unresolvedIndices)', async () => {
    ai.chatJSON.mockResolvedValueOnce([]);
    const paragraphs = p(Array.from({ length: 20 }, (_, i) => `Minh nói: "Câu ${i}."`));
    await attributeByLLMWholeChapter({
      paragraphs,
      unresolvedIndices: [0, 5, 10],  // only 3 unresolved — ignored in whole-chapter mode
      knownNames,
      characterContext,
      regexOut: {},
    });
    const call = ai.chatJSON.mock.calls[0][0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === 'user').content;
    // Every paragraph (not just the 3 unresolved) must be in the prompt.
    for (const para of paragraphs) {
      expect(userMsg).toContain(`${para.index} |`);
    }
  });

  it('3. preserves the Vietnamese system line + rules block verbatim', async () => {
    ai.chatJSON.mockResolvedValueOnce([]);
    await attributeByLLMWholeChapter({
      paragraphs: p(['Lan nói: "Chào."']),
      unresolvedIndices: [0],
      knownNames,
      characterContext,
      regexOut: {},
    });
    const messages = ai.chatJSON.mock.calls[0][0].messages;
    const sysMsg = messages[0].content as string;
    const userMsg = messages[1].content as string;
    // System line: /nothink + JSON-array directive (verbatim with chunked path).
    expect(sysMsg).toContain('/nothink');
    expect(sysMsg).toContain('Bạn chuyên gia văn học Việt Nam');
    expect(sysMsg).toContain('Trả lời CHỈ bằng JSON array');
    // Rules block lives in the user message (not the system message).
    expect(userMsg).toMatch(/Động từ nói\/hỏi\/đáp\/kêu\/thì thầm/);
    expect(userMsg).toContain('Tên ở vị trí tân ngữ');
    expect(userMsg).toMatch(/Đại từ cô\/anh\/chị\/em\/bà\/ông/);
    expect(userMsg).toContain('Nếu không chắc chắn');
    expect(userMsg).toContain('Trả về JSON');
  });

  it('4. uses max_tokens=16384 and enable_thinking=false', async () => {
    ai.chatJSON.mockResolvedValueOnce([]);
    await attributeByLLMWholeChapter({
      paragraphs: p(['Lan nói: "Chào."']),
      unresolvedIndices: [0],
      knownNames,
      characterContext,
      regexOut: {},
    });
    const opts = ai.chatJSON.mock.calls[0][0];
    expect(opts.max_tokens).toBe(16384);
    expect(opts.enable_thinking).toBe(false);
  });

  it('5. fires onBatch exactly once with idx:1, total:1', async () => {
    ai.chatJSON.mockResolvedValueOnce([]);
    const paragraphs = p(Array.from({ length: 30 }, (_, i) => `Minh nói: "Câu ${i}."`));
    const onBatch = vi.fn();
    await attributeByLLMWholeChapter({
      paragraphs,
      unresolvedIndices: paragraphs.map((x) => x.index),
      knownNames,
      characterContext,
      regexOut: {},
      onBatch,
    });
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toMatchObject({
      idx: 1,
      total: 1,
      ok: true,
    });
    expect(onBatch.mock.calls[0][0].indices).toHaveLength(30);
    expect(onBatch.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('6. returns empty map + failedBatches=1 on JsonChatError (fail-closed)', async () => {
    ai.chatJSON.mockRejectedValueOnce(new ai.JsonChatError('parse failed', '[truncated'));
    const onBatch = vi.fn();
    const result = await attributeByLLMWholeChapter({
      paragraphs: p(Array.from({ length: 10 }, (_, i) => `Minh nói: "Câu ${i}."`)),
      unresolvedIndices: Array.from({ length: 10 }, (_, i) => i),
      knownNames,
      characterContext,
      regexOut: {},
      onBatch,
    });
    expect(result).toMatchObject({ map: {}, failedBatches: 1, requested: 10 });
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toMatchObject({ idx: 1, total: 1, ok: false });
    expect(onBatch.mock.calls[0][0].error).toContain('parse failed');
  });

  it('7. applies valid rows from a successful response and reuses them in the map', async () => {
    ai.chatJSON.mockResolvedValueOnce([
      { paragraphIdx: 0, speaker: 'Lan', confidence: 0.85 },
      { paragraphIdx: 2, speaker: 'Minh', confidence: 0.7 },
      // Invalid row: speaker outside roster — must be dropped.
      { paragraphIdx: 1, speaker: 'Trời Ơi', confidence: 0.5 },
      // Invalid row: idx not in chapter — must be dropped.
      { paragraphIdx: 99, speaker: 'Lan', confidence: 0.6 },
    ]);
    const paragraphs = p(Array.from({ length: 5 }, (_, i) => `Minh nói: "Câu ${i}."`));
    const result = await attributeByLLMWholeChapter({
      paragraphs,
      unresolvedIndices: paragraphs.map((x) => x.index),
      knownNames,
      characterContext,
      regexOut: {},
    });
    expect(result.failedBatches).toBe(0);
    expect(result.requested).toBe(5);
    expect(result.map[0]).toMatchObject({ speaker: 'Lan', source: 'llm' });
    expect(result.map[2]).toMatchObject({ speaker: 'Minh', source: 'llm' });
    expect(result.map[1]).toBeUndefined();
    expect(result.map[99]).toBeUndefined();
  });

  it('8. truncates gracefully above LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS', async () => {
    ai.chatJSON.mockResolvedValueOnce([]);
    const n = LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS + 50;
    const paragraphs = p(Array.from({ length: n }, (_, i) => `Minh nói: "Câu ${i}."`));
    const onBatch = vi.fn();
    const result = await attributeByLLMWholeChapter({
      paragraphs,
      unresolvedIndices: paragraphs.map((x) => x.index),
      knownNames,
      characterContext,
      regexOut: {},
      onBatch,
    });
    // Caller should have been warned via onBatch.error mentioning truncation.
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0].error).toMatch(/truncated/);
    expect(onBatch.mock.calls[0][0].indices).toHaveLength(LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS);
    // `requested` reflects what the LLM saw, not what the caller asked for.
    expect(result.requested).toBe(LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS);
  });

  it('9. returns early with failedBatches=0 when no paragraphs or no roster', async () => {
    const onBatch = vi.fn();
    const r1 = await attributeByLLMWholeChapter({
      paragraphs: [],
      unresolvedIndices: [],
      knownNames,
      characterContext,
      regexOut: {},
      onBatch,
    });
    expect(r1).toEqual({ map: {}, failedBatches: 0, requested: 0 });
    expect(ai.chatJSON).not.toHaveBeenCalled();

    const paragraphs = p(['Lan nói: "Chào."']);
    const r2 = await attributeByLLMWholeChapter({
      paragraphs,
      unresolvedIndices: [0],
      knownNames: [],  // empty roster
      characterContext: [],
      regexOut: {},
      onBatch,
    });
    expect(r2).toEqual({ map: {}, failedBatches: 0, requested: 0 });
    expect(ai.chatJSON).not.toHaveBeenCalled();
  });

  it('10. populates ±1 context window with regexUpstream for adjacent paragraphs', async () => {
    ai.chatJSON.mockResolvedValueOnce([]);
    const paragraphs = p(['Lan nói: "Chào."', 'Minh nói: "Ừ."', 'Lan nói: "Đi thôi."']);
    const regexOut: Record<number, { speaker: string; confidence: number; source: 'regex' }> = {
      0: { speaker: 'Lan', confidence: 0.55, source: 'regex' },
    };
    await attributeByLLMWholeChapter({
      paragraphs,
      unresolvedIndices: paragraphs.map((x) => x.index),
      knownNames,
      characterContext,
      regexOut,
    });
    const userMsg = ai.chatJSON.mock.calls[0][0].messages[1].content;
    // P[1] should see prevSpeaker=Lan (from regexOut[0]).
    expect(userMsg).toMatch(/^1 \| .+ \| Lan\b/m);
    // P[0] has no previous — should see the em-dash fallback.
    expect(userMsg).toMatch(/^0 \| .+ \| —/m);
  });
});

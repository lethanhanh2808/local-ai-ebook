// e2e/05-attribution.spec.ts
// Reader-facing attribution API smoke test for the stateful conversation engine.

import { test, expect } from '@playwright/test';
import { getBookChapters, resolveTestBook } from './helpers';

test.describe('Stateful speaker attribution', () => {
  test('chapter attribution endpoint returns conversation-v1 payload', async ({ page }) => {
    const book = await resolveTestBook(page);
    const chapters = await getBookChapters(page, book.id);
    test.skip(chapters.length === 0, `Book ${book.id} has no parsed chapters`);

    const chapter = chapters[0];
    const r = await page.request.get(
      `/api/library/${book.id}/chapters/${encodeURIComponent(chapter.id)}/attribute`,
      { timeout: 120_000 },
    );
    expect(r.ok(), 'attribution API should respond').toBe(true);
    const data = await r.json() as {
      parserVersion: string;
      attribution: Record<string, {
        speaker: string | null;
        confidence: number;
        source: string;
        evidence?: unknown[];
        state?: unknown;
      }>;
      stats: {
        parserHits: number;
        regexHits: number;
        llmHits: number;
        conversationHits: number;
        defaults: number;
        totalParagraphs: number;
      };
    };

    expect(data.parserVersion).toContain('conversation-v1');
    expect(data.attribution ?? {}).toEqual(expect.any(Object));
    expect(data.stats.totalParagraphs).toBeGreaterThanOrEqual(0);
    expect(data.stats.conversationHits).toEqual(expect.any(Number));

    const rows = Object.values(data.attribution ?? {});
    for (const row of rows) {
      expect(['parser', 'regex', 'llm', 'conversation', 'default']).toContain(row.source);
      expect(row.confidence).toBeGreaterThanOrEqual(0);
      expect(row.confidence).toBeLessThanOrEqual(1);
      if (row.evidence) expect(row.evidence).toEqual(expect.any(Array));
      if (row.state) expect(row.state).toEqual(expect.any(Object));
    }
  });
});

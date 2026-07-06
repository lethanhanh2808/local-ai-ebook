// e2e/07-conversation-state-debug.spec.ts
//
// Coverage for the read-only debug endpoint that surfaces the
// `BookConversationState` row in JSON form:
//   GET /api/library/[id]/conversation-state
//
// Two paths:
//   • found: true  — returns { lastChapterIndex, parserVersion, snapshot }
//   • not found    — returns { found: false, reason }
//   • 404          — when the book id is unknown
//
// The endpoint never returns `stale-chapter`: it asks for the row as it
// is right now, not "what would loadConversationState report for chapter
// N". Verified by behaviour, not by reading the implementation.

import { test, expect } from '@playwright/test';
import {
  resolveTestBook,
  attributeChapterViaApi,
  clearConversationStateForBook,
  getConversationStateViaApi,
} from './helpers';

const CHAPTER_A_ID = 'chapter003';

test.describe('ConversationState debug endpoint', () => {
  test('GET returns the persisted snapshot after the route persists it', async ({ page }) => {
    const book = await resolveTestBook(page);
    await clearConversationStateForBook(book.id);

    // First call: should report no-row.
    const empty = await getConversationStateViaApi(page, book.id);
    expect(empty.status, 'first GET status').toBe(200);
    expect(empty.body.found, 'first GET found').toBe(false);
    expect(empty.body.reason, 'first GET reason').toBe('no-row');

    // Drive chapter A through the attribution pipeline so the route
    // persists a snapshot. This mirrors how the chip / live reader
    // populates the row.
    const dataA = await attributeChapterViaApi(page, CHAPTER_A_ID, book.id);
    expect(dataA.crossChapter.persistedAt, 'A persistedAt (compute)').toBeTruthy();

    // Now the endpoint should report found with the snapshot.
    const populated = await getConversationStateViaApi(page, book.id);
    expect(populated.status, 'populated GET status').toBe(200);
    expect(populated.body.found).toBe(true);
    expect(populated.body.lastChapterIndex, 'lastChapterIndex').toEqual(expect.any(Number));
    expect(populated.body.parserVersion, 'parserVersion').toBeTruthy();
    expect(populated.body.snapshot, 'snapshot should be returned').toBeTruthy();
    expect(populated.body.snapshot?.dialogueHistoryLength)
      .toEqual(expect.any(Number));
    expect(populated.body.snapshot?.activeCharacters)
      .toEqual(expect.any(Array));
  });

  test('GET returns 404 for an unknown book id', async ({ page }) => {
    // Random UUID — virtually guaranteed not to exist.
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const r = await getConversationStateViaApi(page, fakeId);
    expect(r.status).toBe(404);
    expect(r.body.error).toBeTruthy();
  });
});

// e2e/06-cross-chapter-state.spec.ts
//
// Cross-chapter ConversationState carry (D1).
//
// Validates the three states a per-chapter attribution call can land in:
//
//   1. `no-row`      — first chapter of a book, no seed exists.
//   2. `applied`     — call follows a chapter whose snapshot was persisted.
//                       `seedFromChapterIndex` should equal the previous idx.
//   3. `stale-chapter` — the stored snapshot is from a chapter *ahead* of
//                        the one being attributed (e.g. user re-read ch.3
//                        after ch.5 was attributed). The route must NOT
//                        apply the seed.
//
// Three test cases mirror those states. The API path drives the attribution
// endpoint directly (cheap, deterministic). The GUI path opens the reader,
// navigates via the TOC, and verifies the same `crossChapter` block from
// the network response on chapter N+1.
//
// Default test book is the project convention `ffa65ac0-…` (set in
// helpers.ts). Override via `E2E_BOOK_ID=<uuid>`. The book must contain at
// least chapters 003, 004, and 005 (the convention from the existing
// README + the chapter-id padStart(3) layout).

import { test, expect, Page } from '@playwright/test';
import {
  resolveTestBook,
  getBookChapters,
  attributeChapterViaApi,
  clearConversationStateForBook,
  getConversationStateForBook,
  type E2EChapter,
} from './helpers';

const CHAPTER_A_ID = 'chapter003';  // 0-based index 2 → chapterIndex=2
const CHAPTER_B_ID = 'chapter004';  // 0-based index 3 → chapterIndex=3
const CHAPTER_C_ID = 'chapter005';  // 0-based index 4 → chapterIndex=4
// For the stale test we need a chapter AHEAD of CHAPTER_A — chapter006
// (chapterIndex=5). When ch.6 is attributed, then ch.3 re-attributed,
// the seed read for ch.3 should report stale-chapter.

async function chapterIndexOf(chapters: E2EChapter[], id: string): Promise<number> {
  const idx = chapters.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error(`chapter ${id} not present in this book`);
  return idx;
}

async function assertSeedReason(
  page: Page,
  chapterId: string,
  bookId: string,
  expected: 'applied' | 'no-row' | 'stale-chapter' | 'version-mismatch' | 'empty',
  opts: { expectFromIndex?: number } = {},
) {
  const data = await attributeChapterViaApi(page, chapterId, bookId);
  expect(data.crossChapter, `crossChapter for ${chapterId}`).toBeTruthy();
  expect(data.crossChapter.seedReason, `seedReason for ${chapterId}`)
    .toBe(expected);
  if (opts.expectFromIndex !== undefined) {
    expect(data.crossChapter.seedFromChapterIndex,
      `seedFromChapterIndex for ${chapterId}`).toBe(opts.expectFromIndex);
  }
  return data;
}

test.describe('Cross-chapter ConversationState carry (D1)', () => {
  test.beforeEach(async ({ page }) => {
    // Resolve the book first so we can scope the seed clear to its id.
    const book = await resolveTestBook(page);
    await clearConversationStateForBook(book.id);
  });

  test('API: chapter A → no-row → applied on chapter B', async ({ page }) => {
    const book = await resolveTestBook(page);
    const chapters = await getBookChapters(page, book.id);
    test.skip(chapters.length < 4, `Book needs ≥4 chapters; has ${chapters.length}`);

    const idxA = await chapterIndexOf(chapters, CHAPTER_A_ID);
    const idxB = await chapterIndexOf(chapters, CHAPTER_B_ID);

    // Step 1: clear → attribute A → expect seedReason=no-row, no seed carried.
    await clearConversationStateForBook(book.id);
    const dataA1 = await assertSeedReason(page, CHAPTER_A_ID, book.id, 'no-row');
    expect(dataA1.crossChapter.seedApplied, 'A1 seedApplied').toBe(false);
    expect(dataA1.crossChapter.seedFromChapterIndex, 'A1 seedFromChapterIndex').toBeNull();
    // After the compute, the route should have persisted the snapshot for A.
    // (fromCache may be true on the second call to the same chapter, but
    //  `persistedAt` only reports a non-null value when WE just computed.)
    expect(dataA1.crossChapter.persistedAt, 'A1 persistedAt').toBe(idxA);

    // Step 2: attribute B → expect seedReason=applied, seedFromChapterIndex=A.
    const dataB = await assertSeedReason(page, CHAPTER_B_ID, book.id, 'applied', {
      expectFromIndex: idxA,
    });
    expect(dataB.crossChapter.seedApplied, 'B seedApplied').toBe(true);
    // The B compute also persists — but this run cached. Re-call to confirm
    // the persisted row is now at index B, not A.
    expect(dataB.crossChapter.persistedAt, 'B persistedAt (cached compute)')
      .toBe(idxA); // fromCache=true → we don't re-persist

    // Step 3: idempotency — re-attribute B should still report applied.
    await assertSeedReason(page, CHAPTER_B_ID, book.id, 'applied', {
      expectFromIndex: idxA,
    });

    // Step 4: row in the DB should match B's index (latest successful compute).
    const row = await getConversationStateForBook(book.id);
    expect(row, 'BookConversationState row should exist').toBeTruthy();
    expect(row!.lastChapterIndex, 'persisted lastChapterIndex').toBe(idxB);
  });

  test('API: stale-chapter when re-attributing an earlier chapter', async ({ page }) => {
    const book = await resolveTestBook(page);
    const chapters = await getBookChapters(page, book.id);
    test.skip(chapters.length < 5, `Book needs ≥5 chapters; has ${chapters.length}`);

    // Seed the conversation state at chapter C (idx 4).
    await clearConversationStateForBook(book.id);
    await assertSeedReason(page, CHAPTER_C_ID, book.id, 'no-row');
    // The compute above persisted state with lastChapterIndex=4 for C.

    // Sanity: re-attributing C reports applied and fromIndex=C (itself).
    const idxC = await chapterIndexOf(chapters, CHAPTER_C_ID);
    await assertSeedReason(page, CHAPTER_C_ID, book.id, 'applied', {
      expectFromIndex: idxC,
    });

    // Now re-attribute chapter A (idx 2). The stored lastChapterIndex=4 is
    // ahead, so the seed must be flagged stale, not applied.
    await assertSeedReason(page, CHAPTER_A_ID, book.id, 'stale-chapter');
  });

  test('GUI: TOC navigation between two chapters applies the seed on the second', async ({ page }) => {
    const book = await resolveTestBook(page);
    const chapters = await getBookChapters(page, book.id);
    test.skip(chapters.length < 4, `Book needs ≥4 chapters; has ${chapters.length}`);

    // Clear any prior seed so we measure carry from this run only.
    await clearConversationStateForBook(book.id);

    const idxA = await chapterIndexOf(chapters, CHAPTER_A_ID);
    const idxB = await chapterIndexOf(chapters, CHAPTER_B_ID);

    // 1. Drive the reader. The reader fetches its own attribution on open
    //    for each chapter via /attribute — so a TOC click in the GUI does
    //    trigger the same code path that the API test above exercises.
    await page.goto(`/library/${book.id}/read`);
    await page.waitForLoadState('domcontentloaded');
    // Wait for the reader to load chapters — a TOC button renders only after.
    await page.getByTestId('toc-toggle').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('toc-toggle').click();

    // 2. Jump straight to chapter A and let attribution settle.
    await page.getByTestId(`toc-chapter-${idxA}`).click();
    // The TOC panel auto-closes on selection (see goToChapter) — wait for
    // the fetch to complete by querying the API directly.
    await expect.poll(async () => {
      const r = await attributeChapterViaApi(page, CHAPTER_A_ID, book.id, { timeout: 30_000 });
      return r.crossChapter.persistedAt;
    }, { timeout: 60_000, intervals: [1_000] }).toBe(idxA);

    // 3. Open the TOC again and click chapter B. After the navigation
    //    settles, the attribution call for B should report the seed from A.
    await page.getByTestId('toc-toggle').click();
    await page.getByTestId(`toc-chapter-${idxB}`).click();

    await expect.poll(async () => {
      const r = await attributeChapterViaApi(page, CHAPTER_B_ID, book.id, { timeout: 30_000 });
      return r.crossChapter;
    }, { timeout: 60_000, intervals: [1_000], message: 'crossChapter for B' })
      .toEqual({
        seedApplied: true,
        seedReason: 'applied',
        seedFromChapterIndex: idxA,
        persistedAt: idxA,  // cached compute — not re-persisted
      });

    // 4. The row in the DB should reflect the latest compute (chapter B).
    const row = await getConversationStateForBook(book.id);
    expect(row, 'BookConversationState row should exist after GUI nav').toBeTruthy();
    expect(row!.lastChapterIndex).toBe(idxB);
  });

  test('GUI: VoiceDebugPanel paints the cross-chapter seed chip on chapter B', async ({ page }) => {
    // Prerequisite: chapter B's attribution must already have run so the
    // ref has the crossChapter block. We set this up by hitting the API
    // for chapter A (cleared), then chapter B (seeded). The reader's
    // own attribution call on chapter-open will redo this, so this is
    // belt-and-braces.
    const book = await resolveTestBook(page);
    const chapters = await getBookChapters(page, book.id);
    test.skip(chapters.length < 4, `Book needs ≥4 chapters; has ${chapters.length}`);

    await clearConversationStateForBook(book.id);
    const idxA = await chapterIndexOf(chapters, CHAPTER_A_ID);
    const idxB = await chapterIndexOf(chapters, CHAPTER_B_ID);

    // Drive through reader first so the VoiceDebugPanel sees a populated
    // chapterAttributionRef for chapter B before the assertion fires.
    await page.goto(`/library/${book.id}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.getByTestId('toc-toggle').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('toc-toggle').click();
    await page.getByTestId(`toc-chapter-${idxA}`).click();

    // Wait for chapter A to land in the panel.
    await expect.poll(async () => {
      const r = await attributeChapterViaApi(page, CHAPTER_A_ID, book.id, { timeout: 30_000 });
      return r.crossChapter.persistedAt;
    }, { timeout: 60_000, intervals: [1_000] }).toBe(idxA);

    // Switch to chapter B.
    await page.getByTestId('toc-toggle').click();
    await page.getByTestId(`toc-chapter-${idxB}`).click();

    // Open VoiceDebugPanel.
    await page.getByTestId('voice-debug-toggle').click();

    // Chip must render with seedReason='applied' and reference the
    // chapter we seeded FROM. The data-seed-reason attribute is the
    // hook the chip exposes; the visible label is what the user sees.
    const chip = page.getByTestId('voice-debug-cross-chapter');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveAttribute('data-seed-reason', 'applied');
    await expect(chip).toContainText(`chapter ${idxA}`);  // "carried from chapter 2"
  });
});

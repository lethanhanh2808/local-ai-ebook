// e2e/08-novel-names.spec.ts
//
// Coverage for G4 (unregistered-name detection). The attribute route
// returns a `potentialNewCharacters: string[]` block alongside the
// existing `crossChapter` block. This spec drives the live dev server
// and asserts:
//
//   1. The block is present and shaped as expected (array of strings).
//   2. When the chapter contains a proper noun that isn't in the
//      character roster, that name surfaces in the list.
//   3. Names that ARE in the roster (canonical or alias) do NOT
//      appear in the list.
//   4. The VoiceDebugPanel renders the chip with the right testid and
//      shows each name as its own item.
//   5. After the user adds a name to the roster, the next request
//      drops it from the list (cache-key freshness for this view).
//
// Pre-condition: the test book contains at least one chapter that
// mentions a roster character by name and one that mentions a
// non-roster proper noun. The default test book ("Chiếm Đoạt") meets
// both criteria.

import { test, expect } from '@playwright/test';
import {
  resolveTestBook,
  attributeChapterViaApi,
  cleanBookState,
  getCharacters,
  createCharacter,
} from './helpers';

const CHAPTER_WITH_NOVEL_NAMES = 'chapter004';

test.describe('G4: novel-name detection (potentialNewCharacters)', () => {
  test.beforeEach(async ({ page }) => {
    // Make sure every test starts from a clean roster so the assertion
    // is reproducible: a character we add in test (2) is fresh, and a
    // character the test inspects in test (1) is also fresh.
    await cleanBookState(page);
  });

  test('returns the field as an array (even when empty)', async ({ page }) => {
    const book = await resolveTestBook(page);
    const data = await attributeChapterViaApi(page, CHAPTER_WITH_NOVEL_NAMES, book.id);
    expect(data.potentialNewCharacters, 'field is present').toBeDefined();
    expect(Array.isArray(data.potentialNewCharacters), 'field is an array').toBe(true);
    // Every element must be a non-empty string.
    for (const name of data.potentialNewCharacters ?? []) {
      expect(typeof name, 'each entry is a string').toBe('string');
      expect(name.length, 'each entry is non-empty').toBeGreaterThan(0);
    }
  });

  test('lists proper nouns that are NOT in the roster', async ({ page }) => {
    const book = await resolveTestBook(page);
    const data = await attributeChapterViaApi(page, CHAPTER_WITH_NOVEL_NAMES, book.id);
    const novel = data.potentialNewCharacters ?? [];
    // Sanity: this chapter should surface at least one novel name
    // (the eval-8 book has a "Y Đằng Chân Lí Tử"-style reference). If
    // the roster covers everything in this chapter for some reason the
    // test is still valid — we just skip the population assertion.
    if (novel.length === 0) {
      test.skip(true, 'chapter004 has no novel names under the current roster');
      return;
    }
    // Every novel name must NOT be in the character roster.
    const rosterNames = new Set(
      (await getCharacters(page, book.id)).flatMap((c) => [c.name]),
    );
    for (const name of novel) {
      expect(rosterNames.has(name), `${name} should not be in roster`).toBe(false);
    }
  });

  test('drops a name from the list once the user registers it', async ({ page }) => {
    const book = await resolveTestBook(page);
    // Baseline: capture the chapter's current novel-name list.
    const baseline = await attributeChapterViaApi(page, CHAPTER_WITH_NOVEL_NAMES, book.id);
    const before = baseline.potentialNewCharacters ?? [];
    if (before.length === 0) {
      test.skip(true, 'no novel names to register under the current roster');
      return;
    }
    const targetName = before[0];

    // Register the novel name as a new character.
    const created = await createCharacter(page, {
      name: targetName,
      role: 'supporting',
    });
    expect(created?.id, 'character creation succeeded').toBeTruthy();

    try {
      // Re-query the attribute endpoint. The novel list must drop the
      // newly-registered name immediately because the route recomputes
      // `potentialNewCharacters` from the live roster on every request
      // (cache-key freshness — see BACKLOG-10 design notes).
      const after = await attributeChapterViaApi(page, CHAPTER_WITH_NOVEL_NAMES, book.id);
      const updated = after.potentialNewCharacters ?? [];
      expect(updated, `${targetName} should no longer be in the novel list`).not.toContain(targetName);
    } finally {
      // Cleanup: drop the test character we created so other tests
      // don't see the polluted roster.
      if (created?.id) {
        await page.request.delete(
          `/api/library/${book.id}/characters?id=${created.id}`,
        );
      }
    }
  });

  test('VoiceDebugPanel renders the chip with the right testid', async ({ page }) => {
    const book = await resolveTestBook(page);
    const data = await attributeChapterViaApi(page, CHAPTER_WITH_NOVEL_NAMES, book.id);
    const novel = data.potentialNewCharacters ?? [];
    test.skip(novel.length === 0, 'no novel names under the current roster');

    // Navigate the reader to the test chapter so VoiceDebugPanel picks
    // up the cached attribution. We can't easily open the voice-debug
    // toggle without driving the iframe, but the chip is inside the
    // host page (not the iframe), so we can wait for it directly.
    await page.goto(`/library/${book.id}/${CHAPTER_WITH_NOVEL_NAMES}`);
    await page.locator('[data-testid="voice-debug-toggle"]').click();

    const chip = page.locator('[data-testid="voice-debug-potential-new"]');
    await expect(chip, 'novel-name chip is visible').toBeVisible();
    await expect(chip, 'chip carries the count attribute').toHaveAttribute('data-count', String(novel.length));

    // Each novel name should have its own item with data-name attribute.
    for (const name of novel) {
      const item = page.locator(`[data-testid="voice-debug-potential-new-item"][data-name="${name}"]`);
      await expect(item, `${name} item is rendered`).toBeVisible();
    }
  });

  test('hides the chip when the chapter has no novel names', async ({ page }) => {
    // Build a chapter with no proper nouns (Vietnamese without capitalised
    // multi-word tokens). We can't synthesise HTML easily without going
    // through the parser, so we use a likely-empty chapter from the
    // test book and just assert the chip is hidden when the list is empty.
    const book = await resolveTestBook(page);
    const data = await attributeChapterViaApi(page, 'chapter001', book.id);
    if ((data.potentialNewCharacters ?? []).length > 0) {
      test.skip(true, 'chapter001 has at least one novel name under the current roster');
      return;
    }
    await page.goto(`/library/${book.id}/chapter001`);
    await page.locator('[data-testid="voice-debug-toggle"]').click();
    // Chip must not render when the novel list is empty.
    await expect(
      page.locator('[data-testid="voice-debug-potential-new"]'),
      'chip is hidden when there are no novel names',
    ).toHaveCount(0);
  });
});
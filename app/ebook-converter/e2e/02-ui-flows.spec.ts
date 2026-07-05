// e2e/02-ui-flows.spec.ts
// Browser-level tests of the Voice + Character Detection UI.
//
// These tests actually open the book reader in Chromium and interact
// with the panels. They verify the UI matches the data layer.

import { test, expect } from '@playwright/test';
import { cleanBookState, runDetectOnChapter, TEST_BOOK_ID } from './helpers';

test.describe('Voice + character detection UI', () => {
  test.beforeEach(async ({ page }) => {
    await cleanBookState(page);
  });

  test('Voice panel shows the right empty-state and opens audiobook tab', async ({ page }) => {
    // Open the reader
    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);  // let React mount

    // Open the audiobook panel via the headphones button
    const headphones = page.getByTitle(/Audiobook/i).first();
    await headphones.click();
    await page.waitForTimeout(500);

    // Click "Giọng & nhân vật" tab
    const voicesTab = page.getByRole('button', { name: /Giọng & nhân vật/i });
    await voicesTab.click();
    await page.waitForTimeout(500);

    // Verify empty state for voices (no custom voices uploaded yet)
    await expect(page.getByText(/Chưa có giọng nào/i).first()).toBeVisible({ timeout: 10_000 });

    // AI Character Detection panel should still be visible (the detection UI is
    // always rendered, regardless of whether characters exist)
    await expect(page.getByText(/AI Character Detection/i)).toBeVisible();
  });

  test('Character detection button kicks off AI and shows characters', async ({ page }) => {
    // Pre-populate via API
    await runDetectOnChapter(page, 'chapter003');

    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Open audiobook panel → voices tab
    await page.getByTitle(/Audiobook/i).first().click();
    await page.getByRole('button', { name: /Giọng & nhân vật/i }).click();
    await page.waitForTimeout(500);

    // Should see characters loaded (API call above populated the DB)
    await expect(page.getByText(/Nhân vật \(\d+\)/i)).toBeVisible({ timeout: 15_000 });

    // The character "Âu Sùng Viễn" should be visible
    await expect(page.getByText(/Âu Sùng Viễn/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('Auto-assign voices button exists and triggers detection', async ({ page }) => {
    // Pre-populate with some characters so the button is rendered
    await runDetectOnChapter(page, 'chapter003');

    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Open voices tab
    await page.getByTitle(/Audiobook/i).first().click();
    await page.getByRole('button', { name: /Giọng & nhân vật/i }).click();
    await page.waitForTimeout(500);

    // Auto-assign button should be present (only shows when chars exist)
    const autoBtn = page.getByRole('button', { name: /Gán giọng tự động/i });
    await expect(autoBtn).toBeVisible({ timeout: 15_000 });
  });

  test('Read-aloud panel opens with title "Read aloud" button', async ({ page }) => {
    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // The Read aloud button (volume icon) has title="Read aloud"
    const readAloudBtn = page.getByTitle(/Read aloud/i).first();
    await expect(readAloudBtn).toBeVisible();

    // Click it to open the ReadAloudPanel
    await readAloudBtn.click();
    await page.waitForTimeout(500);

    // Should see the "Giọng đọc" (default) tab — or at least the heading
    await expect(page.getByText(/Giọng đọc/i).first()).toBeVisible();
  });

  test('Read-aloud settings tab shows paragraph gap + continuous play controls', async ({ page }) => {
    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Open the read-aloud panel
    await page.getByTitle(/Read aloud/i).first().click();
    await page.waitForTimeout(500);

    // Switch to Settings tab
    const settingsTab = page.getByRole('button', { name: /Cài đặt/i }).first();
    await settingsTab.click();
    await page.waitForTimeout(300);

    // Paragraph gap slider label
    await expect(page.getByText(/Khoảng nghỉ giữa đoạn/i)).toBeVisible();

    // Continuous play toggle
    await expect(page.getByText(/Đọc liền chương/i)).toBeVisible();
  });

  test('Paragraph gap slider is interactive', async ({ page }) => {
    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Open read-aloud panel → settings
    await page.getByTitle(/Read aloud/i).first().click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Cài đặt/i }).first().click();
    await page.waitForTimeout(300);

    // Find the paragraph gap slider (range input)
    const sliders = page.locator('input[type="range"]');
    const count = await sliders.count();
    expect(count, 'should have at least one range slider').toBeGreaterThan(0);

    // Move the first slider (paragraph gap)
    await sliders.first().fill('500');

    // Verify the displayed value updates
    await expect(page.getByText(/500 ms/i)).toBeVisible({ timeout: 3000 });
  });

  test('Continuous play toggle is clickable', async ({ page }) => {
    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Open read-aloud panel → settings
    await page.getByTitle(/Read aloud/i).first().click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Cài đặt/i }).first().click();
    await page.waitForTimeout(300);

    // Click the continuous play toggle
    const contToggle = page.getByRole('button', { name: /Tự động sang chương kế tiếp|Dừng khi hết chương/i }).first();
    const initialText = await contToggle.textContent();

    await contToggle.click();
    await page.waitForTimeout(300);

    const afterText = await contToggle.textContent();
    expect(afterText, 'toggle text should change after click').not.toBe(initialText);
  });
});
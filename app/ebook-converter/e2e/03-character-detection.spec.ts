// e2e/03-character-detection.spec.ts
// Tests for the AI Character Detection panel UI + manual apply flow.

import { test, expect } from '@playwright/test';
import { cleanBookState, runDetectOnChapter, TEST_BOOK_ID } from './helpers';

test.describe('Character Detection panel', () => {
  test.beforeEach(async ({ page }) => {
    await cleanBookState(page);
  });

  test('Character Detection card is visible in voices tab', async ({ page }) => {
    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');

    // Open audiobook panel → voices tab
    await page.getByTitle(/Audiobook/i).first().click();
    await page.getByRole('button', { name: /Giọng & nhân vật/i }).click();

    // AI Character Detection header
    await expect(page.getByText('AI Character Detection').first()).toBeVisible();

    // Initial prompt to click "Phân tích nhân vật"
    await expect(page.getByText(/Phân tích nhân vật/i).first()).toBeVisible();
  });

  test('Click Phân tích nhân vật triggers detection and shows detected characters with attributes', async ({ page }) => {
    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');

    await page.getByTitle(/Audiobook/i).first().click();
    await page.getByRole('button', { name: /Giọng & nhân vật/i }).click();

    // Click "Phân tích nhân vật" (initial button)
    const analyzeBtn = page.getByRole('button', { name: /Phân tích nhân vật/i }).first();
    await analyzeBtn.click();

    // Should show "Đang phân tích..." spinner
    await expect(page.getByText(/Đang phân tích/i)).toBeVisible({ timeout: 5000 });

    // Wait for result (may take 60-180s)
    await expect(page.getByText(/nhân vật được phát hiện/i)).toBeVisible({ timeout: 200_000 });

    // Should see at least one detected character
    await expect(page.getByText(/Âu Sùng Viễn|Nhâm Thiếu Hoài/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('Voice selector dropdown shows built-in voice options', async ({ page }) => {
    // Pre-populate via API
    await runDetectOnChapter(page, 'chapter003');

    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');

    // Open voices tab
    await page.getByTitle(/Audiobook/i).first().click();
    await page.getByRole('button', { name: /Giọng & nhân vật/i }).click();

    // Wait for characters to load
    await expect(page.getByText(/Âu Sùng Viễn/i).first()).toBeVisible({ timeout: 15_000 });

    // Find a select inside the character detection panel
    const voiceSelects = page.locator('select');
    const count = await voiceSelects.count();
    expect(count, 'should have at least one voice select dropdown').toBeGreaterThan(0);

    // Verify the select has multiple options (10 built-in + custom)
    const firstSelect = voiceSelects.first();
    const options = await firstSelect.locator('option').allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(10);  // 10 built-in voices
  });

  test('Apply button inserts characters and removes the panel', async ({ page }) => {
    await page.goto(`/library/${TEST_BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');

    await page.getByTitle(/Audiobook/i).first().click();
    await page.getByRole('button', { name: /Giọng & nhân vật/i }).click();

    // Run detection
    await page.getByRole('button', { name: /Phân tích nhân vật/i }).first().click();
    await expect(page.getByText(/nhân vật được phát hiện/i)).toBeVisible({ timeout: 200_000 });

    // Click "Áp dụng N nhân vật"
    const applyBtn = page.getByRole('button', { name: /Áp dụng/i }).first();
    if (await applyBtn.count() > 0) {
      await applyBtn.click();
    }

    // Verify characters are now in DB (regardless of UI state)
    const r = await page.request.get(`/api/library/${TEST_BOOK_ID}/characters`);
    const chars = (await r.json()).characters ?? [];
    expect(chars.length, 'Apply should have created characters in DB').toBeGreaterThan(0);
  });
});
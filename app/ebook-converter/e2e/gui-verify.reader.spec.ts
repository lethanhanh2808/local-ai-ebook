// e2e/gui-verify.reader.spec.ts
// Self-verification of the reader redesign. Opens the reader, exercises the
// key control groups (TOC, audio, settings, mobile overflow), and captures
// screenshots into test-results/gui-shots so they can be reviewed in the
// VS Code Playwright Test Explorer.
//
// Run via the Test Explorer (uses playwright.gui.config.ts) or:
//   npx playwright test --config playwright.gui.config.ts
//
// Requires the dev server on :3100 (npm run dev) and a book with chapters.
// Auth uses the default local admin account (admin / admin123).
import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
// Reuse the book seeded for verification (see scripts/verify-reader-gui.mjs).
const BOOK_ID = process.env.E2E_BOOK_ID ?? '593bd59a-834a-406a-b9c5-db3ca8f7528c';
const SHOT_DIR = path.resolve(__dirname, '../test-results/gui-shots');

async function loginAsAdmin(page: import('@playwright/test').Page) {
  const api = page.context().request;
  const res = await api.post(`${BASE_URL}/api/auth/login`, {
    data: { username: 'admin', password: 'admin123' },
    headers: { 'Content-Type': 'application/json' },
  });
  const setCookie = res.headers()['set-cookie'];
  const match = setCookie?.match(/ebook-auth-session=([^;]+)/);
  if (match) {
    await page.context().addCookies([
      { name: 'ebook-auth-session', value: match[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
  }
}

async function openReader(page: import('@playwright/test').Page) {
  await loginAsAdmin(page);
  await page.goto(`${BASE_URL}/library/${BOOK_ID}/read`, { waitUntil: 'domcontentloaded' });
  await page.locator('iframe[title]').first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Table of Contents' }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

test.describe('Reader GUI verification', () => {
  test.beforeAll(() => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
  });

  // Desktop-only control groups are hidden below the `md:` breakpoint, so
  // skip these specs on the mobile project.
  const isMobile = ({ viewport }: { viewport?: { width: number; height: number } }) =>
    (viewport?.width ?? 0) < 768;

  test('desktop: default layout', async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.use as { viewport?: { width: number; height: number } }));
    await openReader(page);
    await expect(page.getByRole('button', { name: 'Audio, đọc thành tiếng và giọng' })).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-default.png') });
  });

  test('desktop: TOC panel open', async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.use as { viewport?: { width: number; height: number } }));
    await openReader(page);
    await page.getByRole('button', { name: 'Table of Contents' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-toc.png') });
  });

  test('desktop: audio panel open', async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.use as { viewport?: { width: number; height: number } }));
    await openReader(page);
    await page.getByRole('button', { name: 'Audio, đọc thành tiếng và giọng' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-audio.png') });
  });

  test('desktop: settings panel open', async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.use as { viewport?: { width: number; height: number } }));
    await openReader(page);
    await page.getByRole('button', { name: 'Cài đặt trình đọc' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-settings.png') });
  });

  test('mobile: default + overflow menu', async ({ page }, testInfo) => {
    test.skip(!(testInfo.project.use as { viewport?: { width: number; height: number } })?.viewport?.width || (testInfo.project.use as { viewport?: { width: number; height: number } }).viewport!.width >= 768);
    await openReader(page);
    await page.screenshot({ path: path.join(SHOT_DIR, 'mobile-default.png') });
    const more = page.getByRole('button', { name: 'Mở menu công cụ khác' });
    if (await more.count()) {
      await more.first().click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOT_DIR, 'mobile-menu.png') });
    }
  });
});

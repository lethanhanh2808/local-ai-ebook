// GUI self-verification for the reader redesign.
// Signs in with the local admin account, loads the reader, exercises key
// controls, and captures screenshots. Uses system Google Chrome via
// Playwright's `channel: 'chrome'`.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BOOK_ID = '593bd59a-834a-406a-b9c5-db3ca8f7528c';
const BASE = 'http://localhost:3100';
const OUT = new URL('../data/verify-shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const errors = [];

const browser = await chromium.launch({ channel: 'chrome' });

async function newSession(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${width}x${height}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${width}x${height}] pageerror: ${e.message}`));
  // Authenticate via the API and inject the session cookie (the SPA login
  // uses a client-side fetch + router.replace, which is racy to wait on).
  const api = await page.context().request;
  const res = await api.post(`${BASE}/api/auth/login`, {
    data: { username: 'admin', password: 'admin123' },
    headers: { 'Content-Type': 'application/json' },
  });
  const setCookie = res.headers()['set-cookie'];
  if (setCookie) {
    const match = setCookie.match(/ebook-auth-session=([^;]+)/);
    if (match) {
      await ctx.addCookies([{
        name: 'ebook-auth-session',
        value: match[1],
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      }]);
    }
  }
  return { ctx, page };
}

async function shot(name, width, height, steps) {
  const { ctx, page } = await newSession(width, height);
  await page.goto(`${BASE}/library/${BOOK_ID}/read`, { waitUntil: 'domcontentloaded' });
  // The reader shows the EPUB's internal title, not the DB title, so wait
  // on stable shell elements: the chapter iframe + the TOC toggle button.
  await page.locator('iframe[title]').first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Table of Contents' }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  if (steps) await steps(page);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
  await ctx.close();
  console.log(`captured ${name} (${width}x${height})`);
}

// 1. Desktop default
await shot('desktop-default', 1440, 900);

// 2. Desktop with TOC open
await shot('desktop-toc', 1440, 900, async (page) => {
  await page.getByRole('button', { name: 'Table of Contents' }).click();
  await page.waitForTimeout(500);
});

// 3. Desktop with Audio panel open
await shot('desktop-audio', 1440, 900, async (page) => {
  await page.getByRole('button', { name: 'Audio, đọc thành tiếng và giọng' }).click();
  await page.waitForTimeout(600);
  const tab = page.getByRole('tab', { name: 'Read aloud', exact: true });
  if (await tab.count()) await tab.first().click();
  await page.waitForTimeout(400);
});

// 4. Desktop with Settings open
await shot('desktop-settings', 1440, 900, async (page) => {
  await page.getByRole('button', { name: 'Cài đặt trình đọc' }).click();
  await page.waitForTimeout(500);
});

// 5. Mobile (iPhone-ish) default
await shot('mobile-default', 390, 844);

// 6. Mobile with overflow menu open
await shot('mobile-menu', 390, 844, async (page) => {
  const more = page.getByRole('button', { name: 'Mở menu công cụ khác' });
  if (await more.count()) {
    await more.first().click();
    await page.waitForTimeout(400);
  }
});

await browser.close();

console.log('\n=== Console / page errors ===');
if (errors.length === 0) console.log('none');
else errors.forEach((e) => console.log(e));
console.log(`\nScreenshots written to ${OUT}`);

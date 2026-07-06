// /tmp/smoke-test.ts — visual smoke for bible refresh modal + audio panel resize
//
// Run from /Volumes/EXT-SSD/Users/anhl/Local-AI/app/ebook-converter with:
//   ./node_modules/.bin/playwright test --reporter=list /dev/stdin < /tmp/smoke-test.ts
// or via tsx:
//   ./node_modules/.bin/tsx /tmp/smoke-test.ts
//
// Targets http://localhost:13100 (the running production container).

import { chromium } from '@playwright/test';

const BASE = 'http://localhost:13100';
const OUT  = '/tmp/smoke-out';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const themes: Array<{ name: string; dark: boolean }> = [
  { name: 'light', dark: false },
  { name: 'dark',  dark: true  },
];

(async () => {
const browser = await chromium.launch();

// Find a real book via a direct fetch (helper requires page.request with baseURL).
const ctx0 = await browser.newContext({ baseURL: BASE });
const page0 = await ctx0.newPage();
const probe = await page0.request.get('/api/library?limit=10');
if (!probe.ok()) {
  console.error(`/api/library returned ${probe.status()}`);
  process.exit(1);
}
const books = await probe.json() as Array<{ id: string; title: string }>;
await ctx0.close();

if (books.length === 0) {
  console.error('No books found — cannot smoke-test reader UI');
  process.exit(1);
}

const book = books[0];
console.log(`Using book: ${book.title} (id=${book.id})`);

for (const t of themes) {
  const ctx = await browser.newContext({
    colorScheme: t.dark ? 'dark' : 'light',
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript((dark) => {
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    } catch {}
  }, t.dark);
  const page = await ctx.newPage();

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('localhost:3100')) return; // ignore dev server noise
    errors.push(`requestfailed: ${url} ${req.failure()?.errorText ?? ''}`);
  });

  console.log(`\n=== ${t.name} mode ===`);
  await page.goto(`${BASE}/library/${book.id}/read`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Open the audio drawer (headphones toggle).
  await page.getByRole('button', { name: /Audio|Headphones/i }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/01-reader-${t.name}.png`, fullPage: false });

  // Switch to "Nhân vật" tab (where Character Bible + Detection live).
  await page.getByRole('button', { name: /^Nhân vật$/i }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/02-characters-tab-${t.name}.png`, fullPage: false });

  // Then visit "Giọng" tab to confirm the split.
  await page.getByRole('button', { name: /^Giọng$/i }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/03-voices-tab-${t.name}.png`, fullPage: false });

  // Back to Nhân vật to open the bible refresh modal.
  await page.getByRole('button', { name: /^Nhân vật$/i }).first().click().catch(() => {});
  await page.waitForTimeout(800);

  // Open the bible refresh modal.
  const refresh = page.getByRole('button', { name: /^Refresh$/i }).first();
  if (await refresh.count()) {
    await refresh.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/04-bible-modal-${t.name}.png`, fullPage: false });

    // Look for the Process button.
    const proc = page.getByRole('button', { name: /Process/i }).first();
    const procVisible = await proc.count() > 0;
    const procDisabled = await proc.isDisabled().catch(() => true);
    console.log(`  bible modal: Process button present=${procVisible} disabled=${procDisabled}`);

    // Close modal for next theme's clean screenshot.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  } else {
    console.log(`  bible modal: Refresh button not found in ${t.name} mode`);
  }

  // Check audio panel width.
  const drawerWidth = await page.evaluate(() => {
    const a = document.querySelector('aside.z-20');
    return a ? (a as HTMLElement).offsetWidth : 0;
  });
  console.log(`  audio drawer width: ${drawerWidth}px`);

  // Page-level error sanity.
  if (errors.length > 0) {
    console.log(`  console errors:`);
    errors.forEach((e) => console.log(`    - ${e}`));
  } else {
    console.log(`  no console errors`);
  }

  await ctx.close();
}

await browser.close();
console.log(`\nScreenshots written to ${OUT}/`);
})().catch((e) => { console.error(e); process.exit(1); });


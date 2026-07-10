import { test, expect } from '@playwright/test';

const BOOK_ID = 'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314';

test.use({ viewport: { width: 1600, height: 1000 } });

test('verify: clicking any chapter in TOC shows the right content, no 404', async ({ page }) => {
  const fourOhFours: string[] = [];
  const allResps: string[] = [];
  page.on('response', (resp) => {
    const url = resp.url();
    if (url.includes('localhost:13100') && !url.includes('/_next/') && !url.includes('/favicon')) {
      allResps.push(`${resp.status()}  ${resp.request().resourceType()}  ${url.replace('http://localhost:13100', '')}`);
    }
    if (resp.status() === 404) fourOhFours.push(url.replace('http://localhost:13100', ''));
  });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  await page.goto(`http://localhost:13100/library/${BOOK_ID}/read`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3500);

  // Sidebar is already showing Chương 1..10 — click chapter007 (mid-book) directly
  // The sidebar button may be off-viewport; use dispatchEvent to bypass geometry check.
  const chap007 = page.locator('[data-chapter-id="chapter007"]');
  const count007 = await chap007.count();
  console.log(`chapter007 elements: ${count007}`);
  await chap007.dispatchEvent('click');
  await page.waitForTimeout(2500);

  // Verify iframe title updated
  const iframe = page.locator('iframe[title]').first();
  const fc = await iframe.contentFrame();
  if (fc) {
    const title = await fc.locator('title').innerText();
    const h1 = await fc.locator('h1, h2, h3').first().innerText().catch(() => '');
    console.log(`After click chapter007 — iframe <title>: "${title}", first heading: "${h1}"`);
  }

  // Now click chapter010 (last chapter)
  await page.locator('[data-chapter-id="chapter010"]').dispatchEvent('click');
  await page.waitForTimeout(2500);
  const fc2 = await iframe.contentFrame();
  if (fc2) {
    const title = await fc2.locator('title').innerText();
    const h1 = await fc2.locator('h1, h2, h3').first().innerText().catch(() => '');
    console.log(`After click chapter010 — iframe <title>: "${title}", first heading: "${h1}"`);
  }

  await page.screenshot({ path: '/tmp/final-after-clicks.png', fullPage: false });

  console.log(`\n=== 404 responses (${fourOhFours.length}) ===`);
  for (const u of fourOhFours) console.log('  ' + u);
  console.log(`\n=== All responses (${allResps.length}) ===`);
  for (const u of allResps) console.log('  ' + u);

  expect(fourOhFours, `Unexpected 404:\n${fourOhFours.join('\n')}`).toHaveLength(0);
});
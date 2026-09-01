import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:3100/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
// Dump all input/button labels and roles
const inputs = await page.locator('input').evaluateAll(els => els.map(e => ({type:e.type, name:e.name, id:e.id, placeholder:e.placeholder, aria:e.getAttribute('aria-label')})));
console.log('INPUTS:', JSON.stringify(inputs, null, 2));
const buttons = await page.locator('button').evaluateAll(els => els.map(e => e.textContent?.trim()));
console.log('BUTTONS:', JSON.stringify(buttons));
await browser.close();

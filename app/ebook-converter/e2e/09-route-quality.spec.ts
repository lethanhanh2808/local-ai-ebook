// Non-mutating production-surface regression coverage.
//
// Every user-facing route is opened at desktop and mobile sizes. The check is
// deliberately small and deterministic: navigation must succeed, React must
// not log errors, APIs must not return 5xx while the page settles, and the
// document must not leak content beyond the viewport horizontally.

import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';

interface LibraryBook { id: string }
interface Shelf { id: string }
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';

async function discoverRoutes(request: APIRequestContext): Promise<string[]> {
  const routes = ['/', '/convert', '/library', '/shelves', '/stats', '/settings'];

  const libraryResponse = await request.get('/api/library?limit=1');
  expect(libraryResponse.ok(), 'library route discovery').toBe(true);
  const books = await libraryResponse.json() as LibraryBook[];
  if (books[0]?.id) {
    routes.push(
      `/library/${books[0].id}`,
      `/library/${books[0].id}/read`,
      `/library/${books[0].id}/edit`,
    );
  }

  const shelvesResponse = await request.get('/api/shelves');
  expect(shelvesResponse.ok(), 'shelf route discovery').toBe(true);
  const shelves = await shelvesResponse.json() as Shelf[];
  if (shelves[0]?.id) routes.push(`/shelves/${shelves[0].id}`);

  return routes;
}

async function auditRoutes(
  browser: Browser,
  routes: string[],
  viewport: { width: number; height: number },
) {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport, colorScheme: 'light' });
  const failures: string[] = [];

  try {
    for (const route of routes) {
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const serverErrors: string[] = [];
      const pageErrors: string[] = [];

      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('response', (response) => {
        if (response.status() >= 500) {
          serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
        }
      });

      try {
        const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
        if (!response?.ok()) failures.push(`${route}: navigation returned ${response?.status() ?? 'no response'}`);
        await page.waitForTimeout(route.endsWith('/read') ? 2_000 : 750);

        const overflow = await page.evaluate(() => {
          const root = document.documentElement;
          const body = document.body;
          return Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
        });
        if (overflow > 2) failures.push(`${route}: document overflows viewport by ${overflow}px`);
      } catch (error) {
        failures.push(`${route}: ${error instanceof Error ? error.message : String(error)}`);
      }

      for (const message of consoleErrors) failures.push(`${route}: console.error: ${message}`);
      for (const message of pageErrors) failures.push(`${route}: page error: ${message}`);
      for (const message of serverErrors) failures.push(`${route}: server error: ${message}`);
      await page.close();
    }
  } finally {
    await context.close();
  }

  expect(failures, failures.join('\n')).toEqual([]);
}

test.describe('All user-facing routes', () => {
  test('render cleanly on desktop', async ({ browser, request }) => {
    await auditRoutes(browser, await discoverRoutes(request), { width: 1440, height: 900 });
  });

  test('render without document overflow on mobile', async ({ browser, request }) => {
    await auditRoutes(browser, await discoverRoutes(request), { width: 390, height: 844 });
  });

  test('theme selection persists across reloads', async ({ page }) => {
    await page.goto('/');
    const enableDark = page.getByRole('button', { name: /Chuyển sang giao diện tối/i });
    await expect(enableDark).toBeVisible();
    await enableDark.click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    const enableLight = page.getByRole('button', { name: /Chuyển sang giao diện sáng/i });
    await enableLight.click();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  });

  test('mobile navigation opens, closes, and changes routes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const menu = page.getByRole('button', { name: 'Open menu', exact: true });
    await menu.click();
    const mobileNav = page.getByRole('navigation', { name: 'Mobile' });
    await expect(mobileNav).toBeVisible();
    await mobileNav.getByRole('link', { name: 'Settings', exact: true }).click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(mobileNav).toBeHidden();
  });
});

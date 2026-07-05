import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';

/**
 * Playwright E2E config for the ebook-converter app.
 * Verifies the full voice management pipeline + UI flows.
 *
 * Day-to-day:
 *   npm run test:e2e:local:smoke
 * Full local stack:
 *   ../../scripts/start_full_app.sh --background
 *   npm run test:e2e:local
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,  // tests share DB state — run sequentially
  workers: 1,
  retries: 0,
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results/e2e-artifacts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: process.env.E2E_SKIP_WEB_SERVER === '1'
    ? undefined
    : {
        command: 'npm run dev',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use a fresh storage state per test for isolation
        storageState: undefined,
      },
    },
  ],
});

// playwright.gui.config.ts
// Standalone Playwright config for GUI self-verification of the reader
// redesign. Uses the system Google Chrome (via channel: 'chrome') so no
// Playwright browser download is required, and only runs the gui-verify
// specs. Shows up in VS Code's Playwright Test Explorer when this config
// is selected.
//
// Prereqs:
//   - dev server running on :3100 (npm run dev)
//   - a book with chapters seeded (scripts/verify-reader-gui.mjs registers one)
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results/gui-artifacts',
  use: {
    baseURL,
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  // Only run the GUI verification specs.
  testMatch: /gui-verify\.reader\.spec\.ts/,
  projects: [
    {
      name: 'gui-chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'gui-mobile',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});

// e2e/playback-e2e.spec.ts
// Targeted e2e for the read-aloud playback audit (B1-B3, S1-S6).
// Verifies the reader can actually synthesize + play Vietnamese speech
// via the freshly-rebuilt container.

import { test, expect } from '@playwright/test';

const BOOK_ID = process.env.E2E_BOOK_ID ?? 'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314';

test.describe('Read-aloud playback pipeline (B+S audit)', () => {
  test('service APIs healthy', async ({ page }) => {
    const lib = await page.request.get('/api/library?limit=1');
    expect(lib.ok()).toBe(true);

    const health = await page.request.get('/api/tts/health');
    expect(health.ok()).toBe(true);
    const h = await health.json();
    expect(h.ok).toBe(true);
    expect(h.services.vieneu).toBe(true);
  });

  test('TTS preview returns valid WAV with Xuân Vĩnh (default voice)', async ({ page }) => {
    const r = await page.request.post('/api/tts/preview', {
      headers: { 'Content-Type': 'application/json' },
      data: { voice: 'Xuân Vĩnh', text: 'Xin chào bạn đọc, đây là giọng Xuân Vĩnh.', language: 'vi', speed: 1.0 },
      timeout: 60_000,
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('audio/wav');
    const body = await r.body();
    const buf = body ? Buffer.from(body) : null;
    expect(buf?.byteLength).toBeGreaterThan(1000);
    expect(buf?.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf?.slice(8, 12).toString('ascii')).toBe('WAVE');
    // The voice actually used is echoed back via header on /api/tts (not preview)
  });

  test('TTS speak returns audio for a real paragraph', async ({ page }) => {
    // Use chapter001 text via the reader flow; just synthesize directly here.
    const r = await page.request.post('/api/tts', {
      headers: { 'Content-Type': 'application/json' },
      data: {
        text: 'Hắn rút kiếm chém xuống, thanh âm vang dội cả góc trời.',
        bookId: BOOK_ID,
        voice: 'Xuân Vĩnh',
        language: 'vi',
        speed: 1.0,
      },
      timeout: 60_000,
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('audio/wav');
    const body = await r.body();
    expect(body?.byteLength).toBeGreaterThan(1000);
  });

  test('chapter has parsed paragraphs available for TTS prefetch', async ({ page }) => {
    const r = await page.request.get(`/api/library/${BOOK_ID}/chapters`);
    expect(r.ok()).toBe(true);
    const chapters = await r.json();
    expect(Array.isArray(chapters)).toBe(true);
    expect(chapters.length).toBeGreaterThan(2);
  });

  test('reader page renders and exposes read-aloud controls', async ({ page }) => {
    await page.goto(`/library/${BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    // The reader title should be in the chrome
    await expect(page.locator('iframe[title]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Audio, đọc thành tiếng và giọng/i })).toBeVisible({ timeout: 15_000 });
    // Services ready chip
    await expect(page.getByText(/Services ready/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('opening read-aloud panel shows the 10 VieNeu voices + Xuân Vĩnh as default', async ({ page }) => {
    await page.goto(`/library/${BOOK_ID}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: /Audio, đọc thành tiếng và giọng/i }).click();
    // Wait for the panel to slide in
    await expect(page.getByText(/GIỌNG MẶC ĐỊNH/i).first()).toBeVisible({ timeout: 15_000 });
    // Xuân Vĩnh must be marked as "ĐANG DÙNG" (in use)
    await expect(page.getByText(/ĐANG DÙNG/i).first()).toBeVisible();
    // All 10 catalog voices should appear
    for (const name of ['Trúc Ly', 'Ngọc Linh', 'Đoan Trang', 'Mai Anh', 'Thục Đoan', 'Phạm Tuyên', 'Xuân Vĩnh', 'Thái Sơn', 'Thanh Bình', 'Minh Đức']) {
      await expect(page.getByText(name).first()).toBeVisible();
    }
  });
});

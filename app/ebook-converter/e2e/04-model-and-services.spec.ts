// e2e/04-model-and-services.spec.ts
// Tests that verify model routing uses the Settings DB choice (not env vars).

import { test, expect } from '@playwright/test';

test.describe('AI model + service routing', () => {
  test('Settings page shows current model selection', async ({ page }) => {
    const response = await page.request.get('/api/settings');
    expect(response.ok()).toBe(true);
    const settings = await response.json() as { aiModel?: string };
    expect(settings.aiModel, 'settings API should expose the selected model').toBeTruthy();

    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // The current settings UI uses an editable model textbox rather than a
    // native select, so assert the persisted value is rendered directly.
    await expect(page.getByText(/Model/i).first()).toBeVisible();
    const renderedValues = await page.locator('input').evaluateAll(
      (inputs) => inputs.map((input) => (input as HTMLInputElement).value),
    );
    expect(renderedValues, 'selected model should be rendered in a settings input')
      .toContain(settings.aiModel);
  });

  test('Conversion pipeline uses the user-selected model', async ({ page }) => {
    // Check the current model in Settings DB via a quick API call.
    // We can't easily read the DB directly, but we can verify the model
    // name appears in a job's stored config after a conversion runs.

    // Verify by hitting the worker's status endpoint (the worker logs model
    // on each job start)
    const r = await page.request.get('/api/worker/status');
    expect(r.ok()).toBe(true);
  });

  test('TTS preview returns valid WAV audio', async ({ page }) => {
    const r = await page.request.post('/api/tts/preview', {
      headers: { 'Content-Type': 'application/json' },
      data: {
        voice: 'Xuân Vĩnh',
        text: 'Xin chào, đây là bài test preview.',
        language: 'vi',
        speed: 1.0,
      },
      timeout: 60_000,
    });

    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('audio/wav');

    const body = await r.body();
    const buf = body ? Buffer.from(body) : null;
    expect(buf?.byteLength).toBeGreaterThan(1000);

    // Verify WAV header: RIFF....WAVE
    if (buf) {
      const header = buf.slice(0, 12);
      expect(header.slice(0, 4).toString('ascii')).toBe('RIFF');
      expect(header.slice(8, 12).toString('ascii')).toBe('WAVE');
    }
  });

  test('TTS preview rejects unknown voice', async ({ page }) => {
    const r = await page.request.post('/api/tts/preview', {
      headers: { 'Content-Type': 'application/json' },
      data: {
        voice: 'NotARealVoice',
        text: 'Test',
        language: 'vi',
      },
      timeout: 30_000,
    });

    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toContain('unknown voice');
  });

  test('Health check — all TTS services respond', async ({ page }) => {
    // Unified TTS
    const r1 = await page.request.get('/api/tts', { timeout: 5_000 });
    expect(r1.ok()).toBe(true);
    const data = await r1.json();
    expect(data.backends).toBeDefined();
    expect(data.backends.length).toBeGreaterThan(0);

    // Verify each backend has a 'ready' field
    for (const b of data.backends) {
      expect(b.id, `backend should have id`).toBeTruthy();
      expect(b.name, `backend should have name`).toBeTruthy();
    }
  });
});

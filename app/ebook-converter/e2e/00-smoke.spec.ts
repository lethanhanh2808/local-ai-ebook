// e2e/00-smoke.spec.ts
// Fast service + GUI smoke tests for day-to-day validation.
//
// These tests intentionally avoid mutating book data. They verify that the
// local stack is alive, the GUI renders key workflows, and the reader exposes
// read-aloud/audiobook controls.

import { test, expect } from '@playwright/test';
import { getBookChapters, listLibraryBooks, resolveTestBook } from './helpers';

test.describe('Local app smoke + GUI validation', () => {
  test('service APIs expose a healthy local stack', async ({ page }) => {
    const library = await page.request.get('/api/library?limit=1');
    expect(library.ok(), 'library API should respond').toBe(true);
    expect(await library.json()).toEqual(expect.any(Array));

    const worker = await page.request.get('/api/worker/status');
    expect(worker.ok(), 'worker status API should respond').toBe(true);
    const workerJson = await worker.json();
    expect(workerJson.redis, 'Redis should be reachable through worker status').toBe(true);

    const ttsHealth = await page.request.get('/api/tts/health');
    expect(ttsHealth.ok(), 'TTS health API should respond with a ready stack').toBe(true);
    const ttsHealthJson = await ttsHealth.json();
    expect(ttsHealthJson.ok, 'TTS health should report ready').toBe(true);
    expect(ttsHealthJson.services?.vieneu, 'VieNeu should be ready through TTS health').toBe(true);

    const tts = await page.request.get('/api/tts');
    expect(tts.ok(), 'TTS backend list should respond').toBe(true);
    const ttsJson = await tts.json();
    expect(ttsJson.backends, 'TTS response should include backends').toEqual(expect.any(Array));
    expect(
      ttsJson.backends.some((b: { id: string; ready?: boolean }) => b.id === 'vieneu' && b.ready),
      'VieNeu should be ready for Vietnamese read-aloud',
    ).toBe(true);
  });

  test('dashboard, converter, and library pages render the core GUI', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/Dashboard/i).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Thêm sách/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Mở thư viện/i })).toBeVisible();

    await page.goto('/convert');
    await expect(page.getByText(/Drop ebooks here or click to browse/i)).toBeVisible();
    await expect(page.getByText(/EPUB · HTML · TXT/i)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/PDF|DOCX|MOBI|AZW3/);

    await page.goto('/library');
    await expect(page.getByText(/Tất cả sách/i).first()).toBeVisible();
    await expect(page.getByPlaceholder(/Search title, author, series/i)).toBeVisible();

    await page.goto('/settings');
    await page.getByRole('tab', { name: 'TTS', exact: true }).click();
    await expect(page.getByText(/Local service health/i).first()).toBeVisible();
    await expect(page.getByText(/Vietnamese Voice/i).first()).toBeVisible();
  });

  test('reader opens a real book and exposes read-aloud controls', async ({ page }) => {
    const book = await resolveTestBook(page);
    const chapters = await getBookChapters(page, book.id);
    test.skip(chapters.length === 0, `Book ${book.id} has no parsed chapters`);

    await page.goto(`/library/${book.id}/read`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText(book.title).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('iframe[title]').first()).toBeVisible({ timeout: 15_000 });

    const audioButton = page.getByRole('button', { name: /Audio, đọc thành tiếng và giọng/i });
    await expect(audioButton).toBeVisible();
    await audioButton.click();

    await expect(page.getByRole('tab', { name: 'Read aloud', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Giọng đọc/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Cài đặt/i }).first()).toBeVisible();
  });

  test('reader exposes audiobook and voice-management panels', async ({ page }) => {
    const books = await listLibraryBooks(page, 10);
    test.skip(books.length === 0, 'No books found in local library');
    const book = books[0];

    await page.goto(`/library/${book.id}/read`);
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: /Audio, đọc thành tiếng và giọng/i }).click();
    await page.getByRole('tab', { name: 'Audiobook', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Audiobook đọc trước/i })).toBeVisible();

    await page.getByRole('tab', { name: 'Nhân vật', exact: true }).click();
    await expect(page.getByText(/AI Character Detection/i).first()).toBeVisible();

    const voiceCommandButton = page.getByTitle(/lệnh giọng nói|không hỗ trợ nhận lệnh/i).first();
    await expect(voiceCommandButton).toBeVisible();
  });

  test('basic EPUB editor opens a real chapter without mutating the book', async ({ page }) => {
    const book = await resolveTestBook(page);
    const chapters = await getBookChapters(page, book.id);
    test.skip(chapters.length === 0, `Book ${book.id} has no parsed chapters`);

    await page.goto(`/library/${book.id}/edit`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText(book.title).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(/Chapter title/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save as a new edited copy', exact: true })).toBeEnabled();
  });

  test('audiobook player exposes resume, bookmark, and sleep-timer controls when audio is ready', async ({ page }) => {
    const books = await listLibraryBooks(page, 20);
    test.skip(books.length === 0, 'No books found in local library');

    let selected: { id: string; title: string } | null = null;
    for (const book of books) {
      const r = await page.request.get(`/api/library/${book.id}/audiobook`);
      if (!r.ok()) continue;
      const data = await r.json();
      if ((data.summary?.ready ?? 0) > 0) {
        selected = book;
        break;
      }
    }
    test.skip(!selected, 'No book has ready pre-generated audiobook chapters');

    await page.goto(`/library/${selected!.id}/read`);
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: /Audio, đọc thành tiếng và giọng/i }).click();
    await page.getByRole('tab', { name: 'Audiobook', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Audiobook đọc trước/i })).toBeVisible();

    const listenButton = page.getByRole('button', { name: /Nghe audiobook/i }).first();
    await expect(listenButton).toBeVisible({ timeout: 15_000 });
    await listenButton.click();

    await expect(page.getByTitle(/Đánh dấu thời điểm/i)).toBeVisible();
    await expect(page.getByTitle(/Nghe lại từ đầu/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Sleep timer 15 minutes/i })).toBeVisible();
  });
});

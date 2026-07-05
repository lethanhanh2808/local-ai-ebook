// e2e/helpers.ts
// Shared helpers for the voice management E2E tests.

import { Page, expect } from '@playwright/test';

const DEFAULT_BOOK_ID = 'ffa65ac0-4010-40ea-9239-2fcea39c848f';
const BOOK_ID = process.env.E2E_BOOK_ID ?? DEFAULT_BOOK_ID;

export interface E2EBook {
  id: string;
  title: string;
  author: string;
  language: string;
}

export interface E2EChapter {
  id: string;
  title: string;
  order: number;
}

export async function listLibraryBooks(page: Page, limit = 20): Promise<E2EBook[]> {
  const r = await page.request.get(`/api/library?limit=${limit}`);
  expect(r.ok(), `GET /api/library should succeed`).toBe(true);
  return await r.json() as E2EBook[];
}

export async function resolveTestBook(page: Page): Promise<E2EBook> {
  const books = await listLibraryBooks(page, 50);
  if (books.length === 0) {
    throw new Error(
      'No books found in the local library. Upload/convert at least one EPUB/HTML/TXT book before running GUI E2E tests.',
    );
  }
  return books.find((b) => b.id === BOOK_ID) ?? books[0];
}

export async function getBookChapters(page: Page, bookId: string): Promise<E2EChapter[]> {
  const r = await page.request.get(`/api/library/${bookId}/chapters`);
  expect(r.ok(), `GET /api/library/${bookId}/chapters should succeed`).toBe(true);
  return await r.json() as E2EChapter[];
}

export async function cleanBookState(page: Page, bookId = BOOK_ID) {
  // Delete all characters and voices via the API directly so each test
  // starts from a clean slate.
  const r1 = await page.request.get(`/api/library/${bookId}/characters`);
  const chars = await r1.json();
  for (const c of (chars.characters ?? [])) {
    await page.request.delete(`/api/library/${bookId}/characters?id=${c.id}`);
  }
  const r2 = await page.request.get(`/api/library/${bookId}/voices`);
  const voices = await r2.json();
  for (const v of (voices.voices ?? [])) {
    await page.request.delete(`/api/library/${bookId}/voices?voiceId=${v.id}`);
  }
}

export async function getCharacters(page: Page, bookId = BOOK_ID): Promise<Array<{ id: string; name: string; role?: string; age?: string | null; voice?: { name: string; builtinName?: string | null } | null }>> {
  const r = await page.request.get(`/api/library/${bookId}/characters`);
  return (await r.json()).characters ?? [];
}

export async function getVoices(page: Page, bookId = BOOK_ID): Promise<Array<{ id: string; name: string; kind?: string; builtinName?: string | null }>> {
  const r = await page.request.get(`/api/library/${bookId}/voices`);
  return (await r.json()).voices ?? [];
}

export async function runDetectOnChapter(page: Page, chapterId: string, opts: { timeout?: number; bookId?: string } = {}) {
  const bookId = opts.bookId ?? BOOK_ID;
  const r = await page.request.post(`/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/detect-characters`, {
    headers: { 'Content-Type': 'application/json' },
    data: { language: 'vi' },
    timeout: opts.timeout ?? 180_000,
  });
  if (!r.ok()) {
    throw new Error(`detect failed for ${chapterId}: ${r.status()} ${await r.text()}`);
  }
  return r.json() as Promise<{
    detected: number;
    inserted: number;
    skipped: number;
    characters: Array<{ name: string; voiceId: string | null; builtinName: string | null; role: string; isNew: boolean }>;
  }>;
}

export async function runTTS(page: Page, opts: {
  text: string;
  bookId?: string;
  character?: string;
  callIdx?: number;
  speed?: number;
  timeout?: number;
}) {
  const r = await page.request.post('/api/tts', {
    headers: { 'Content-Type': 'application/json' },
    data: {
      text: opts.text,
      bookId: opts.bookId ?? BOOK_ID,
      character: opts.character,
      callIdx: opts.callIdx ?? 0,
      speed: opts.speed ?? 1.0,
      language: 'vi',
    },
    timeout: opts.timeout ?? 60_000,
  });
  // Playwright's body() returns a Buffer-like. Wrap it to expose Buffer props.
  // NOTE: APIResponse.body() returns Promise<Buffer | null> — must await!
  const raw = await r.body();
  const buf = raw ? Buffer.from(raw) : null;
  let json: any = null;
  if (buf && r.headers()['content-type']?.includes('application/json')) {
    try { json = JSON.parse(buf.toString()); } catch { /* not JSON */ }
  }
  return {
    status: r.status(),
    headers: r.headers(),
    body: buf,           // Real Buffer or null
    json,               // Parsed JSON or null
    byteLength: buf ? buf.byteLength : 0,
  };
}

export const TEST_BOOK_ID = BOOK_ID;

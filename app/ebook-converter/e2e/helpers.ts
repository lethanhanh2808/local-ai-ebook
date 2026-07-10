// e2e/helpers.ts
// Shared helpers for the voice management E2E tests.

import { Page, expect } from '@playwright/test';

const DEFAULT_BOOK_ID = 'ffa65ac0-4010-40ea-9239-2fcea39c848f';
const BOOK_ID = process.env.E2E_BOOK_ID ?? DEFAULT_BOOK_ID;
const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');

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

// ── Conversation-state helpers (D1) ────────────────────────────────────────
// Helpers used by the cross-chapter / conversation-state E2E specs to
// drive the attribution pipeline and the read-only debug endpoint.

/**
 * Drive the per-chapter attribution route via HTTP and return the parsed
 * JSON. The route *currently* doesn't always emit `crossChapter` /
 * `potentialNewCharacters` on every response — those fields are surfaced
 * by the heavier /analyze route in production. We type the result as a
 * superset so the spec can assert on either path.
 */
export interface AttributeChapterCrossChapter {
  seedApplied: boolean;
  seedReason: 'applied' | 'no-row' | 'stale-chapter' | 'version-mismatch' | 'empty';
  seedFromChapterIndex: number | null;
  seedLastSpeaker?: string | null;
  persistedAt: number | null;
}

export interface AttributeChapterResult {
  attribution: Record<number, { speaker: string | null; confidence: number; source: string }>;
  fromCache?: boolean;
  omlxReachable?: boolean;
  /** Optional in the raw payload — but the helper asserts this is present
   *  unless `requireCrossChapter: false` is explicitly passed. */
  crossChapter?: AttributeChapterCrossChapter;
  potentialNewCharacters?: string[];
  stats?: {
    parserHits: number;
    regexHits: number;
    llmHits: number;
    conversationHits: number;
    defaults: number;
    totalParagraphs: number;
  };
}

/**
 * Fetch attribution for one chapter. Always asserts that `crossChapter`
 * is present in the response (the API guarantees it once the route is
 * wired to the conversation-state pipeline). Specs that need to test the
 * "missing" path should pass `{ requireCrossChapter: false }` explicitly.
 *
 * Returns the narrowed payload type (`crossChapter` non-nullable) so
 * call-site TS gets a clean `data.crossChapter.persistedAt` access.
 */
export async function attributeChapterViaApi(
  page: Page,
  chapterId: string,
  bookId: string = BOOK_ID,
  opts: { timeout?: number; requireCrossChapter?: boolean } = {},
): Promise<AttributeChapterResult & { crossChapter: AttributeChapterCrossChapter }> {
  const requireCrossChapter = opts.requireCrossChapter ?? true;
  const r = await page.request.get(
    `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/attribute`,
    { timeout: opts.timeout ?? 60_000 },
  );
  if (!r.ok()) {
    throw new Error(
      `attributeChapterViaApi ${chapterId} → ${r.status()}: ${await r.text()}`,
    );
  }
  const data = await r.json() as AttributeChapterResult;
  if (requireCrossChapter && !data.crossChapter) {
    throw new Error(
      `attributeChapterViaApi ${chapterId}: response missing crossChapter block — the route may be serving a legacy payload.`,
    );
  }
  // Helper throws when `requireCrossChapter` (default) — so `crossChapter`
  // is guaranteed to be defined for the success path. The cast narrows the
  // type for callers without an extra `!` at every call site.
  return data as AttributeChapterResult & { crossChapter: AttributeChapterCrossChapter };
}

/**
 * Hit DELETE on the conversation-state endpoint to wipe the persisted
 * snapshot. The route accepts `?force=true` so this is a no-op when the
 * row is already missing (returns 200 either way). Used by `beforeEach`
 * hooks in the cross-chapter specs.
 */
export async function clearConversationStateForBook(bookId: string): Promise<void> {
  // This helper is also called outside Playwright fixtures, so use Node's
  // global fetch with an absolute URL. Playwright's baseURL only applies to
  // page/request fixtures; it does not patch Node's native fetch.
  const r = await fetch(`${BASE_URL}/api/library/${bookId}/conversation-state?force=true`, {
    method: 'DELETE',
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(
      `clearConversationStateForBook ${bookId} → ${r.status}: ${await r.text()}`,
    );
  }
}

/**
 * Fetch the persisted BookConversationState row directly (no cache). The
 * server-side endpoint returns `{ found: false, reason }` when no row
 * exists; we surface that as `null` so callers can use a simple truthy
 * check.
 */
export interface ConversationStateRow {
  bookId: string;
  lastChapterIndex: number;
  parserVersion: string;
  snapshot?: Record<string, unknown>;
}

export async function getConversationStateForBook(
  bookId: string,
): Promise<ConversationStateRow | null> {
  const r = await fetch(`${BASE_URL}/api/library/${bookId}/conversation-state`);
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(`getConversationStateForBook ${bookId} → ${r.status}: ${await r.text()}`);
  }
  const body = await r.json() as {
    found: boolean;
    bookId?: string;
    lastChapterIndex?: number;
    parserVersion?: string;
    snapshot?: Record<string, unknown>;
    reason?: string;
  };
  if (!body.found) return null;
  return {
    bookId: body.bookId ?? bookId,
    lastChapterIndex: body.lastChapterIndex ?? -1,
    parserVersion: body.parserVersion ?? '',
    snapshot: body.snapshot,
  };
}

/**
 * Page-scoped variant of `getConversationStateForBook`. Returns both the
 * HTTP status and the parsed body so callers can assert on 404 vs. 200.
 */
export async function getConversationStateViaApi(
  page: Page,
  bookId: string,
): Promise<{ status: number; body: any }> {
  const r = await page.request.get(`/api/library/${bookId}/conversation-state`);
  const status = r.status();
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = { error: await r.text() };
  }
  return { status, body };
}

/**
 * Register a single character on a book via the existing characters POST
 * endpoint. Returns the persisted Character row (with id) on success, or
 * `null` if the API rejected the request.
 */
export async function createCharacter(
  page: Page,
  opts: {
    name: string;
    role?: 'main' | 'supporting' | 'minor' | 'crowd';
    bookId?: string;
    aliases?: string[];
    voiceName?: string;
  },
): Promise<{ id: string; name: string } | null> {
  const bookId = opts.bookId ?? BOOK_ID;
  const r = await page.request.post(`/api/library/${bookId}/characters`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      characters: [
        {
          name: opts.name,
          aliases: opts.aliases ?? [],
          role: opts.role ?? 'supporting',
          ...(opts.voiceName ? { voiceName: opts.voiceName } : {}),
        },
      ],
    },
  });
  if (!r.ok()) return null;
  const body = await r.json() as { characters?: Array<{ id: string; name: string }> };
  return body.characters?.[0] ?? null;
}

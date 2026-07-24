// src/tests/m4b-route.test.ts
//
// Phase 4.5 of docs/NEXT_UP_PLAN.md — integration tests for the
// GET /api/library/[id]/audiobook/m4b route handler.
//
// We mock the heavy pieces (Prisma DB, storage cover-resolution, ffmpeg
// helper) so we can drive every status-gate branch without a real DB,
// filesystem, or binary. The route's contracts under test:
//
//   1. 404 book not found
//   2. 409 audiobookStatus === 'generating'
//   3. 409 not all chapters ready (summary.failed > 0 OR ready !== total
//      OR total === 0)
//   4. 200 stream with audio/mp4 + Content-Disposition: attachment +
//      sanitized ASCII filename
//   5. 503 when M4BExportError{code:'ENOENT'} fires (ffmpeg missing)
//   6. 500 when M4BExportError{code:'ESAFEPATH'} fires (traversal)
//   7. 500 when M4BExportError{code:'EUNKNOWN'} fires (chapter missing
//      on disk — surface as generic 500, not 500 ESAFEPATH)
//
// Mocks follow the patterns at:
//   - src/tests/character-merge-api.test.ts (Prisma via vi.hoisted)
//   - src/tests/calibre-worker-integration.test.ts (BullMQ)
//   - src/tests/m4b-export.test.ts (fs + child_process)

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

// ── Hoisted mock state ──────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  book: null as null | { id: string; title: string; author?: string | null; coverPath?: string | null; audiobookStatus?: string },
  summary: null as null | { total: number; ready: number; failed: number; pending: number; durationMs: number; sizeBytes: number; pct: number },
  chapters: [] as Array<{
    id: string;
    chapterFile: string;
    chapterTitle: string | null;
    status: string;
    audioPath: string | null;
    durationMs: number | null;
    sizeBytes: number | null;
    errorMsg: string | null;
    generatedAt: Date | null;
  }>,
  coverPath: null as string | null,
  /** Per-book mutex map from exportM4BOnce — when set, second concurrent
   *  call returns the same in-flight Promise. */
  m4bError: null as Error | null,
  m4bResult: null as { outputPath: string; bytes: number; durationMs: number } | null,
  durations: [] as number[],
}));

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/db/books', () => ({
  getBook: vi.fn(async (id: string) => (state.book && state.book.id === id ? state.book : null)),
}));

vi.mock('@/lib/db/audiobook', () => ({
  getAudiobookSummary: vi.fn(async () => state.summary),
  listChapters: vi.fn(async () => state.chapters),
  // Other helpers aren't called by this route, but the module barrel
  // re-exports them; provide no-op fallbacks for type-safety.
  ensureChapterRow: vi.fn(),
  updateChapter: vi.fn(),
  getChapter: vi.fn(),
  setBookAudiobookStatus: vi.fn(),
  resetAudiobook: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  resolveCoverPath: vi.fn(async () => state.coverPath),
}));

vi.mock('@/lib/tools/m4b', () => ({
  exportM4BOnce: vi.fn(async (_bookId: string, _opts: unknown) => {
    if (state.m4bError) throw state.m4bError;
    if (state.m4bResult) return state.m4bResult;
    throw new Error('m4bResult not set in test');
  }),
  getActualDurations: vi.fn(async (paths: string[]) => {
    if (state.durations.length === paths.length) return state.durations;
    // Default: return chapter-reported durations × 1.0 (no drift).
    return paths.map(() => 10_000);
  }),
  // The mock class MUST be the same instance the route imports so its
  // `err instanceof M4BExportError` check passes. We export it on the
  // mock module surface and reference it via `M4BExportErrorMock`
  // (captured at module-eval time below).
  M4BExportError: class M4BExportError extends Error {
    constructor(message: string, public code: 'ENOENT' | 'ETIMEOUT' | 'ENONZERO' | 'ESAFEPATH' | 'EUNKNOWN', public stderr?: string) {
      super(message);
      this.name = 'M4BExportError';
    }
  },
}));

// We do NOT mock node:fs — instead the success-path tests point
// `m4bResult.outputPath` at a real on-disk file (a tiny m4b fixture we
// create in beforeEach). The route's real fs.statSync + createReadStream
// work without surprising mock leaks across test files.

// ── Import under test ───────────────────────────────────────────────────────

// Use a relative import — vitest's alias matching does not always handle
// route segments containing literal `[` and `]` reliably.
import { GET } from '../app/api/library/[id]/audiobook/m4b/route';
import { M4BExportError as M4BExportErrorMock } from '@/lib/tools/m4b';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(bookId: string) {
  return new NextRequest(`http://localhost/api/library/${bookId}/audiobook/m4b`, { method: 'GET' });
}

function makeParams(bookId: string) {
  return { params: Promise.resolve({ id: bookId }) };
}

// On-disk fixture for the success-path tests. The route uses the real
// fs.statSync + fs.createReadStream on this file, so it must exist.
const FIXTURE_DIR = path.resolve(process.cwd(), 'data', 'audiobooks', '__route_test_fixture__');
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'fixture.m4b');

beforeEach(() => {
  state.book = null;
  state.summary = null;
  state.chapters = [];
  state.coverPath = null;
  state.m4bError = null;
  state.m4bResult = null;
  state.durations = [];
  // Ensure the fixture file exists with non-zero size. The route's
  // statSync reports the real bytes; createReadStream serves the bytes.
  try {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(FIXTURE_FILE, Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]));
  } catch { /* best-effort */ }
});

// ── 404 ─────────────────────────────────────────────────────────────────────

describe('m4b route — 404', () => {
  it('returns 404 Vietnamese when the book does not exist', async () => {
    state.book = null;
    const r = await GET(makeReq('nope'), makeParams('nope'));
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toBe('Sách không tồn tại');
  });
});

// ── 409 ─────────────────────────────────────────────────────────────────────

describe('m4b route — 409', () => {
  it('returns 409 when audiobook is currently generating', async () => {
    state.book = { id: 'b1', title: 'Sách', audiobookStatus: 'generating' };
    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toMatch(/Đang tạo audio/);
    expect(body.status).toBe('generating');
  });

  it('returns 409 when total is 0 (no chapters at all)', async () => {
    state.book = { id: 'b1', title: 'Sách', audiobookStatus: 'ready' };
    state.summary = { total: 0, ready: 0, failed: 0, pending: 0, durationMs: 0, sizeBytes: 0, pct: 0 };
    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toMatch(/Chưa đủ chương/);
  });

  it('returns 409 when any chapter is failed (concat would gap)', async () => {
    state.book = { id: 'b1', title: 'Sách', audiobookStatus: 'ready' };
    state.summary = { total: 3, ready: 3, failed: 1, pending: 0, durationMs: 30_000, sizeBytes: 3000, pct: 100 };
    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.failed).toBe(1);
  });

  it('returns 409 when not all chapters are ready (partial)', async () => {
    state.book = { id: 'b1', title: 'Sách', audiobookStatus: 'partial' };
    state.summary = { total: 3, ready: 2, failed: 0, pending: 1, durationMs: 20_000, sizeBytes: 2000, pct: 67 };
    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.ready).toBe(2);
    expect(body.total).toBe(3);
    expect(body.missing).toBe(1);
  });
});

// ── 200 — happy path ────────────────────────────────────────────────────────

describe('m4b route — 200', () => {
  it('streams the m4b with audio/mp4 + attachment + sanitized ASCII filename', async () => {
    // Vietnamese title with diacritics; expect filename to be stripped to ASCII.
    state.book = { id: 'b1', title: 'Bắt đầu 100 triệu', author: 'Tác giả', audiobookStatus: 'ready' };
    state.summary = { total: 2, ready: 2, failed: 0, pending: 0, durationMs: 20_000, sizeBytes: 2000, pct: 100 };
    state.chapters = [
      {
        id: 'c1', chapterFile: '001.xhtml', chapterTitle: 'Chương 1', status: 'ready',
        audioPath: path.resolve(process.cwd(), 'data', 'audiobooks', 'b1', '001.mp3'),
        durationMs: 10_000, sizeBytes: 1000, errorMsg: null, generatedAt: null,
      },
      {
        id: 'c2', chapterFile: '002.xhtml', chapterTitle: 'Chương 2', status: 'ready',
        audioPath: path.resolve(process.cwd(), 'data', 'audiobooks', 'b1', '002.mp3'),
        durationMs: 10_000, sizeBytes: 1000, errorMsg: null, generatedAt: null,
      },
    ];
    state.coverPath = null;
    // Point outputPath at the on-disk fixture so the route's real
    // statSync + createReadStream work without mocking fs.
    state.m4bResult = {
      outputPath: FIXTURE_FILE,
      bytes: 8,
      durationMs: 20_000,
    };

    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('audio/mp4');
    expect(r.headers.get('Content-Length')).toBe('8');
    const cd = r.headers.get('Content-Disposition') ?? '';
    expect(cd).toMatch(/attachment/);
    // Non-printable / non-ASCII chars become '_'. Vietnamese letters are
    // > \x7E so they all collapse to '_'. Verify the structural shape:
    //  - "B" + "_" * 4 + " " + "_" * 2 + "u " + "100 tri" + "_" + "u.m4b"
    //  Simpler assertion: filename must NOT contain any Vietnamese
    //  diacritics, and the digits + "100 tri" survive.
    expect(cd).not.toMatch(/[ăâêôơưđĂÂÊÔƠƯĐ]/i);
    expect(cd).toMatch(/filename=".*100 tri.*\.m4b"/);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('includes cover when resolveCoverPath returns one', async () => {
    state.book = { id: 'b1', title: 'Plain Title', audiobookStatus: 'ready' };
    state.summary = { total: 1, ready: 1, failed: 0, pending: 0, durationMs: 10_000, sizeBytes: 1000, pct: 100 };
    state.chapters = [
      {
        id: 'c1', chapterFile: '001.xhtml', chapterTitle: 'Chương 1', status: 'ready',
        audioPath: path.resolve(process.cwd(), 'data', 'audiobooks', 'b1', '001.mp3'),
        durationMs: 10_000, sizeBytes: 1000, errorMsg: null, generatedAt: null,
      },
    ];
    state.coverPath = path.resolve(process.cwd(), 'data', 'library', 'covers', 'b1.jpg');
    state.m4bResult = {
      outputPath: FIXTURE_FILE,
      bytes: 8,
      durationMs: 10_000,
    };

    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(200);
    // coverPath being non-null exercises the with-cover branch in
    // exportM4B; we don't introspect the call args (helper tests cover
    // the arg set). We just verify success.
  });
});

// ── 503 / 500 ───────────────────────────────────────────────────────────────

describe('m4b route — error mapping', () => {
  beforeEach(() => {
    state.book = { id: 'b1', title: 'Sách', audiobookStatus: 'ready' };
    state.summary = { total: 1, ready: 1, failed: 0, pending: 0, durationMs: 10_000, sizeBytes: 1000, pct: 100 };
    state.chapters = [
      {
        id: 'c1', chapterFile: '001.xhtml', chapterTitle: 'Chương 1', status: 'ready',
        audioPath: path.resolve(process.cwd(), 'data', 'audiobooks', 'b1', '001.mp3'),
        durationMs: 10_000, sizeBytes: 1000, errorMsg: null, generatedAt: null,
      },
    ];
  });

  it('returns 503 with install hint when ffmpeg is missing (ENOENT)', async () => {
    // Must use the MOCK class so `instanceof M4BExportError` passes in the route.
    state.m4bError = new M4BExportErrorMock('spawn ENOENT', 'ENOENT');
    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error).toMatch(/ffmpeg chưa được cài đặt/);
    expect(body.installHint).toMatch(/brew install ffmpeg/);
  });

  it('returns 500 without leaking path when ESAFEPATH fires', async () => {
    state.m4bError = new M4BExportErrorMock('unsafe path', 'ESAFEPATH');
    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toMatch(/Xuất M4B thất bại/);
    // Body must NOT include the offending path or any internal detail.
    expect(JSON.stringify(body)).not.toMatch(/unsafe path/);
  });

  it('returns 500 with stderr detail when ENONZERO fires', async () => {
    const stderr = 'ffmpeg: invalid argument\nlast line of stderr';
    state.m4bError = new M4BExportErrorMock('ffmpeg exited with code 1', 'ENONZERO', stderr);
    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toMatch(/Xuất M4B thất bại/);
    expect(body.detail).toContain('invalid argument');
  });

  it('returns 500 when chapter file is missing on disk (EUNKNOWN, not ESAFEPATH)', async () => {
    // Pins the refactor that split ESAFEPATH (security/traversal) from
    // EUNKNOWN (data loss / race condition). The route surfaces both as
    // 500, but the underlying code distinction matters for logs.
    state.m4bError = new M4BExportErrorMock('Chapter audio file not found on disk', 'EUNKNOWN');
    const r = await GET(makeReq('b1'), makeParams('b1'));
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toMatch(/Xuất M4B thất bại/);
  });
});

// ── path import at the bottom so vi.mock factories above capture it ────────

// Silence unused-import linter warnings while keeping the import order
// unambiguous (the vi.mock factories above need to capture vi.hoisted
// BEFORE the helper module imports).
afterEach(() => { vi.clearAllMocks(); });
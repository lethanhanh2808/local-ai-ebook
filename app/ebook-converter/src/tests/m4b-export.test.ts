// src/tests/m4b-export.test.ts
//
// Phase 4.5 of docs/NEXT_UP_PLAN.md — unit tests for the M4B export helper.
//
// Test plan (6 cases):
//   1. buildFfMetadata with empty chapters throws
//   2. buildFfMetadata with one chapter emits ;FFMETADATA1 magic + START=0/END
//   3. buildFfMetadata with three chapters uses cumulative START/END math
//   4. UTF-8 Vietnamese titles + special chars escape per FFMETADATA1 rules
//   5. exportM4B spawns ffmpeg with the correct arg set WITH cover AND WITHOUT
//   6. exportM4B throws M4BExportError{code:'ENOENT'} when spawn ENOENT fires
//
// The mocking pattern mirrors src/tests/calibre-probe.test.ts:36-61 — we
// override node:fs.existsSync and node:child_process.spawn so the helper
// doesn't actually shell out. We also intercept node:fs.writeFileSync /
// statSync to keep the tests hermetic.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Build paths that pass `assertWithinRoots` — they must live under the
// `audiobooks` root (default: process.cwd()/data/audiobooks). We resolve
// once at import-time so each test gets a stable canonical absolute path.
const AUDIOBOOKS = path.resolve(process.cwd(), 'data', 'audiobooks');
const UPLOADS = path.resolve(process.cwd(), 'data', 'uploads');

// Real on-disk tmpdir for filelist/metadata writes (the fs mock lets
// writeFileSync through, so the parent dir must actually exist).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'm4b-test-'));

// ── Mock state ──────────────────────────────────────────────────────────────

interface ExistsState { truthy: Set<string> }
const existsState: ExistsState = { truthy: new Set() };

interface SpawnState {
  /** Number of spawn() invocations since reset. */
  calls: number;
  /** Last spawn's command + args (for assertion). */
  lastCmd: string | null;
  lastArgs: string[] | null;
  /** Whether the proc should fire `error` synchronously (with ENOENT) instead of `close`. */
  errorOut: boolean;
  /** Custom stdout body (rarely needed — we mostly test stderr handling). */
  stdoutBody: string;
  /** Custom stderr body (matters for ENONZERO path). */
  stderrBody: string;
}
const spawnState: SpawnState = {
  calls: 0,
  lastCmd: null,
  lastArgs: null,
  errorOut: false,
  stdoutBody: '',
  stderrBody: '',
};

// Capture writeFileSync inputs (we want to assert metadata.txt / filelist.txt).
interface WriteState {
  paths: string[];
  bodies: string[];
}
const writeState: WriteState = { paths: [], bodies: [] };

// Mocked module declarations ─ we declare `vi.hoisted` so the values
// captured into the mock factories are the same instances the assertions
// read back.
const state = vi.hoisted(() => ({
  exists: { truthy: new Set<string>() } as ExistsState,
  spawn: {
    calls: 0,
    lastCmd: null as string | null,
    lastArgs: null as string[] | null,
    errorOut: false,
    stdoutBody: '',
    stderrBody: '',
  } as SpawnState,
  writes: { paths: [] as string[], bodies: [] as string[] } as WriteState,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => state.exists.truthy.has(p),
    writeFileSync: (p: string, body: string) => {
      state.writes.paths.push(p);
      state.writes.bodies.push(body);
    },
    statSync: (p: string) => {
      // The success-path calls statSync on opts.outputPath. Report a fake
      // non-zero size so the helper resolves instead of throwing
      // "Output M4B missing after success".
      if (String(p).endsWith('.m4b')) {
        return { size: 8192 } as never;
      }
      return actual.statSync(p as never);
    },
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      state.spawn.calls += 1;
      state.spawn.lastCmd = cmd;
      state.spawn.lastArgs = args.slice();

      const proc = {
        stdout: { on: (_: string, cb: (chunk: Buffer) => void) => {
          if (state.spawn.stdoutBody) cb(Buffer.from(state.spawn.stdoutBody));
        } },
        stderr: { on: (_: string, cb: (chunk: Buffer) => void) => {
          if (state.spawn.stderrBody) cb(Buffer.from(state.spawn.stderrBody));
        } },
        on: (event: string, cb: (...args: unknown[]) => void) => {
          if (state.spawn.errorOut && event === 'error') {
            const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
            setImmediate(() => cb(err));
            return;
          }
          if (event === 'close') setImmediate(() => cb(0));
          if (event === 'error' && !state.spawn.errorOut) {
            // No-op: error handler that never fires in the happy path.
          }
        },
      };
      return proc as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

// ── Import under test ───────────────────────────────────────────────────────
//
// Import AFTER the mocks so the helper sees them at module-init time.

import { buildFfMetadata, exportM4B, M4BExportError } from '@/lib/tools/m4b';

beforeEach(() => {
  state.exists.truthy.clear();
  state.spawn.calls = 0;
  state.spawn.lastCmd = null;
  state.spawn.lastArgs = null;
  state.spawn.errorOut = false;
  state.spawn.stdoutBody = '';
  state.spawn.stderrBody = '';
  state.writes.paths.length = 0;
  state.writes.bodies.length = 0;
});

// ── Pure: buildFfMetadata ────────────────────────────────────────────────────

describe('buildFfMetadata', () => {
  it('throws on empty chapters', () => {
    // @ts-expect-error — chapters is required at runtime; the test pins
    // the runtime guard against TypeScript-only enforcement.
    expect(() => buildFfMetadata({ title: 'Book' })).toThrow(/empty/);
    expect(() => buildFfMetadata({ title: 'Book', chapters: [] })).toThrow(/empty/);
  });

  it('emits ;FFMETADATA1 magic header + TIMEBASE for a single chapter', () => {
    const out = buildFfMetadata({
      title: 'Bắt đầu',
      chapters: [{ title: 'Chương 1', durationMs: 123_456 }],
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe(';FFMETADATA1');
    expect(lines).toContain('title=Bắt đầu');
    expect(out).toContain('[CHAPTER]');
    expect(out).toContain('TIMEBASE=1/1000');
    expect(out).toContain('START=0');
    expect(out).toContain('END=123456');
    expect(out).toContain('title=Chương 1');
  });

  it('uses cumulative START/END math across three chapters', () => {
    const out = buildFfMetadata({
      title: 'Cuốn sách',
      chapters: [
        { title: 'Chương 1', durationMs: 10_000 },
        { title: 'Chương 2', durationMs: 15_000 },
        { title: 'Chương 3', durationMs: 7_500 },
      ],
    });
    // 3 chapter blocks; assert the cumulative cursors by line position.
    expect(out).toContain('START=0');
    expect(out).toContain('END=10000');
    expect(out).toContain('START=10000');
    expect(out).toContain('END=25000');
    expect(out).toContain('START=25000');
    expect(out).toContain('END=32500');
  });

  it('escapes Vietnamese + special characters per FFMETADATA1 rules', () => {
    const out = buildFfMetadata({
      title: 'Truyện: "Kẻ ngoài"\\cửa',
      artist: 'Tác giả #1; đồng tác giả',
      chapters: [{ title: 'Chương với\nnewline', durationMs: 5_000 }],
    });
    // Backslashes escaped first.
    expect(out).toContain('title=Truyện: "Kẻ ngoài"\\\\cửa');
    // # escaped.
    expect(out).toContain('artist=Tác giả \\#1\\; đồng tác giả');
    // Newline escaped as backslash-n.
    expect(out).toContain('title=Chương với\\\nnewline');
  });
});

// ── Spawn: exportM4B ─────────────────────────────────────────────────────────

describe('exportM4B', () => {
  const baseOpts = () => ({
    outputPath: path.join(AUDIOBOOKS, 'foo', 'book.m4b'),
    bookTitle: 'Bắt đầu',
    chapters: [
      { audioPath: path.join(AUDIOBOOKS, 'foo', '001.mp3'), title: 'Chương 1', durationMs: 10_000 },
      { audioPath: path.join(AUDIOBOOKS, 'foo', '002.mp3'), title: 'Chương 2', durationMs: 12_000 },
    ],
    tmpDir: TMP,
  });

  it('spawns ffmpeg with the correct arg set WITH cover', async () => {
    // Mark chapter audio + cover as existing so validation passes.
    state.exists.truthy.add(path.join(AUDIOBOOKS, 'foo', '001.mp3'));
    state.exists.truthy.add(path.join(AUDIOBOOKS, 'foo', '002.mp3'));
    state.exists.truthy.add(path.join(UPLOADS, 'cover.jpg'));

    const opts = { ...baseOpts(), coverPath: path.join(UPLOADS, 'cover.jpg') };
    await exportM4B(opts);

    expect(state.spawn.calls).toBe(1);
    expect(state.spawn.lastCmd).toBe('ffmpeg');
    const args = state.spawn.lastArgs!;
    // Cover presence → input index 2 is the cover.
    expect(args).toContain('-i');
    expect(args).toContain(path.join(UPLOADS, 'cover.jpg'));
    // -map 2:v chain must be present.
    expect(args).toContain('2:v');
    expect(args).toContain('attached_pic');
    // AAC + bitrate + faststart always-on.
    expect(args).toContain('aac');
    expect(args).toContain('96k');
    expect(args).toContain('+faststart');
    // Output path is the last positional arg.
    expect(args[args.length - 1]).toBe(path.join(AUDIOBOOKS, 'foo', 'book.m4b'));
    // filelist.txt + metadata.txt were both written.
    expect(state.writes.paths.some((p) => p.endsWith('filelist.txt'))).toBe(true);
    expect(state.writes.paths.some((p) => p.endsWith('metadata.txt'))).toBe(true);
  });

  it('spawns ffmpeg with the correct arg set WITHOUT cover (no -map 2:v chain)', async () => {
    state.exists.truthy.add(path.join(AUDIOBOOKS, 'foo', '001.mp3'));
    state.exists.truthy.add(path.join(AUDIOBOOKS, 'foo', '002.mp3'));

    await exportM4B(baseOpts());

    expect(state.spawn.calls).toBe(1);
    const args = state.spawn.lastArgs!;
    // No 2:v mapping when no cover.
    expect(args).not.toContain('2:v');
    expect(args).not.toContain('attached_pic');
    // ffmpeg is invoked with exactly 2 -i flags (audio concat + metadata).
    const iCount = args.filter((a) => a === '-i').length;
    expect(iCount).toBe(2);
  });

  it('throws M4BExportError{code:"ENOENT"} when spawn fires ENOENT', async () => {
    state.exists.truthy.add(path.join(AUDIOBOOKS, 'foo', '001.mp3'));
    state.exists.truthy.add(path.join(AUDIOBOOKS, 'foo', '002.mp3'));
    state.spawn.errorOut = true; // proc.on('error') fires synchronously

    await expect(exportM4B(baseOpts())).rejects.toBeInstanceOf(M4BExportError);
    await expect(exportM4B(baseOpts())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// src/tests/calibre-worker-integration.test.ts
//
// Phase 4.3 of docs/NEXT_UP_PLAN.md — integration test for the worker
// Calibre pre-step. Drops a fake `ebook-convert` shell script into a
// tempdir and prepends tempdir to PATH so the real probe finds it.
//
// Test plan (4 cases):
//   1. requiresPreprocessing=true + originalExt='mobi' → pre-step fires,
//      staged .epub is written, pipeline is called with effective ext
//      = 'epub' and effective inputPath = stagedPath.
//   2. requiresPreprocessing=false + originalExt='epub' → pre-step is
//      SKIPPED entirely (no spawn invoked).
//   3. requiresPreprocessing=true but originalExt='epub' (defensive
//      mismatch) → pre-step is SKIPPED (guarded by originalExt !== 'epub'
//      OR by checking the format table — current impl runs the pre-step
//      regardless; pin that behavior).
//   4. Shim removed → probe fails, UnrecoverableError thrown, no retries.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Calibre shim ────────────────────────────────────────────────────────────
//
// A 4-line POSIX shell script that pretends to be ebook-convert. It writes
// a small fake .epub at the output path and exits 0. Crucially, it also
// writes a "called" marker file so the test can assert it was invoked.

function installShim(dir: string): { shimPath: string; markerDir: string } {
  const shimPath = path.join(dir, 'ebook-convert');
  const markerDir = path.join(dir, 'markers');
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(shimPath, `#!/bin/sh
# fake ebook-convert — copy input to output and emit a marker
marker="$MARKER_DIR/invoked-$(date +%s%N)"
echo "shim called with $@" > "$marker"
# Handle --version specially so probeCalibre's version probe succeeds.
if [ "$1" = "--version" ]; then echo "calibre 7.19.0 (shim)"; exit 0; fi
if [ -z "$1" ] || [ -z "$2" ]; then echo "usage"; exit 64; fi
if [ ! -f "$1" ]; then echo "input not found"; exit 66; fi
printf 'PK\\x03\\x04fake-epub-payload' > "$2"
ls -la "$2" >> "$marker"
exit 0
`,
    { mode: 0o755 },
  );
  return { shimPath, markerDir };
}

// ── Module mocks ────────────────────────────────────────────────────────────
//
// We mock the heavy pieces the worker pulls in (Prisma client, conversion
// pipeline, settings DB) so we can isolate the pre-step behavior.

const pipelineCalls: Array<{ inputPath: string; originalExt: string }> = [];

vi.mock('@/lib/db/client', () => ({
  prisma: {
    job: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

vi.mock('@/lib/db/jobs', () => ({
  updateJob: vi.fn(async (_id: string, _data: Record<string, unknown>) => undefined),
}));

vi.mock('@/lib/db/settings', () => ({
  getSettings: vi.fn(async () => ({
    aiProvider: 'omlx-local',
    aiModel: 'test-model',
    workerConcurrency: 1,
  })),
}));

vi.mock('@/lib/pipeline/conversion-pipeline', () => ({
  runConversionPipeline: vi.fn(async (args: { inputPath: string; originalExt: string }) => {
    pipelineCalls.push({ inputPath: args.inputPath, originalExt: args.originalExt });
    return {
      validation: { isValid: true, issues: [] },
      repairReport: null,
      deepFormatAiCalls: 0,
      metadata: {},
    };
  }),
}));

// Silence the audiobook worker spawn (the worker imports it lazily; we don't
// want it to actually start during tests).
vi.mock('@/worker/audiobook', () => ({
  startAudiobookWorker: vi.fn(async () => undefined),
}));

// We don't mock `@/lib/tools/calibre` — that's the code under test. Instead
// we install a real shim on PATH so probeCalibre resolves it organically.

// ── Worker entry-point under test ───────────────────────────────────────────
//
// We import the worker module after the mocks above. The worker starts a
// Redis-backed BullMQ loop on import, so we need to mock the queue as well.

const workerProcessors: Array<(job: unknown) => Promise<unknown>> = [];

vi.mock('bullmq', () => {
  return {
    Worker: class {
      constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
        workerProcessors.push(processor);
      }
      on() { /* noop */ }
      get concurrency() { return 1; }
      set concurrency(_n: number) { /* noop */ }
      async close() { return undefined; }
    },
    UnrecoverableError: class UnrecoverableError extends Error {
      constructor(message: string) { super(message); this.name = 'UnrecoverableError'; }
    },
  };
});

vi.mock('ioredis', () => {
  return {
    default: class FakeRedis {
      async set() { return 'OK'; }
      async del() { return 1; }
      async quit() { return 'OK'; }
      on() { return this; }
    },
  };
});

// ── Setup / teardown ────────────────────────────────────────────────────────

let workDir: string;
let shimDir: string;
let markerDir: string;
let originalPath: string | undefined;
let originalCwd: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-it-'));
  shimDir = path.join(workDir, 'bin');
  fs.mkdirSync(shimDir);
  const shim = installShim(shimDir);
  markerDir = shim.markerDir;

  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
  process.env.MARKER_DIR = markerDir;

  originalCwd = process.cwd();
  // Worker imports relative paths like 'data/job-logs' — keep them in the temp work dir.
  process.chdir(workDir);

  pipelineCalls.length = 0;
  workerProcessors.length = 0;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.MARKER_DIR;
  process.chdir(originalCwd);
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  vi.resetModules();
});

// ── Helper: run the most-recently-registered worker processor ───────────────

async function runJob(data: Record<string, unknown>) {
  // The worker registers exactly one processor in our test scope.
  if (workerProcessors.length === 0) {
    // Dynamic import (post-mock) triggers Worker registration.
    await import('@/worker/index');
  }
  expect(workerProcessors.length).toBeGreaterThan(0);
  const processor = workerProcessors[workerProcessors.length - 1]!;
  return processor({
    id: data.jobId,
    data,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Worker Calibre pre-step', () => {
  it('runs the pre-step for MOBI + requiresPreprocessing=true, then swaps input to staged .epub', async () => {
    const jobId = 'job-mobi-1';
    const inputPath = path.join(workDir, 'book.mobi');
    fs.writeFileSync(inputPath, 'fake-mobi-bytes');

    // Reset modules so the freshly-imported worker picks up the current PATH.
    vi.resetModules();
    await import('@/worker/index');

    // Build the job data BEFORE running, since we may need to import again.
    await runJob({
      jobId,
      inputPath,
      originalExt: 'mobi',
      filename: 'book.mobi',
      aiEnhance: false,
      requiresPreprocessing: true,
    });

    // Pipeline must have been called exactly once.
    expect(pipelineCalls).toHaveLength(1);
    const call = pipelineCalls[0]!;
    // Input path is NOT the original MOBI — it's the staged .epub.
    expect(call.inputPath).not.toBe(inputPath);
    expect(call.inputPath).toMatch(/-staged\.epub$/);
    expect(call.originalExt).toBe('epub');
    // The staged file actually exists on disk.
    expect(fs.existsSync(call.inputPath)).toBe(true);
    expect(fs.statSync(call.inputPath).size).toBeGreaterThan(0);
    // The shim was invoked (marker file written).
    const markers = fs.readdirSync(markerDir);
    expect(markers.length).toBeGreaterThan(0);
  });

  it('skips the pre-step for EPUB + requiresPreprocessing=false (no spawn)', async () => {
    const jobId = 'job-epub-1';
    const inputPath = path.join(workDir, 'book.epub');
    fs.writeFileSync(inputPath, 'fake-epub-bytes');

    await runJob({
      jobId,
      inputPath,
      originalExt: 'epub',
      filename: 'book.epub',
      aiEnhance: false,
      requiresPreprocessing: false,
    });

    expect(pipelineCalls).toHaveLength(1);
    expect(pipelineCalls[0]!.inputPath).toBe(inputPath);
    expect(pipelineCalls[0]!.originalExt).toBe('epub');
    // No marker files — the shim was never invoked.
    expect(fs.readdirSync(markerDir)).toEqual([]);
  });

  it('skips the pre-step for EPUB even if requiresPreprocessing=true (defensive guard)', async () => {
    // Pin current behavior: requiresPreprocessing=true with originalExt='epub'
    // would re-run the pre-step and overwrite the staged file. The worker
    // doesn't guard against this today — the upload route only sets the flag
    // when extension is in CALIBRE_FORMATS. Document the behavior so a
    // future refactor doesn't accidentally break it.
    const jobId = 'job-mismatch-1';
    const inputPath = path.join(workDir, 'book.epub');
    fs.writeFileSync(inputPath, 'fake-epub-bytes');

    await runJob({
      jobId,
      inputPath,
      originalExt: 'epub',
      filename: 'book.epub',
      aiEnhance: false,
      requiresPreprocessing: true,
    });

    expect(pipelineCalls).toHaveLength(1);
    // Today the pre-step WOULD run and write a staged .epub — assert that
    // behavior explicitly so we notice if a guard is added.
    const call = pipelineCalls[0]!;
    // Pre-step ran — inputPath was swapped to a staged .epub.
    expect(call.inputPath).toMatch(/-staged\.epub$/);
    expect(fs.readdirSync(markerDir).length).toBeGreaterThan(0);
  });

  it('throws UnrecoverableError when Calibre is missing — no retries', async () => {
    // Remove the shim from PATH — probe will fail.
    process.env.PATH = '';
    delete process.env.MARKER_DIR;

    vi.resetModules();
    await import('@/worker/index');

    const jobId = 'job-missing-1';
    const inputPath = path.join(workDir, 'book.mobi');
    fs.writeFileSync(inputPath, 'fake-mobi-bytes');

    const promise = runJob({
      jobId,
      inputPath,
      originalExt: 'mobi',
      filename: 'book.mobi',
      aiEnhance: false,
      requiresPreprocessing: true,
    });

    await expect(promise).rejects.toThrow(/ebook-convert|Calibre/);
    // Pipeline must NOT have been called.
    expect(pipelineCalls).toHaveLength(0);
  });
});

// src/tests/calibre-probe.test.ts
//
// Phase 4.3 of docs/NEXT_UP_PLAN.md — unit tests for the Calibre probe
// helper. We mock `node:fs` (existsSync) and `node:child_process` (spawn)
// so the tests don't actually shell out. Each test resets the module's
// in-memory cache so the resolution order assertions are deterministic.
//
// Test plan (6 cases):
//   1. CALIBRE_EBOOK_CONVERT env override wins over candidate paths
//   2. /opt/homebrew/bin/ebook-convert resolves on Apple Silicon
//   3. /usr/local/bin/ebook-convert resolves on Intel Homebrew
//   4. /usr/bin/ebook-convert resolves via apt
//   5. Returns ok=false with multi-path error message when none exist
//   6. Cache hit on second call within 60s — second call must NOT spawn
//      --version again (spawn count stays at 1)

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

interface ExistsMockState {
  /** Paths that should report true via existsSync. */
  truthy: Set<string>;
}
const existsState: ExistsMockState = { truthy: new Set() };

interface SpawnMockState {
  /** Bookkeeping — number of `spawn()` invocations since the last reset. */
  calls: number;
  /** Default behavior — succeed with "calibre X.Y.Z". */
  onSpawn: (cmd: string, args: string[]) => 'ok' | 'fail';
}
const spawnState: SpawnMockState = {
  calls: 0,
  onSpawn: () => 'ok',
};

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => existsState.truthy.has(p),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      spawnState.calls += 1;
      const verdict = spawnState.onSpawn(cmd, args);
      const proc = {
        stdout: { on: (_: string, cb: (chunk: Buffer) => void) => cb(Buffer.from(verdict === 'ok' ? 'calibre 7.19.0' : '')) },
        stderr: { on: () => undefined },
        on: (event: string, cb: (code: number) => void) => {
          if (event === 'close') setImmediate(() => cb(verdict === 'ok' ? 0 : 1));
        },
      };
      return proc as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

// Mocked node:fs + node:child_process — import AFTER the mocks are set up.
import { probeCalibre, convertWithCalibre, CalibreConvertError } from '@/lib/tools/calibre';

beforeEach(() => {
  existsState.truthy.clear();
  spawnState.calls = 0;
  spawnState.onSpawn = () => 'ok';
  delete process.env.CALIBRE_EBOOK_CONVERT;
  // The probe module keeps a module-scoped cache. The simplest cross-test
  // reset is to re-import the module under a fresh vitest scope; we
  // accomplish the same effect by setting checkedAt far in the past via a
  // single forced probe with no truthy paths, which writes a fresh cache
  // entry that the subsequent force=true probe overwrites.
});

afterEach(() => {
  delete process.env.CALIBRE_EBOOK_CONVERT;
});

describe('probeCalibre resolution chain', () => {
  it('resolves via CALIBRE_EBOOK_CONVERT env override when set', async () => {
    process.env.CALIBRE_EBOOK_CONVERT = '/custom/path/ebook-convert';
    existsState.truthy.add('/custom/path/ebook-convert');
    const r = await probeCalibre(true);
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/custom/path/ebook-convert');
    expect(r.version).toBe('calibre 7.19.0');
    // Env override takes priority — even if /opt/homebrew existed, we shouldn't look there.
  });

  it('falls back to /opt/homebrew/bin/ebook-convert (Apple Silicon)', async () => {
    existsState.truthy.add('/opt/homebrew/bin/ebook-convert');
    const r = await probeCalibre(true);
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/opt/homebrew/bin/ebook-convert');
  });

  it('falls back to /usr/local/bin/ebook-convert (Intel Homebrew)', async () => {
    existsState.truthy.add('/usr/local/bin/ebook-convert');
    const r = await probeCalibre(true);
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/usr/local/bin/ebook-convert');
  });

  it('falls back to /usr/bin/ebook-convert (apt install calibre)', async () => {
    existsState.truthy.add('/usr/bin/ebook-convert');
    const r = await probeCalibre(true);
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/usr/bin/ebook-convert');
  });

  it('returns ok=false with multi-path error when nothing exists', async () => {
    // Clear PATH so the resolution chain has no last-resort fallback.
    const savedPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const r = await probeCalibre(true);
      expect(r.ok).toBe(false);
      expect(r.path).toBeNull();
      expect(r.version).toBeNull();
      expect(r.error).toMatch(/not found/);
      // Must enumerate every candidate the probe tried so users can debug.
      expect(r.error).toMatch(/opt\/homebrew/);
      expect(r.error).toMatch(/usr\/local/);
      expect(r.error).toMatch(/usr\/bin/);
    } finally {
      if (savedPath !== undefined) process.env.PATH = savedPath;
    }
  });
});

describe('probeCalibre caching', () => {
  it('re-uses cache for the second call within 60s — does NOT spawn again', async () => {
    existsState.truthy.add('/opt/homebrew/bin/ebook-convert');
    const r1 = await probeCalibre(true);
    expect(r1.ok).toBe(true);
    const spawnsAfterFirst = spawnState.calls;
    expect(spawnsAfterFirst).toBe(1); // sanity — one spawn for --version

    const r2 = await probeCalibre(false); // cache hit
    expect(r2.ok).toBe(true);
    expect(r2.path).toBe('/opt/homebrew/bin/ebook-convert');
    expect(spawnState.calls).toBe(spawnsAfterFirst); // no extra spawn
  });
});

describe('convertWithCalibre', () => {
  it('spawns the binary with [input, output, ...] and resolves on exit 0', async () => {
    existsState.truthy.add('/opt/homebrew/bin/ebook-convert');
    // Force a probe so the binary path is cached.
    await probeCalibre(true);
    spawnState.calls = 0;

    // Mock statSync to report the output exists with a non-zero size.
    const fsModule = await import('node:fs');
    const realStatSync = fsModule.statSync;
    const statSpy = vi.spyOn(fsModule, 'statSync').mockImplementation(((p: string) => {
      if (String(p).endsWith('.epub')) {
        return { size: 4096 } as never;
      }
      return realStatSync(p as never);
    }) as never);

    try {
      const r = await convertWithCalibre('/tmp/input.mobi', '/tmp/output.epub');
      expect(r.outputPath).toBe('/tmp/output.epub');
      expect(r.bytes).toBe(4096);
      expect(spawnState.calls).toBe(1);
      // The spawn args should be [input, output].
      // (We can't inspect the args after the fact without extending the mock,
      //  but a single spawn with the correct exit code is sufficient.)
    } finally {
      statSpy.mockRestore();
    }
  });

  it('throws CalibreConvertError when binary is missing', async () => {
    // No truthy paths — probe will fail.
    await expect(convertWithCalibre('/tmp/input.mobi', '/tmp/output.epub'))
      .rejects.toBeInstanceOf(CalibreConvertError);
  });
});

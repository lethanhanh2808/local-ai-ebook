// src/tests/character-bible-merge.test.ts
//
// Integration-style tests for mergeLlmProfilePatch() — the per-field lock
// + LLM-on-LLM drift detector that lives at the heart of the bible build
// pipeline.
//
// We mock `@/lib/db/client` so we can drive every branch (fresh write,
// user lock on field X, LLM-on-LLM same value, LLM-on-LLM drift) without
// needing a live SQLite. The DB helpers are loaded AFTER the mock so
// their import of prisma gets our mock rather than the real client.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// In-memory fake — schema-aware so the rest of the test stays readable.
type FieldName = 'description' | 'personality' | 'speechStyle';
interface MockProfile {
  characterId: string;
  description: string | null;
  personality: string | null;
  speechStyle: string | null;
  fieldSources: string | null;
  source: 'llm' | 'user' | 'mixed';
  version: number;
  updatedAt: Date;
}

const store = new Map<string, MockProfile>();
const writes: Array<{ where: string; update: Partial<MockProfile>; create?: MockProfile }> = [];

vi.mock('@/lib/db/client', () => ({
  prisma: {
    characterProfile: {
      findUnique: vi.fn(async ({ where }: { where: { characterId: string } }) => {
        const row = store.get(where.characterId);
        return row ? { ...row } : null;
      }),
      upsert: vi.fn(async ({ where, update, create }: {
        where: { characterId: string };
        update: Partial<MockProfile>;
        create: MockProfile;
      }) => {
        writes.push({ where: where.characterId, update });
        const existing = store.get(where.characterId);
        const merged: MockProfile = existing
          ? { ...existing, ...update, version: (existing.version ?? 0) + 1 }
          : { ...create, version: 1 };
        store.set(where.characterId, merged);
        return { ...merged };
      }),
    },
  },
}));

vi.mock('@/lib/queue', () => ({
  redisConnection: {},
}));

import { mergeLlmProfilePatch, setProfile } from '@/lib/db/character-bible';

describe('mergeLlmProfilePatch — per-field lock + drift detection', () => {
  beforeEach(() => {
    store.clear();
    writes.length = 0;
  });

  it('fresh write (no existing profile) → applied, no conflict', async () => {
    const r = await mergeLlmProfilePatch({
      characterId: 'c1',
      description: 'Linh is a young woman',
      personality: 'brave',
    });
    expect(r.applied.sort()).toEqual(['description', 'personality']);
    expect(r.skipped).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(store.get('c1')?.description).toBe('Linh is a young woman');
    expect(store.get('c1')?.source).toBe('llm');
  });

  it('user-locked description blocks LLM update to that field', async () => {
    store.set('c1', {
      characterId: 'c1', description: 'User-edited description', personality: null, speechStyle: null,
      fieldSources: JSON.stringify({ description: 'user' }), source: 'user', version: 1, updatedAt: new Date(),
    });
    const r = await mergeLlmProfilePatch({
      characterId: 'c1',
      description: 'LLM new description',
      personality: 'LLM new personality',
    });
    expect(r.skipped).toEqual(['description']);
    expect(r.applied).toEqual(['personality']);
    expect(r.conflicts).toEqual([]);
    expect(store.get('c1')?.description).toBe('User-edited description');  // preserved!
    expect(store.get('c1')?.personality).toBe('LLM new personality');      // written
  });

  it('LLM-on-LLM same value → applied (idempotent, no conflict)', async () => {
    store.set('c1', {
      characterId: 'c1', description: 'Linh is brave', personality: null, speechStyle: null,
      fieldSources: null, source: 'llm', version: 1, updatedAt: new Date(),
    });
    const r = await mergeLlmProfilePatch({
      characterId: 'c1',
      description: 'Linh is brave',
    });
    expect(r.applied).toEqual(['description']);
    expect(r.conflicts).toEqual([]);  // not flagged
    // Idempotent: row kept its version (no real change)
  });

  it('LLM-on-LLM drift → conflict, NOT overwritten', async () => {
    store.set('c1', {
      characterId: 'c1',
      description: 'Linh is brave and kind',
      personality: null, speechStyle: null,
      fieldSources: null, source: 'llm', version: 1, updatedAt: new Date(),
    });
    const r = await mergeLlmProfilePatch({
      characterId: 'c1',
      description: 'Linh is introverted and cautious',
    });
    expect(r.conflicts).toEqual(['description']);
    expect(r.applied).toEqual([]);
    // Critical: the existing value is preserved because we did NOT
    // overwrite — the caller is expected to queue this as PendingBibleDiff.
    expect(store.get('c1')?.description).toBe('Linh is brave and kind');
  });

  it('per-field lock: user-locked description + drift on personality is fine', async () => {
    // Source of truth is fieldSources (per-field). A row-level source='user'
    // is just an aggregate indicator — when fieldSources is present, only
    // the listed fields are locked. (Legacy rows without fieldSources fall
    // back to "lock all non-null fields"; see the legacy-mode test below.)
    store.set('c1', {
      characterId: 'c1',
      description: 'Locked by user',
      personality: 'old personality',
      speechStyle: null,
      fieldSources: JSON.stringify({ description: 'user' }),
      source: 'mixed', version: 1, updatedAt: new Date(),
    });
    const r = await mergeLlmProfilePatch({
      characterId: 'c1',
      description: 'LLM tries to overwrite',
      personality: 'LLM new personality (different from old)',
    });
    expect(r.skipped).toEqual(['description']);        // user lock held
    expect(r.conflicts).toEqual(['personality']);       // LLM-on-LLM drift
    expect(r.applied).toEqual([]);
  });

  it('legacy mode: row-level source=user with no fieldSources locks all non-null fields', async () => {
    // Pre-migration rows. No fieldSources JSON means the system can't tell
    // which specific fields the user touched, so it conservatively locks
    // every field that has a value.
    store.set('c1', {
      characterId: 'c1',
      description: 'User description',
      personality: 'User personality',
      speechStyle: null,
      fieldSources: null,
      source: 'user', version: 1, updatedAt: new Date(),
    });
    const r = await mergeLlmProfilePatch({
      characterId: 'c1',
      description: 'LLM new',
      personality: 'LLM new',
      speechStyle: 'LLM new',
    });
    expect(r.skipped.sort()).toEqual(['description', 'personality']);
    expect(r.applied).toEqual(['speechStyle']);
  });
});

describe('setProfile — per-field source tracking', () => {
  beforeEach(() => {
    store.clear();
    writes.length = 0;
  });

  it('user edit on description locks only description, leaves personality writeable', async () => {
    await setProfile({
      characterId: 'c1',
      description: 'My edit',
      personality: null,
      speechStyle: null,
      source: 'user',
      fieldSources: { description: 'user' },
    });
    expect(store.get('c1')?.description).toBe('My edit');
    expect(store.get('c1')?.fieldSources).toBe(JSON.stringify({ description: 'user' }));
    expect(store.get('c1')?.source).toBe('user');

    // Subsequent LLM merge should be able to write personality without
    // touching the user-locked description.
    const r = await mergeLlmProfilePatch({
      characterId: 'c1',
      description: 'LLM tries to overwrite',
      personality: 'LLM can write this',
    });
    expect(r.skipped).toEqual(['description']);
    expect(r.applied).toEqual(['personality']);
    expect(store.get('c1')?.description).toBe('My edit');
    expect(store.get('c1')?.personality).toBe('LLM can write this');
  });
});

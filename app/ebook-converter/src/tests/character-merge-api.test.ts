// src/tests/character-merge-api.test.ts
//
// Integration-style tests for mergeCharacters + splitCharacter — the
// core helpers driving POST /api/library/[id]/characters/{merge,split}.
//
// We mock @/lib/db/client with an in-memory Prisma shim that supports
// just enough surface area to drive every branch in the helpers:
//   - character.findUnique
//   - characterAlias.findUnique / create / update / delete / upsert
//   - characterChapterAppearance.findUnique / update
//   - characterRelationship.updateMany
//   - character.delete / create / update
//   - characterProfile.create / update
//   - $transaction
//
// Like character-bible-merge.test.ts, we set up the mock first and
// import the helpers AFTER so they pick up our prisma mock rather than
// the real client.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Prisma mock scaffolding ─────────────────────────────────────────────────
//
// We need `prisma` to be a single mutable object that both the test code
// can poke at AND `$transaction(fn)` can hand back to the code under test.
// `vi.mock` factories are hoisted, so we declare the object via
// `vi.hoisted` to make it visible inside the factory too.

const { prismaMock } = vi.hoisted(() => {
  // placeholder; populated below
  const obj: Record<string, unknown> = {};
  return { prismaMock: obj as any };
});

// ── In-memory store ─────────────────────────────────────────────────────────

interface MockAlias {
  id: string;
  characterId: string;
  alias: string;
  confidence: number;
  source: 'user' | 'llm' | 'merge' | 'legacy';
  detectedInChapter: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockCharacter {
  id: string;
  bookId: string;
  name: string;
  voiceId: string | null;
  notes: string | null;
  role: string;
  age: string | null;
  gender: string | null;
  tone: string | null;
  createdAt: Date;
}

interface MockProfile {
  characterId: string;
  description: string | null;
  personality: string | null;
  speechStyle: string | null;
  visualDescription: string | null;
  visualSource: string | null;
  fieldSources: string | null;
  source: 'llm' | 'user' | 'mixed';
  version: number;
  updatedAt: Date;
}

interface MockAppearance {
  id: string;
  characterId: string;
  chapterIndex: number;
  mentions: number;
}

const aliasStore = new Map<string, MockAlias>();
const characterStore = new Map<string, MockCharacter>();
const profileStore = new Map<string, MockProfile>();
const appearanceStore: MockAppearance[] = [];
const relationshipOps: Array<{ fromCharId?: string; toCharId?: string }> = [];
const deleteOps: string[] = [];

let aliasIdCounter = 0;
function nextAliasId(): string {
  aliasIdCounter += 1;
  return `alias-${aliasIdCounter}`;
}

// ── Prisma mock ─────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: prismaMock,
}));

// Populate the hoisted prismaMock with in-memory implementations.
Object.assign(prismaMock, {
  characterAlias: {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; characterId_alias?: { characterId: string; alias: string } } }) => {
      if (where.id) return aliasStore.get(where.id) ?? null;
      if (where.characterId_alias) {
        for (const a of aliasStore.values()) {
          if (a.characterId === where.characterId_alias.characterId && a.alias === where.characterId_alias.alias) {
            return a;
          }
        }
        return null;
      }
      return null;
    }),
    findMany: vi.fn(async ({ where }: { where?: { characterId?: string } } = {}) => {
      const out: MockAlias[] = [];
      for (const a of aliasStore.values()) {
        if (!where?.characterId || a.characterId === where.characterId) out.push(a);
      }
      return out.sort((x, y) => x.alias.localeCompare(y.alias));
    }),
    create: vi.fn(async ({ data }: { data: Omit<MockAlias, 'id' | 'createdAt' | 'updatedAt'> & { id?: string } }) => {
      // Check unique constraint
      for (const a of aliasStore.values()) {
        if (a.characterId === data.characterId && a.alias === data.alias) {
          throw new Error(`Unique constraint: (${data.characterId}, ${data.alias})`);
        }
      }
      const row: MockAlias = {
        id: data.id ?? nextAliasId(),
        characterId: data.characterId,
        alias: data.alias,
        confidence: data.confidence,
        source: data.source,
        detectedInChapter: data.detectedInChapter,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      aliasStore.set(row.id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MockAlias> }) => {
      const existing = aliasStore.get(where.id);
      if (!existing) throw new Error('not found');
      const updated: MockAlias = { ...existing, ...data, updatedAt: new Date() };
      aliasStore.set(where.id, updated);
      return updated;
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      aliasStore.delete(where.id);
      return { id: where.id };
    }),
    upsert: vi.fn(async ({ where, update, create }: { where: { characterId_alias: { characterId: string; alias: string } }; update: Partial<MockAlias>; create: Omit<MockAlias, 'id' | 'createdAt' | 'updatedAt'> }) => {
      for (const a of aliasStore.values()) {
        if (a.characterId === where.characterId_alias.characterId && a.alias === where.characterId_alias.alias) {
          const updated: MockAlias = { ...a, ...update, updatedAt: new Date() };
          aliasStore.set(a.id, updated);
          return updated;
        }
      }
      const row: MockAlias = {
        id: nextAliasId(),
        ...create,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      aliasStore.set(row.id, row);
      return row;
    }),
  },
  character: {
    findUnique: vi.fn(async ({ where, include }: { where: { id?: string; bookId_name?: { bookId: string; name: string } }; include?: { profile?: boolean; aliases?: boolean } }) => {
      let row: MockCharacter | undefined;
      if (where.id) row = characterStore.get(where.id);
      if (where.bookId_name) {
        for (const c of characterStore.values()) {
          if (c.bookId === where.bookId_name.bookId && c.name === where.bookId_name.name) { row = c; break; }
        }
      }
      if (!row) return null;
      const out: MockCharacter & { profile?: MockProfile | null; aliases?: MockAlias[] } = { ...row };
      if (include?.profile) out.profile = profileStore.get(row.id) ?? null;
      if (include?.aliases) {
        const aliases: MockAlias[] = [];
        for (const a of aliasStore.values()) if (a.characterId === row!.id) aliases.push(a);
        out.aliases = aliases.sort((x, y) => x.alias.localeCompare(y.alias));
      }
      return out;
    }),
    create: vi.fn(async ({ data }: { data: { id?: string; bookId: string; name: string; voiceId?: string | null; role?: string; age?: string | null; gender?: string | null; tone?: string | null } }) => {
      const id = data.id ?? `char-${characterStore.size + 1}`;
      const row: MockCharacter = {
        id, bookId: data.bookId, name: data.name,
        voiceId: data.voiceId ?? null, notes: null,
        role: data.role ?? 'supporting',
        age: data.age ?? null, gender: data.gender ?? null, tone: data.tone ?? null,
        createdAt: new Date(),
      };
      characterStore.set(id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MockCharacter> }) => {
      const existing = characterStore.get(where.id);
      if (!existing) throw new Error('not found');
      const updated: MockCharacter = { ...existing, ...data };
      characterStore.set(where.id, updated);
      return updated;
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      characterStore.delete(where.id);
      deleteOps.push(where.id);
      // Cascade aliases
      for (const [id, a] of aliasStore.entries()) {
        if (a.characterId === where.id) aliasStore.delete(id);
      }
      profileStore.delete(where.id);
      return { id: where.id };
    }),
  },
  characterProfile: {
    findUnique: vi.fn(async ({ where }: { where: { characterId: string } }) => profileStore.get(where.characterId) ?? null),
    create: vi.fn(async ({ data }: { data: Omit<MockProfile, 'updatedAt'> }) => {
      const row: MockProfile = { ...data, updatedAt: new Date() };
      profileStore.set(data.characterId, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { characterId: string }; data: Partial<MockProfile> }) => {
      const existing = profileStore.get(where.characterId);
      if (!existing) throw new Error('not found');
      const updated: MockProfile = { ...existing, ...data, updatedAt: new Date() };
      profileStore.set(where.characterId, updated);
      return updated;
    }),
  },
  characterChapterAppearance: {
    findMany: vi.fn(async ({ where }: { where: { characterId: string } }) =>
      appearanceStore.filter((a) => a.characterId === where.characterId),
    ),
    findUnique: vi.fn(async ({ where }: { where: { characterId_chapterIndex: { characterId: string; chapterIndex: number } } }) => {
      return appearanceStore.find((a) =>
        a.characterId === where.characterId_chapterIndex.characterId &&
        a.chapterIndex === where.characterId_chapterIndex.chapterIndex,
      ) ?? null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MockAppearance> }) => {
      const idx = appearanceStore.findIndex((a) => a.id === where.id);
      if (idx < 0) throw new Error('not found');
      appearanceStore[idx] = { ...appearanceStore[idx], ...data };
      return appearanceStore[idx];
    }),
  },
  characterRelationship: {
    updateMany: vi.fn(async ({ where, data }: { where: { bookId: string; fromCharId?: string; toCharId?: string }; data: { fromCharId?: string; toCharId?: string } }) => {
      const matches = relationshipOps.filter((r) => r && Object.entries(where).every(([k, v]) => {
        if (k === 'bookId') return true;
        return (r as Record<string, unknown>)[k] === v;
      }));
      for (const m of matches) {
        if (data.fromCharId) m.fromCharId = data.fromCharId;
        if (data.toCharId) m.toCharId = data.toCharId;
      }
      return { count: matches.length };
    }),
  },
  // The actual helpers wrap multi-step writes in `prisma.$transaction(async tx => ...)`.
  // Pass the full prismaMock so `tx.characterAlias.*` etc. all resolve.
  $transaction: async (fn: (tx: any) => Promise<any>) => fn(prismaMock),
});

// ── Imports (must come AFTER vi.mock) ───────────────────────────────────────

import { mergeCharacters, splitCharacter, patchCharacterAlias } from '@/lib/db/characters';

// ── Test helpers ────────────────────────────────────────────────────────────

function resetStores() {
  aliasStore.clear();
  characterStore.clear();
  profileStore.clear();
  appearanceStore.length = 0;
  relationshipOps.length = 0;
  deleteOps.length = 0;
  aliasIdCounter = 0;
}

function seedCharacter(id: string, bookId: string, name: string): MockCharacter {
  const row: MockCharacter = {
    id, bookId, name, voiceId: null, notes: null,
    role: 'supporting', age: null, gender: null, tone: null,
    createdAt: new Date(),
  };
  characterStore.set(id, row);
  return row;
}

function seedAlias(id: string, characterId: string, alias: string, confidence: number, source: MockAlias['source'] = 'user'): MockAlias {
  const row: MockAlias = {
    id, characterId, alias, confidence, source,
    detectedInChapter: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  aliasStore.set(id, row);
  return row;
}

function seedAppearance(id: string, characterId: string, chapterIndex: number, mentions: number): MockAppearance {
  const row: MockAppearance = { id, characterId, chapterIndex, mentions };
  appearanceStore.push(row);
  return row;
}

// ── mergeCharacters ─────────────────────────────────────────────────────────

describe('mergeCharacters', () => {
  beforeEach(() => resetStores());

  it('happy path: aliases reassigned, appearances summed, absorbed row deleted', async () => {
    seedCharacter('survivor', 'book-1', 'Linh');
    seedCharacter('absorbed', 'book-1', 'Linh Hồng');
    seedAlias('a1', 'survivor', 'Linh', 1.0);
    seedAlias('a2', 'absorbed', 'Linh Hồng', 0.85, 'llm');
    seedAppearance('app-1', 'absorbed', 0, 3);
    seedAppearance('app-2', 'absorbed', 1, 5);

    const result = await mergeCharacters('book-1', {
      survivorId: 'survivor',
      absorbedId: 'absorbed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.aliasesReassigned).toBe(1);
    expect(result.data.appearancesMerged).toBe(2);
    expect(deleteOps).toContain('absorbed');

    // The absorbed alias should now belong to the survivor
    const alias = aliasStore.get('a2');
    expect(alias?.characterId).toBe('survivor');
    expect(alias?.source).toBe('merge');

    // Absorbed character gone
    expect(characterStore.has('absorbed')).toBe(false);
    expect(characterStore.has('survivor')).toBe(true);
  });

  it('self-merge (survivorId === absorbedId) → error: self-merge', async () => {
    const result = await mergeCharacters('book-1', {
      survivorId: 'survivor',
      absorbedId: 'survivor',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('self-merge');
  });

  it('survivor not found → error: survivor-not-found', async () => {
    seedCharacter('absorbed', 'book-1', 'Linh');
    const result = await mergeCharacters('book-1', {
      survivorId: 'missing',
      absorbedId: 'absorbed',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('survivor-not-found');
  });

  it('absorbed not found → error: absorbed-not-found', async () => {
    seedCharacter('survivor', 'book-1', 'Linh');
    const result = await mergeCharacters('book-1', {
      survivorId: 'survivor',
      absorbedId: 'missing',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('absorbed-not-found');
  });

  it('user-locked profile field with differing absorbed value → error: profile-conflict', async () => {
    seedCharacter('survivor', 'book-1', 'Linh');
    seedCharacter('absorbed', 'book-1', 'Linh Hồng');
    profileStore.set('survivor', {
      characterId: 'survivor',
      description: 'User-locked description',
      personality: null, speechStyle: null, visualDescription: null,
      visualSource: 'user',
      fieldSources: JSON.stringify({ description: 'user' }),
      source: 'user',
      version: 1,
      updatedAt: new Date(),
    });
    profileStore.set('absorbed', {
      characterId: 'absorbed',
      description: 'LLM different description',
      personality: null, speechStyle: null, visualDescription: null,
      visualSource: 'llm',
      fieldSources: null,
      source: 'llm',
      version: 1,
      updatedAt: new Date(),
    });

    const result = await mergeCharacters('book-1', {
      survivorId: 'survivor',
      absorbedId: 'absorbed',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('profile-conflict');
    if (result.error.kind === 'profile-conflict') {
      expect(result.error.field).toBe('description');
    }
  });

  it('shared alias: higher-confidence version wins; tie → default to survivor', async () => {
    seedCharacter('survivor', 'book-1', 'Linh');
    seedCharacter('absorbed', 'book-1', 'Linh Hồng');
    seedAlias('a1', 'survivor', 'Linh chị', 0.9);
    seedAlias('a2', 'absorbed', 'Linh chị', 0.7);

    const result = await mergeCharacters('book-1', {
      survivorId: 'survivor',
      absorbedId: 'absorbed',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Survivor's higher-confidence alias kept, absorbed dropped
    expect(aliasStore.has('a1')).toBe(true);
    expect(aliasStore.has('a2')).toBe(false);
    expect(result.data.aliasesDeduplicated).toBe(1);
  });

  it('shared alias: caller can override via aliasResolutions', async () => {
    seedCharacter('survivor', 'book-1', 'Linh');
    seedCharacter('absorbed', 'book-1', 'Linh Hồng');
    seedAlias('a1', 'survivor', 'Linh chị', 0.9);
    seedAlias('a2', 'absorbed', 'Linh chị', 0.7);

    const result = await mergeCharacters('book-1', {
      survivorId: 'survivor',
      absorbedId: 'absorbed',
      aliasResolutions: [{ alias: 'Linh chị', keepOn: 'absorbed' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The absorbed alias was moved to survivor characterId and source='merge',
    // the survivor's old one was deleted.
    expect(aliasStore.has('a1')).toBe(false);
    const survivor = aliasStore.get('a2');
    expect(survivor?.characterId).toBe('survivor');
    expect(survivor?.source).toBe('merge');
  });
});

// ── splitCharacter ──────────────────────────────────────────────────────────

describe('splitCharacter', () => {
  beforeEach(() => resetStores());

  it('happy path: new character created, aliases moved with source=user', async () => {
    seedCharacter('source', 'book-1', 'Ông nội');
    seedAlias('a1', 'source', 'ông nội (họ nội)', 0.9);
    seedAlias('a2', 'source', 'ông nội (họ ngoại)', 0.9);

    const result = await splitCharacter('book-1', {
      characterId: 'source',
      aliasesToMove: ['ông nội (họ ngoại)'],
      newName: 'Ông ngoại',
      newRole: 'supporting',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.aliasesMoved).toBe(1);
    expect(result.data.aliasesKept).toBe(1);
    expect(result.data.appearancesMoved).toBe(false);

    // New character exists
    const newChar = [...characterStore.values()].find((c) => c.name === 'Ông ngoại');
    expect(newChar).toBeDefined();

    // The alias is on the new character with source='user'
    const movedAlias = aliasStore.get('a2');
    expect(movedAlias?.characterId).toBe(newChar?.id);
    expect(movedAlias?.source).toBe('user');

    // Original character kept the other alias
    const keptAlias = aliasStore.get('a1');
    expect(keptAlias?.characterId).toBe('source');
  });

  it('empty aliasesToMove → error: empty-aliases', async () => {
    seedCharacter('source', 'book-1', 'Ông nội');
    const result = await splitCharacter('book-1', {
      characterId: 'source',
      aliasesToMove: [],
      newName: 'Ông ngoại',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty-aliases');
  });

  it('newName collision → error: name-collision', async () => {
    seedCharacter('source', 'book-1', 'Ông nội');
    seedCharacter('existing', 'book-1', 'Ông ngoại');
    const result = await splitCharacter('book-1', {
      characterId: 'source',
      aliasesToMove: ['ông nội'],
      newName: 'Ông ngoại',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('name-collision');
    if (result.error.kind === 'name-collision') {
      expect(result.error.existingCharacterId).toBe('existing');
    }
  });

  it('source character not found → error: survivor-not-found', async () => {
    const result = await splitCharacter('book-1', {
      characterId: 'missing',
      aliasesToMove: ['ông nội'],
      newName: 'Ông ngoại',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('survivor-not-found');
  });
});

// ── patchCharacterAlias ─────────────────────────────────────────────────────

describe('patchCharacterAlias', () => {
  beforeEach(() => resetStores());

  it('marks alias as wrong (confidence=0, source=user)', async () => {
    seedCharacter('c1', 'book-1', 'Linh');
    seedAlias('a1', 'c1', 'cô bé bí ẩn', 0.65, 'llm');
    const result = await patchCharacterAlias('c1', 'book-1', {
      aliasId: 'a1',
      confidence: 0,
      source: 'user',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confidence).toBe(0);
    expect(result.data.source).toBe('user');
  });

  it('clamps confidence to [0, 1]', async () => {
    seedCharacter('c1', 'book-1', 'Linh');
    seedAlias('a1', 'c1', 'Linh', 0.5);
    const result = await patchCharacterAlias('c1', 'book-1', {
      aliasId: 'a1',
      confidence: 1.5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confidence).toBe(1);

    const result2 = await patchCharacterAlias('c1', 'book-1', {
      aliasId: 'a1',
      confidence: -0.5,
    });
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.data.confidence).toBe(0);
  });

  it('alias not found → error', async () => {
    const result = await patchCharacterAlias('c1', 'book-1', {
      aliasId: 'missing',
      confidence: 0.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('survivor-not-found');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  queueDiff: vi.fn(),
  ensureCharacter: vi.fn(),
  setProfile: vi.fn(),
  mergeLlmProfilePatch: vi.fn(),
  addOrUpdateRelationship: vi.fn(),
  recordAppearances: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({
  character: {
    findFirst: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock('@/lib/db/character-bible', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/character-bible')>();
  return {
    ...actual,
    getCharacterBible: vi.fn(),
    resolveCharacterIds: vi.fn(),
    queueDiff: db.queueDiff,
    ensureCharacter: db.ensureCharacter,
    setProfile: db.setProfile,
    mergeLlmProfilePatch: db.mergeLlmProfilePatch,
    addOrUpdateRelationship: db.addOrUpdateRelationship,
    recordAppearances: db.recordAppearances,
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/ai/index', () => ({
  chatJSON: vi.fn(),
  JsonChatError: class JsonChatError extends Error {},
}));

import {
  applyAcceptedBiblePatch,
  applyBiblePatch,
  setUserProfile,
} from '@/lib/ai/character-bible';

describe('Character Bible review/commit boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.queueDiff.mockResolvedValue('diff-1');
    db.ensureCharacter.mockResolvedValue({ id: 'char-new', created: true });
    db.setProfile.mockResolvedValue({ updated: true });
    db.mergeLlmProfilePatch.mockResolvedValue({ applied: ['description'], skipped: [], conflicts: [] });
    db.addOrUpdateRelationship.mockResolvedValue({ id: 'rel-1', updated: true });
    db.recordAppearances.mockResolvedValue({ added: 1, skipped: [] });
    prismaMock.character.findFirst.mockResolvedValue({ id: 'char-1', name: 'Lan' });
    prismaMock.character.count.mockResolvedValue(2);
  });

  it('manual refresh queues an update without mutating the profile', async () => {
    const patch = {
      kind: 'update' as const,
      characterId: 'char-1',
      updateFields: { description: 'Mô tả mới' },
      evidenceQuote: '“Lan bước vào phòng.”',
      autoReason: 'non-conflicting-update' as const,
    };
    const result = await applyBiblePatch('book-1', patch, false);
    expect(result).toEqual({ applied: false, isConflict: false });
    expect(db.queueDiff).toHaveBeenCalledWith('book-1', expect.objectContaining({ autoReason: 'user-hold' }));
    expect(db.mergeLlmProfilePatch).not.toHaveBeenCalled();
  });

  it('does not convert omitted update fields to destructive nulls', async () => {
    await applyBiblePatch('book-1', {
      kind: 'update',
      characterId: 'char-1',
      updateFields: { description: 'Chỉ thay mô tả' },
      evidenceQuote: '“Lan bước vào phòng.”',
      autoReason: 'non-conflicting-update',
    }, true);
    expect(db.mergeLlmProfilePatch).toHaveBeenCalledWith({
      characterId: 'char-1',
      description: 'Chỉ thay mô tả',
      personality: undefined,
      speechStyle: undefined,
      visualDescription: undefined,
    });
  });

  it('explicit acceptance actually creates a proposed character', async () => {
    const result = await applyAcceptedBiblePatch('book-1', {
      kind: 'new',
      characterId: null,
      newCharacter: { name: 'Minh', aliases: ['A Minh'], gender: 'male', role: 'supporting' },
      evidenceQuote: '“Minh lên tiếng.”',
      autoReason: 'new-character',
    });
    expect(result.applied).toBe(true);
    expect(db.ensureCharacter).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'book-1', name: 'Minh' }));
    expect(db.queueDiff).not.toHaveBeenCalled();
  });

  it('user profile edits lock exactly the fields they touched', async () => {
    await setUserProfile({ characterId: 'char-1', description: 'Tự sửa', personality: null });
    expect(db.setProfile).toHaveBeenCalledWith(expect.objectContaining({
      characterId: 'char-1',
      source: 'user',
      force: true,
      fieldSources: { description: 'user', personality: 'user' },
    }));
  });

  it('accepted appearance is recorded for a character in the same book', async () => {
    const result = await applyAcceptedBiblePatch('book-1', {
      kind: 'appearance',
      characterId: 'char-1',
      appearance: { chapterIndex: 3, mentions: 1 },
      evidenceQuote: '“Lan bước vào phòng.”',
      autoReason: 'non-conflicting-update',
    });
    expect(result.applied).toBe(true);
    expect(db.recordAppearances).toHaveBeenCalledWith({
      bookId: 'book-1', chapterIndex: 3, names: ['Lan'],
    });
  });
});

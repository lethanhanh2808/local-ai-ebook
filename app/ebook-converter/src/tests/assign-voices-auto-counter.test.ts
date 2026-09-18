// src/tests/assign-voices-auto-counter.test.ts
//
// Unit tests for the bulk auto-assign route. We mock the DB character
// list and the picker to drive the response shape through the
// scenarios that surfaced the "assigned: 0" bug from the code review.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted — wrap the stub factories with `vi.hoisted` so
// the references exist before the mock factory closure runs.
type PickerItem = { characterId: string; name: string; builtinName: string; isNew: boolean };
const { listCharactersMock, assignVoicesToCharactersMock } = vi.hoisted(() => {
  const listCharactersMock = vi.fn<(bookId: string) => Promise<unknown[]>>();
  // Cast the return so TS doesn't widen Promise<unknown[]> to
  // PromiseConstructorLike inside the vi.fn type slot.
  const assignVoicesToCharactersMock = vi.fn(
    (_bookId: string, _detected: unknown[]): Promise<PickerItem[]> => Promise.resolve([]),
  );
  return { listCharactersMock, assignVoicesToCharactersMock };
});

vi.mock('@/lib/db/voices', () => ({
  listCharacters: listCharactersMock,
}));
vi.mock('@/lib/ai/voice-selector', () => ({
  assignVoicesToCharacters: assignVoicesToCharactersMock,
}));

// Lazy import AFTER mock setup so the module binds the stub.
import { POST } from '@/app/api/library/[id]/characters/assign-voices-auto/route';
import type { NextRequest } from 'next/server';

function makeReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/library/test/characters/assign-voices-auto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function callRoute(bookId: string, body: unknown) {
  const req = makeReq(body);
  return POST(req, { params: Promise.resolve({ id: bookId }) });
}

describe('POST /characters/assign-voices-auto', () => {
  beforeEach(() => {
    listCharactersMock.mockReset();
    assignVoicesToCharactersMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns assigned count even when every picker result reused an existing voice row', async () => {
    // This is the regression scenario from the code review: the
    // selector reused pre-existing voice rows (`isNew: false`) for
    // all 5 characters, but the previous route counted only `wasNew`
    // rows — reporting `assigned: 0` to the UI even though every
    // character actually got a voice.
    listCharactersMock.mockResolvedValue([
      { id: 'c1', bookId: 'b', name: 'A', role: 'supporting', gender: 'female', voiceId: null },
      { id: 'c2', bookId: 'b', name: 'B', role: 'supporting', gender: 'female', voiceId: null },
      { id: 'c3', bookId: 'b', name: 'C', role: 'minor',      gender: 'male',   voiceId: null },
      { id: 'c4', bookId: 'b', name: 'D', role: 'supporting', gender: 'male',   voiceId: null },
      { id: 'c5', bookId: 'b', name: 'E', role: 'crowd',      gender: 'female', voiceId: null },
    ]);
    assignVoicesToCharactersMock.mockResolvedValue([
      { characterId: 'c1', name: 'A', builtinName: 'minh-anh', isNew: false },
      { characterId: 'c2', name: 'B', builtinName: 'minh-anh', isNew: false },
      { characterId: 'c3', name: 'C', builtinName: 'xuân-vĩnh', isNew: false },
      { characterId: 'c4', name: 'D', builtinName: 'tấn-dũng', isNew: false },
      { characterId: 'c5', name: 'E', builtinName: 'thu-hà', isNew: false },
    ]);

    const res = await callRoute('b', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBe(5);
    expect(body.considered).toBe(5);
    expect(body.assigned).toBe(5); // <-- was 0 before the fix
    expect(body.created).toBe(0);  // no NEW voice rows were minted
    expect(body.items).toHaveLength(5);
    for (const item of body.items) {
      expect(item.wasNew).toBe(false);
    }
  });

  it('reports both assigned and created when the picker creates new rows', async () => {
    listCharactersMock.mockResolvedValue([
      { id: 'c1', bookId: 'b', name: 'A', role: 'supporting', gender: 'female', voiceId: null },
      { id: 'c2', bookId: 'b', name: 'B', role: 'supporting', gender: 'female', voiceId: null },
    ]);
    assignVoicesToCharactersMock.mockResolvedValue([
      { characterId: 'c1', name: 'A', builtinName: 'ngọc-linh', isNew: true },
      { characterId: 'c2', name: 'B', builtinName: 'minh-anh', isNew: false },
    ]);

    const res = await callRoute('b', {});
    const body = await res.json();
    expect(body.assigned).toBe(2);
    expect(body.created).toBe(1);
  });

  it('returns 0 assigned when no eligible characters remain', async () => {
    listCharactersMock.mockResolvedValue([
      { id: 'c1', bookId: 'b', name: 'A', role: 'main',       gender: 'female', voiceId: 'v1' },
      { id: 'c2', bookId: 'b', name: 'B', role: 'supporting', gender: null,     voiceId: null }, // unknown gender → skipped without opt-in
    ]);

    const res = await callRoute('b', {});
    const body = await res.json();
    expect(body.assigned).toBe(0);
    expect(body.scanned).toBe(2);
    expect(body.alreadyHadVoice).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('includes alreadyHadVoice count for users with prior voice assignments', async () => {
    listCharactersMock.mockResolvedValue([
      { id: 'c1', bookId: 'b', name: 'A', role: 'supporting', gender: 'female', voiceId: 'v1' },
      { id: 'c2', bookId: 'b', name: 'B', role: 'supporting', gender: 'female', voiceId: null },
    ]);
    assignVoicesToCharactersMock.mockResolvedValue([
      { characterId: 'c2', name: 'B', builtinName: 'ngọc-linh', isNew: true },
    ]);

    const res = await callRoute('b', {});
    const body = await res.json();
    expect(body.assigned).toBe(1);
    expect(body.alreadyHadVoice).toBe(1); // A had a voice, B didn't
  });

  it('honors roleScope', async () => {
    listCharactersMock.mockResolvedValue([
      { id: 'c1', bookId: 'b', name: 'A', role: 'supporting', gender: 'female', voiceId: null },
      { id: 'c2', bookId: 'b', name: 'B', role: 'minor',      gender: 'male',   voiceId: null },
      { id: 'c3', bookId: 'b', name: 'C', role: 'crowd',      gender: 'female', voiceId: null },
    ]);
    assignVoicesToCharactersMock.mockResolvedValue([
      { characterId: 'c2', name: 'B', builtinName: 'xuân-vĩnh', isNew: true },
    ]);

    const res = await callRoute('b', { roleScope: 'minor' });
    const body = await res.json();
    expect(body.considered).toBe(1);
    expect(body.assigned).toBe(1);
    // Selector should only be called with the 'minor' target.
    expect(assignVoicesToCharactersMock).toHaveBeenCalledWith(
      'b',
      [expect.objectContaining({ name: 'B' })],
    );
  });
});

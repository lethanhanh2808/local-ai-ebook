// src/lib/db/voices.ts
// CRUD helpers for Voice + Character models (per-book TTS voice assignments)
import { prisma } from './client';

export interface CreateVoiceInput {
  bookId: string;
  name: string;
  description?: string;
  refAudioPath: string;
  language?: string;
  isDefault?: boolean;
  defaultSpeed?: number;
  defaultEmotion?: string;
  kind?: string;
  builtinName?: string | null;
}

export async function listVoices(bookId: string) {
  return prisma.voice.findMany({
    where: { bookId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function getVoice(id: string) {
  return prisma.voice.findUnique({ where: { id } });
}

export async function getDefaultVoice(bookId: string) {
  // Get explicit default voice if any, else the first voice created for the book.
  const explicit = await prisma.voice.findFirst({
    where: { bookId, isDefault: true },
  });
  return explicit ?? prisma.voice.findFirst({
    where: { bookId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createVoice(input: CreateVoiceInput) {
  // Keep "unset old default + create new default" atomic. Without a
  // transaction, a failed insert left the book with no explicit narrator.
  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.voice.updateMany({
        where: { bookId: input.bookId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.voice.create({
      data: {
        ...input,
        language: input.language ?? 'vi',
        isDefault: input.isDefault ?? false,
        kind: input.kind ?? 'character',
        builtinName: input.builtinName ?? null,
      },
    });
  });
}

export async function updateVoice(id: string, data: Partial<Omit<CreateVoiceInput, 'bookId'>>) {
  return prisma.$transaction(async (tx) => {
    if (data.isDefault === true) {
      const voice = await tx.voice.findUnique({ where: { id } });
      if (!voice) throw new Error('Voice not found');
      await tx.voice.updateMany({
        where: { bookId: voice.bookId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      });
    }
    return tx.voice.update({ where: { id }, data });
  });
}

export async function deleteVoice(id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.character.updateMany({
      where: { voiceId: id },
      data: { voiceId: null },
    });
    return tx.voice.delete({ where: { id } });
  });
}

// ── Characters ───────────────────────────────────────────────────────────────

export interface CreateCharacterInput {
  bookId: string;
  name: string;
  aliases?: string[];
  voiceId?: string | null;
  notes?: string;
}

export async function listCharacters(bookId: string) {
  const chars = await prisma.character.findMany({
    where: { bookId },
    include: { voice: true },
    orderBy: { name: 'asc' },
  });
  return chars.map((c) => ({
    ...c,
    aliases: parseAliases(c.aliases),
  }));
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export async function upsertCharacters(
  bookId: string,
  characters: Array<{
    name: string;
    aliases?: string[];
    voiceId?: string | null;
    role?: string;
    age?: string | null;
    /** Detected gender (male|female|unknown|null). Persisted so the voice
     * picker can re-score on subsequent selections. */
    gender?: string | null;
    /** Detected tone (e.g. calm|cheerful|cold|mysterious|warm). Persisted
     * so the picker stays consistent across sessions. */
    tone?: string | null;
  }>,
) {
  const requestedVoiceIds = [...new Set(
    characters.map((c) => c.voiceId).filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];
  if (requestedVoiceIds.length > 0) {
    const owned = await prisma.voice.findMany({
      where: { bookId, id: { in: requestedVoiceIds } },
      select: { id: true },
    });
    if (owned.length !== requestedVoiceIds.length) {
      throw new Error('One or more character voices do not belong to this book');
    }
  }
  // Use upsert pattern; idempotent.
  const ops = characters.map((c) =>
    prisma.character.upsert({
      where: { bookId_name: { bookId, name: c.name } },
      create: {
        bookId,
        name: c.name,
        aliases: c.aliases ? JSON.stringify(c.aliases) : null,
        voiceId: c.voiceId ?? null,
        role: c.role ?? 'supporting',
        age: c.age ?? null,
        gender: c.gender ?? null,
        tone: c.tone ?? null,
      },
      update: {
        ...(c.aliases ? { aliases: JSON.stringify(c.aliases) } : {}),
        ...(c.voiceId !== undefined ? { voiceId: c.voiceId } : {}),
        ...(c.role ? { role: c.role } : {}),
        ...(c.age ? { age: c.age } : {}),
        // For gender/tone, only overwrite when an actual value is provided
        // (not 'unknown'/null) so re-runs don't blank out earlier detections.
        ...(c.gender && c.gender !== 'unknown' ? { gender: c.gender } : {}),
        ...(c.tone && c.tone !== 'unknown' ? { tone: c.tone } : {}),
      },
    }),
  );
  return Promise.all(ops);
}

export async function setCharacterVoice(id: string, voiceId: string | null) {
  return prisma.$transaction(async (tx) => {
    const character = await tx.character.findUnique({ where: { id }, select: { bookId: true } });
    if (!character) throw new Error('Character not found');
    if (voiceId) {
      const voice = await tx.voice.findUnique({ where: { id: voiceId }, select: { bookId: true } });
      if (!voice || voice.bookId !== character.bookId) {
        throw new Error('Voice does not belong to the character book');
      }
    }
    return tx.character.update({ where: { id }, data: { voiceId } });
  });
}

export async function deleteCharacter(id: string) {
  return prisma.character.delete({ where: { id } });
}

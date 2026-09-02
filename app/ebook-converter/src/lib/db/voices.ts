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
    include: {
      voice: true,
      aliases: { orderBy: { alias: 'asc' } },
    },
    orderBy: { name: 'asc' },
  });
  return chars.map((c) => ({
    ...c,
    // Phase 4.4: aliases are now a structured array of rows from
    // CharacterAlias. Wire shape (preserved for existing consumers):
    //   aliases: string[]                      — just the strings
    //   aliasDetails: { alias, confidence, source, detectedInChapter? }[]
    // Existing callers that iterate `c.aliases` (CharacterDetection,
    // VoicePanel) keep working unchanged. New code (CharacterMergeSplitPanel)
    // reads `aliasDetails` for confidence badges.
    aliases: c.aliases.map((a) => a.alias),
    aliasDetails: c.aliases.map((a) => ({
      id: a.id,
      alias: a.alias,
      confidence: a.confidence,
      source: a.source,
      detectedInChapter: a.detectedInChapter ?? null,
    })),
  }));
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
    /** Per-character voice customization. When the character's voice is a
     * built-in name that gets a Voice row auto-created on apply, these are
     * written to that Voice so the audiobook generator uses the user's
     * chosen pace/emotion. */
    defaultSpeed?: number;
    defaultEmotion?: string;
    /** Per-alias confidence + source. Phase 4.4 — optional. When provided,
     *  each entry writes a CharacterAlias row with the given confidence &
     *  source instead of the default (1.0 / 'user'). The string-array
     *  `aliases` is still required for back-compat. */
    aliasDetails?: Array<{
      alias: string;
      confidence?: number;
      source?: 'user' | 'llm' | 'merge' | 'legacy';
      detectedInChapter?: number | null;
    }>;
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
  // Phase 4.4 — alias write-through. For each character, write/update the
  // matching CharacterAlias rows in addition to the Character row itself.
  // The transaction wrapper ensures the alias rows land atomically with
  // the roster change.
  const ops = characters.map((c) =>
    prisma.$transaction(async (tx) => {
      const character = await tx.character.upsert({
        where: { bookId_name: { bookId, name: c.name } },
        create: {
          bookId,
          name: c.name,
          voiceId: c.voiceId ?? null,
          role: c.role ?? 'supporting',
          age: c.age ?? null,
          gender: c.gender ?? null,
          tone: c.tone ?? null,
        },
        update: {
          ...(c.voiceId !== undefined ? { voiceId: c.voiceId } : {}),
          ...(c.role ? { role: c.role } : {}),
          ...(c.age ? { age: c.age } : {}),
          // For gender/tone, only overwrite when an actual value is provided
          // (not 'unknown'/null) so re-runs don't blank out earlier detections.
          ...(c.gender && c.gender !== 'unknown' ? { gender: c.gender } : {}),
          ...(c.tone && c.tone !== 'unknown' ? { tone: c.tone } : {}),
        },
      });

      // Persist per-voice customization (speed/emotion) onto the assigned
      // Voice row so the audiobook generator picks it up. Only write when the
      // caller explicitly provided a value, to avoid clobbering existing ones.
      if (c.voiceId && (c.defaultSpeed !== undefined || c.defaultEmotion !== undefined)) {
        const existing = await tx.voice.findUnique({
          where: { id: c.voiceId },
          select: { defaultSpeed: true, defaultEmotion: true },
        });
        await tx.voice.update({
          where: { id: c.voiceId },
          data: {
            ...(c.defaultSpeed !== undefined && existing?.defaultSpeed == null
              ? { defaultSpeed: c.defaultSpeed } : {}),
            ...(c.defaultEmotion !== undefined && existing?.defaultEmotion == null
              ? { defaultEmotion: c.defaultEmotion } : {}),
          },
        });
      }

      // Sync CharacterAlias rows.
      if (c.aliases && c.aliases.length > 0) {
        // Build a per-alias map of caller-provided confidence + source
        // (from aliasDetails) so we can write per-row scores. Falls back
        // to (1.0, 'user') for aliases not present in aliasDetails.
        const detailMap = new Map(
          (c.aliasDetails ?? []).map((d) => [d.alias.trim().toLowerCase(), d]),
        );
        for (const alias of c.aliases) {
          const trimmed = alias.trim();
          if (!trimmed) continue;
          const lower = trimmed.toLowerCase();
          const detail = detailMap.get(lower);
          const confidence = typeof detail?.confidence === 'number'
            ? Math.max(0, Math.min(1, detail.confidence))
            : 1.0;
          const source = detail?.source ?? 'user';
          const detectedInChapter = detail?.detectedInChapter ?? null;

          // Upsert by (characterId, alias) — uses the unique index.
          // delete + create pattern is needed because upsert needs a where
          // on a unique field, and the upsert shortcut with raw SQL would
          // duplicate the index logic.
          const existing = await tx.characterAlias.findUnique({
            where: { characterId_alias: { characterId: character.id, alias: trimmed } },
          });
          if (existing) {
            // Only update confidence + source if the caller actually
            // provided them — never overwrite a user-locked alias with a
            // blank/default entry.
            if (detail) {
              await tx.characterAlias.update({
                where: { id: existing.id },
                data: {
                  confidence,
                  source,
                  ...(detectedInChapter != null ? { detectedInChapter } : {}),
                },
              });
            }
          } else {
            await tx.characterAlias.create({
              data: {
                characterId: character.id,
                alias: trimmed,
                confidence,
                source,
                detectedInChapter,
              },
            });
          }
        }
      }

      return character;
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

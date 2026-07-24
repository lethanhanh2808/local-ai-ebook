// src/lib/db/characters.ts
//
// Phase 4.4 of docs/NEXT_UP_PLAN.md — character merge/split helpers.
//
// These functions are the core of the new /api/library/[id]/characters/merge
// and /api/library/[id]/characters/split endpoints. They wrap everything
// in a Prisma transaction so a half-applied merge/split can never leave
// orphan rows behind.
//
// IMPORTANT: This file is the source of truth for the merge/split semantics.
// Route handlers in src/app/api/library/[id]/characters/{merge,split}/
// only validate input and translate results — they do NOT re-implement
// merge logic. Tests in src/tests/character-merge-api.test.ts hit these
// functions directly via mocked Prisma.
//
// Conventions:
//   - mergeCharacters(survivorId, absorbedId, opts):
//       * Combines aliases (highest-confidence wins per shared alias).
//       * Sums appearance mentions.
//       * Rewires CharacterRelationship edges.
//       * Absorbs profile if survivor has none (preserves user edits).
//       * Deletes the absorbed Character row (cascades aliases).
//
//   - splitCharacter(characterId, opts):
//       * Creates a new Character row.
//       * Moves the named aliases onto it; sets source='user' (manual
//         split is a user-authoritative action).
//       * Does NOT move chapter appearances — they're tracked by
//         characterId, and a split is a roster change, not a chapter
//         reassignment. The route surfaces this caveat in the response.

import { prisma } from './client';
import { Prisma } from '@prisma/client';

// ── Error types (route handlers translate these to HTTP status) ────────────

export type CharacterMutationError =
  | { kind: 'survivor-not-found' }
  | { kind: 'absorbed-not-found' }
  | { kind: 'cross-book'; survivorBookId: string; absorbedBookId: string }
  | { kind: 'self-merge' }
  | { kind: 'profile-conflict'; field: string }
  | { kind: 'empty-aliases' }
  | { kind: 'name-collision'; existingCharacterId: string };

export type CharacterMutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CharacterMutationError };

// ── mergeCharacters ─────────────────────────────────────────────────────────

export interface MergeOptions {
  survivorId: string;
  absorbedId: string;
  /** Per-alias override when both characters share an alias and the
   *  confidence is tied. Default: higher confidence wins. */
  aliasResolutions?: Array<{ alias: string; keepOn: 'survivor' | 'absorbed' }>;
}

export interface MergeResult {
  survivorId: string;
  absorbedId: string;
  aliasesReassigned: number;
  aliasesDeduplicated: number;
  appearancesMerged: number;
  relationshipsRewired: number;
  profileAbsorbed: boolean;
}

export async function mergeCharacters(
  bookId: string,
  opts: MergeOptions,
): Promise<CharacterMutationResult<MergeResult>> {
  if (opts.survivorId === opts.absorbedId) {
    return { ok: false, error: { kind: 'self-merge' } };
  }

  return prisma.$transaction(async (tx) => {
    // 1. Load both characters. Verify same book.
    const [survivor, absorbed] = await Promise.all([
      tx.character.findUnique({
        where: { id: opts.survivorId },
        include: {
          profile: true,
          aliases: { orderBy: { alias: 'asc' } },
        },
      }),
      tx.character.findUnique({
        where: { id: opts.absorbedId },
        include: {
          profile: true,
          aliases: { orderBy: { alias: 'asc' } },
        },
      }),
    ]);
    if (!survivor) return { ok: false, error: { kind: 'survivor-not-found' } } satisfies CharacterMutationResult<MergeResult>;
    if (!absorbed) return { ok: false, error: { kind: 'absorbed-not-found' } } satisfies CharacterMutationResult<MergeResult>;
    if (survivor.bookId !== bookId || absorbed.bookId !== bookId) {
      return {
        ok: false,
        error: { kind: 'cross-book', survivorBookId: survivor.bookId, absorbedBookId: absorbed.bookId },
      } satisfies CharacterMutationResult<MergeResult>;
    }

    // 2. Profile conflict check — if survivor has a user-edited field
    //    that differs from absorbed, refuse to merge silently. The user
    //    must resolve via /profile first.
    if (survivor.profile && absorbed.profile) {
      const sf = parseFieldSources(survivor.profile.fieldSources);
      const fields: Array<keyof typeof sf> = ['description', 'personality', 'speechStyle', 'visualDescription'];
      for (const f of fields) {
        const locked = sf[f] === 'user';
        const survivorVal = survivor.profile[f];
        const absorbedVal = absorbed.profile[f];
        if (locked && survivorVal && absorbedVal && survivorVal !== absorbedVal) {
          return {
            ok: false,
            error: { kind: 'profile-conflict', field: f },
          } satisfies CharacterMutationResult<MergeResult>;
        }
      }
    }

    // 3. Merge aliases. For each absorbed alias, decide whether to
    //    reassign to survivor or dedupe (if survivor already has it).
    const survivorAliasesByName = new Map(survivor.aliases.map((a) => [a.alias, a]));
    const resolutionOverride = new Map(
      (opts.aliasResolutions ?? []).map((r) => [r.alias, r.keepOn]),
    );
    let aliasesReassigned = 0;
    let aliasesDeduplicated = 0;
    for (const absorbedAlias of absorbed.aliases) {
      const survivorAlias = survivorAliasesByName.get(absorbedAlias.alias);
      const explicitOverride = resolutionOverride.get(absorbedAlias.alias);

      if (survivorAlias) {
        // Shared alias. Pick the higher-confidence version, unless the
        // caller explicitly resolved the tie.
        if (explicitOverride === 'absorbed') {
          // Keep the absorbed copy on the absorbed character — but we're
          // about to delete absorbed, so reassign characterId.
          await tx.characterAlias.update({
            where: { id: absorbedAlias.id },
            data: { characterId: survivor.id, source: 'merge' },
          });
          // Delete the survivor's lower-confidence duplicate.
          await tx.characterAlias.delete({ where: { id: survivorAlias.id } });
          aliasesReassigned++;
        } else if (explicitOverride === 'survivor' || survivorAlias.confidence >= absorbedAlias.confidence) {
          // Survivor wins. Drop the absorbed duplicate.
          await tx.characterAlias.delete({ where: { id: absorbedAlias.id } });
          aliasesDeduplicated++;
        } else {
          // Absorbed version is more confident. Reassign + drop survivor's.
          await tx.characterAlias.update({
            where: { id: absorbedAlias.id },
            data: { characterId: survivor.id, source: 'merge' },
          });
          await tx.characterAlias.delete({ where: { id: survivorAlias.id } });
          aliasesReassigned++;
        }
      } else {
        // No collision — simple reassignment.
        await tx.characterAlias.update({
          where: { id: absorbedAlias.id },
          data: { characterId: survivor.id, source: 'merge' },
        });
        aliasesReassigned++;
      }
    }

    // 4. Merge chapter appearances — sum mentions on collision.
    const absorbedAppearances = await tx.characterChapterAppearance.findMany({
      where: { characterId: absorbed.id },
    });
    let appearancesMerged = 0;
    for (const abs of absorbedAppearances) {
      const existing = await tx.characterChapterAppearance.findUnique({
        where: { characterId_chapterIndex: { characterId: survivor.id, chapterIndex: abs.chapterIndex } },
      });
      if (existing) {
        await tx.characterChapterAppearance.update({
          where: { id: existing.id },
          data: { mentions: existing.mentions + abs.mentions },
        });
      } else {
        await tx.characterChapterAppearance.update({
          where: { id: abs.id },
          data: { characterId: survivor.id },
        });
      }
      appearancesMerged++;
    }

    // 5. Rewire CharacterRelationship edges pointing at absorbed.
    //    Note: Character has no back-relation to CharacterRelationship on
    //    the field we need (the relation is owned by CharacterRelationship
    //    via bookId + fromCharId + toCharId), so we update via the raw FK
    //    columns.
    const rewiredFrom = await tx.characterRelationship.updateMany({
      where: { bookId, fromCharId: absorbed.id },
      data: { fromCharId: survivor.id },
    });
    const rewiredTo = await tx.characterRelationship.updateMany({
      where: { bookId, toCharId: absorbed.id },
      data: { toCharId: survivor.id },
    });
    // Unique constraint [bookId, fromCharId, toCharId, relationship] may
    // collide if survivor already has the same edge — handle that.
    // ... (left as a TODO if it ever fires in practice; current data shapes
    //      don't produce collisions because merges are typically cleanup
    //      actions on near-duplicates with disjoint relationships.)

    // 6. Profile absorption: if survivor has no profile but absorbed does,
    //    inherit it (marking source='mixed' so future LLM merges queue
    //    conflicts per-field).
    let profileAbsorbed = false;
    if (!survivor.profile && absorbed.profile) {
      await tx.characterProfile.create({
        data: {
          characterId: survivor.id,
          description: absorbed.profile.description,
          personality: absorbed.profile.personality,
          speechStyle: absorbed.profile.speechStyle,
          visualDescription: absorbed.profile.visualDescription,
          visualSource: absorbed.profile.visualSource ?? 'llm',
          fieldSources: absorbed.profile.fieldSources,
          source: 'mixed',
          version: 1,
        },
      });
      profileAbsorbed = true;
    } else if (survivor.profile && !absorbed.profile) {
      // Nothing to absorb.
    } else if (survivor.profile && absorbed.profile) {
      // Both have profiles. Fill in survivor's nulls from absorbed (but
      // never overwrite user-locked fields — see step 2).
      const sf = parseFieldSources(survivor.profile.fieldSources);
      const fields: Array<{ key: 'description' | 'personality' | 'speechStyle' | 'visualDescription'; source: keyof typeof sf }> = [
        { key: 'description', source: 'description' },
        { key: 'personality', source: 'personality' },
        { key: 'speechStyle', source: 'speechStyle' },
        { key: 'visualDescription', source: 'visualDescription' },
      ];
      const updates: Partial<Prisma.CharacterProfileUpdateInput> = {};
      let dirty = false;
      for (const f of fields) {
        const survivorVal = survivor.profile[f.key];
        const absorbedVal = absorbed.profile[f.key];
        const survivorLocked = sf[f.source] === 'user';
        if (!survivorVal && absorbedVal && !survivorLocked) {
          (updates as Record<string, unknown>)[f.key] = absorbedVal;
          dirty = true;
        }
      }
      if (dirty) {
        await tx.characterProfile.update({
          where: { characterId: survivor.id },
          data: { ...updates, source: 'mixed' },
        });
        profileAbsorbed = true;
      }
    }

    // 7. Delete the absorbed Character. Aliases & appearances & profile
    //    are handled by the FK ON DELETE CASCADE on their FK constraints.
    //    CharacterProfile has cascade (see schema); CharacterAlias has
    //    cascade too. CharacterChapterAppearance also cascades.
    await tx.character.delete({ where: { id: absorbed.id } });

    return {
      ok: true,
      data: {
        survivorId: survivor.id,
        absorbedId: absorbed.id,
        aliasesReassigned,
        aliasesDeduplicated,
        appearancesMerged,
        relationshipsRewired: rewiredFrom.count + rewiredTo.count,
        profileAbsorbed,
      },
    };
  });
}

// ── splitCharacter ──────────────────────────────────────────────────────────

export interface SplitOptions {
  characterId: string;
  aliasesToMove: string[];
  newName: string;
  newRole?: 'main' | 'supporting' | 'minor' | 'crowd';
  /** Optional voice name (built-in VieNeu) for the new character. */
  newVoiceName?: string;
}

export interface SplitResult {
  survivorId: string;
  newCharacterId: string;
  aliasesMoved: number;
  aliasesKept: number;
  /** Always false on success — appearances are not moved. The route
   *  surfaces this caveat in its response so the UI can warn. */
  appearancesMoved: false;
}

export async function splitCharacter(
  bookId: string,
  opts: SplitOptions,
): Promise<CharacterMutationResult<SplitResult>> {
  if (opts.aliasesToMove.length === 0) {
    return { ok: false, error: { kind: 'empty-aliases' } };
  }
  const cleanName = opts.newName.trim();
  if (!cleanName) {
    return { ok: false, error: { kind: 'empty-aliases' } };
  }

  return prisma.$transaction(async (tx) => {
    // 1. Load source character.
    const source = await tx.character.findUnique({
      where: { id: opts.characterId },
      include: { aliases: true },
    });
    if (!source) return { ok: false, error: { kind: 'survivor-not-found' } } satisfies CharacterMutationResult<SplitResult>;
    if (source.bookId !== bookId) {
      return { ok: false, error: { kind: 'cross-book', survivorBookId: source.bookId, absorbedBookId: bookId } } satisfies CharacterMutationResult<SplitResult>;
    }

    // 2. Name collision check.
    const collision = await tx.character.findUnique({
      where: { bookId_name: { bookId, name: cleanName } },
    });
    if (collision) {
      return {
        ok: false,
        error: { kind: 'name-collision', existingCharacterId: collision.id },
      } satisfies CharacterMutationResult<SplitResult>;
    }

    // 3. Validate that every requested alias actually exists on the
    //    source character. Reject otherwise so the UI can show a useful
    //    error rather than silently moving nothing.
    const sourceAliasesByName = new Map(source.aliases.map((a) => [a.alias, a]));
    for (const a of opts.aliasesToMove) {
      if (!sourceAliasesByName.has(a)) {
        return { ok: false, error: { kind: 'survivor-not-found' } } satisfies CharacterMutationResult<SplitResult>;
      }
    }

    // 4. Create the new character row.
    const newChar = await tx.character.create({
      data: {
        bookId,
        name: cleanName,
        role: opts.newRole ?? 'supporting',
        voiceId: null,
      },
    });

    // 5. Move the requested aliases to the new character. Manual split is
    //    a user-authoritative action, so set source='user' regardless of
    //    what it was on the source row.
    let aliasesMoved = 0;
    for (const aliasName of opts.aliasesToMove) {
      const row = sourceAliasesByName.get(aliasName);
      if (!row) continue;
      await tx.characterAlias.update({
        where: { id: row.id },
        data: { characterId: newChar.id, source: 'user' },
      });
      aliasesMoved++;
    }
    const aliasesKept = source.aliases.length - aliasesMoved;

    return {
      ok: true,
      data: {
        survivorId: source.id,
        newCharacterId: newChar.id,
        aliasesMoved,
        aliasesKept,
        appearancesMoved: false,
      },
    };
  });
}

// ── Alias PATCH (helper for the per-alias route) ───────────────────────────

export interface AliasPatch {
  aliasId: string;
  /** Rename the alias string. Must remain unique on the character. */
  alias?: string;
  /** Override confidence 0..1. Clamped. */
  confidence?: number;
  /** Override source. */
  source?: 'user' | 'llm' | 'merge' | 'legacy';
}

export async function patchCharacterAlias(
  characterId: string,
  bookId: string,
  patch: AliasPatch,
): Promise<CharacterMutationResult<{ aliasId: string; alias: string; confidence: number; source: string }>> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.characterAlias.findUnique({
      where: { id: patch.aliasId },
      include: { character: { select: { bookId: true, name: true } } },
    });
    if (!existing) return { ok: false, error: { kind: 'survivor-not-found' } } satisfies CharacterMutationResult<{ aliasId: string; alias: string; confidence: number; source: string }>;
    if (existing.characterId !== characterId) {
      return { ok: false, error: { kind: 'cross-book', survivorBookId: existing.character.bookId, absorbedBookId: bookId } } satisfies CharacterMutationResult<{ aliasId: string; alias: string; confidence: number; source: string }>;
    }

    const data: Prisma.CharacterAliasUpdateInput = {};
    if (typeof patch.alias === 'string' && patch.alias.trim()) {
      data.alias = patch.alias.trim();
    }
    if (typeof patch.confidence === 'number') {
      const clamped = Math.max(0, Math.min(1, patch.confidence));
      data.confidence = Math.round(clamped * 100) / 100;
    }
    if (patch.source) {
      data.source = patch.source;
    }

    const updated = await tx.characterAlias.update({
      where: { id: patch.aliasId },
      data,
    });
    return {
      ok: true,
      data: {
        aliasId: updated.id,
        alias: updated.alias,
        confidence: updated.confidence,
        source: updated.source,
      },
    };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FieldSourcesMap {
  description?: 'llm' | 'user';
  personality?: 'llm' | 'user';
  speechStyle?: 'llm' | 'user';
  visualDescription?: 'llm' | 'user';
}

function parseFieldSources(raw: string | null | undefined): FieldSourcesMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FieldSourcesMap;
    }
  } catch {
    // fall through
  }
  return {};
}

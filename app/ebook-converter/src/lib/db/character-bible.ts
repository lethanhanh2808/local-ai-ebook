// src/lib/db/character-bible.ts
//
// Character Bible — persistent novel-wide character knowledge base.
//
// Four backing tables (see prisma/schema.prisma):
//   • CharacterProfile            – 1:1 with Character; free-text fields
//                                   (description/personality/speechStyle) +
//                                   `source` ('llm'|'user'|'mixed') that
//                                   gates auto-merge.
//   • CharacterRelationship       – directed graph edges between two
//                                   characters of the same book. Composite
//                                   unique on (book, fromChar, toChar,
//                                   relationship).
//   • CharacterChapterAppearance  – sparse ledger of who-appears-where.
//                                   Composite PK (characterId, chapterIndex)
//                                   with a `mentions` counter.
//   • PendingBibleDiff            – review queue for LLM-proposed changes
//                                   that auto-merge refused to apply (because
//                                   they conflicted with a `source='user'`
//                                   field, OR with an existing LLM field
//                                   where the new value would replace it).
//
// All public helpers are documented per-file. They swallow nothing —
// callers can decide whether a transient DB failure is fatal.
//
// Source-sacred rule: helpers in this file never silently overwrite a
// `source='user'` profile field. Callers that want to bypass that must go
// through `applyBiblePatch()` in src/lib/ai/character-bible.ts which
// decides per-field via applyDiffs.
import { prisma } from './client';

// ── Public types ──────────────────────────────────────────────────────────

export type ProfileSource = 'llm' | 'user' | 'mixed';

export interface CharacterBibleView {
  bookId: string;
  /** Every Character row in the book (id + canonical name). The LLM prompt
   *  builder uses this to render a "canonical names cheat-sheet" so the LLM
   *  doesn't reinvent an existing character or use a non-canonical label. */
  characters: Array<{ id: string; name: string; aliases: string[] }>;
  /** Profile fields indexed by Character.id. */
  profiles: Record<string, {
    description: string | null;
    personality: string | null;
    speechStyle: string | null;
    visualDescription: string | null;
    source: ProfileSource;
    version: number;
    updatedAt: Date;
  }>;
  /** All relationships in the book. */
  relationships: Array<{
    id: string;
    fromCharId: string;
    fromCharName: string;
    toCharId: string;
    toCharName: string;
    relationship: string;
    asOfChapterIdx: number | null;
    notes: string | null;
    source: ProfileSource;
    updatedAt: Date;
  }>;
  /** Sparse map: Character.id → chapterIndex → { mentions, analyzedAt }. */
  appearances: Record<string, Record<number, { mentions: number; analyzedAt: Date }>>;
  /** Pending diffs awaiting user review. */
  pendingDiffs: PendingDiffRow[];
}

export interface PendingDiffRow {
  id: string;
  bookId: string;
  patch: BibleDiffPatch;
  status: 'pending' | 'applied' | 'rejected' | 'stale';
  createdAt: Date;
}

export interface BibleDiffPatch {
  /** Which character this patch targets (by canonical id from the book).
   *  null only when kind='new' and the character has not been created yet. */
  characterId: string | null;
  /** When kind='new', the LLM-provided character creation payload. */
  newCharacter?: {
    name: string;
    aliases?: string[];
    gender?: 'male' | 'female' | null;
    role?: 'main' | 'supporting' | 'minor' | 'crowd';
  };
  kind: 'new' | 'update' | 'relationship' | 'appearance';
  /** For kind='update': one or more of description/personality/speechStyle/visualDescription. */
  updateFields?: Partial<{
    description: string;
    personality: string;
    speechStyle: string;
    visualDescription: string;
  }>;
  /** For kind='relationship'. Either both id fields present, or LLM may
   *  supply just the names and let the worker resolve them. */
  relationship?: {
    fromCharId?: string;
    toCharId?: string;
    fromName?: string;
    toName?: string;
    relationship: string;
    notes?: string;
    asOfChapterIdx?: number | null;
  };
  /** For kind='appearance': an absolute bump for the given chapter. */
  appearance?: {
    chapterIndex: number;
    /** Increment to apply (1 = "this character appeared once"). */
    mentions: number;
  };
  /** Mandatory evidence citation — a short snippet the LLM saw. */
  evidenceQuote?: string;
  /** Why auto-merge did NOT apply this itself. */
  autoReason:
    | 'new-character'
    | 'non-conflicting-update'
    | 'conflict-with-user-edit'
    | 'replaces-existing-llm-field'
    | 'user-hold';
  /** When autoReason mentions a conflict, this names the colliding field
   *  so the UI can show "Linh: description conflicts with your edit". */
  conflictWith?: string;
}

// ── Profiles ──────────────────────────────────────────────────────────────

/** Idempotent upsert. Used by both the user-edit path (source='user') and
 *  any code that wants to overwrite the whole profile in one shot
 *  (source='llm'/'mixed').
 *
 *  Tracks per-field sources in `fieldSources` (JSON). A user edit on
 *  field X sets fieldSources[X]='user'; subsequent LLM merges see that
 *  lock and skip just that field (other fields stay writeable).
 *
 *  The aggregate `source` column is the disjunction: 'user' if any field
 *  is user-locked, 'mixed' if the LLM has touched the row, 'llm' if it's
 *  a clean LLM row. */
export async function setProfile(args: {
  characterId: string;
  description?: string | null;
  personality?: string | null;
  speechStyle?: string | null;
  visualDescription?: string | null;
  source: ProfileSource;
  /** Per-field sources: { description?: 'llm'|'user', ... }. Only fields
   *  explicitly listed are set; unlisted fields keep their prior lock
   *  state. Pass undefined to leave the row's fieldSources alone. */
  fieldSources?: Partial<Record<'description' | 'personality' | 'speechStyle' | 'visualDescription', 'llm' | 'user' | null>>;
  /** When true, overwrites any existing per-field user lock. Default false. */
  force?: boolean;
}): Promise<{ updated: boolean; reason?: string }> {
  const existing = await prisma.characterProfile.findUnique({
    where: { characterId: args.characterId },
  });
  if (existing && existing.source === 'user' && !args.force && args.source !== 'user') {
    return { updated: false, reason: 'profile.source=user (locked)' };
  }
  // Merge fieldSources: existing map + new entries (new wins).
  const priorMap = parseFieldSources(existing?.fieldSources);
  const newMap: Record<string, 'llm' | 'user'> = { ...priorMap };
  if (args.fieldSources) {
    for (const [k, v] of Object.entries(args.fieldSources)) {
      if (v === null) delete newMap[k];
      else newMap[k] = v;
    }
  }
  // Aggregate source: 'user' if ANY field is user-locked, else 'mixed' if
  // the row has been LLM-touched (existing or fresh write), else 'llm'.
  const anyUserField = Object.values(newMap).some((v) => v === 'user');
  const aggregateSource: ProfileSource =
    anyUserField ? 'user' :
    existing?.source === 'mixed' || args.source === 'mixed' || existing ? 'mixed' :
    args.source === 'llm' ? 'llm' : 'mixed';

  const data = {
    description: args.description !== undefined ? args.description : undefined,
    personality: args.personality !== undefined ? args.personality : undefined,
    speechStyle: args.speechStyle !== undefined ? args.speechStyle : undefined,
    visualDescription: args.visualDescription !== undefined ? args.visualDescription : undefined,
    fieldSources: Object.keys(newMap).length > 0 ? JSON.stringify(newMap) : null,
    source: aggregateSource,
    version: (existing?.version ?? 0) + 1,
  };
  await prisma.characterProfile.upsert({
    where: { characterId: args.characterId },
    create: {
      characterId: args.characterId,
      description: args.description ?? null,
      personality: args.personality ?? null,
      speechStyle: args.speechStyle ?? null,
      visualDescription: args.visualDescription ?? null,
      visualSource: args.visualDescription != null ? 'llm' : null,
      fieldSources: Object.keys(newMap).length > 0 ? JSON.stringify(newMap) : null,
      source: aggregateSource,
      version: 1,
    },
    update: data,
  });
  return { updated: true };
}

/** Field-by-field merge used by LLM refresh. Returns THREE arrays:
 *    - applied:  fields written (no existing value OR same value as before)
 *    - skipped:  fields blocked by user lock (existing value would be lost)
 *    - conflicts:fields where an existing LLM value is being overwritten
 *                with a MATERIALY DIFFERENT one. These don't block the
 *                write — the caller decides whether to auto-overwrite or
 *                queue as a PendingBibleDiff.
 *
 *  Per-field locking (vs the old row-level lock) means the user can edit
 *  `description` and the LLM can still freely write `personality`. */
export async function mergeLlmProfilePatch(args: {
  characterId: string;
  description?: string | null;
  personality?: string | null;
  speechStyle?: string | null;
  visualDescription?: string | null;
}): Promise<{
  applied: Array<'description' | 'personality' | 'speechStyle' | 'visualDescription'>;
  skipped: Array<'description' | 'personality' | 'speechStyle' | 'visualDescription'>;
  conflicts: Array<'description' | 'personality' | 'speechStyle' | 'visualDescription'>;
}> {
  const applied: Array<'description' | 'personality' | 'speechStyle' | 'visualDescription'> = [];
  const skipped: Array<'description' | 'personality' | 'speechStyle' | 'visualDescription'> = [];
  const conflicts: Array<'description' | 'personality' | 'speechStyle' | 'visualDescription'> = [];
  const existing = await prisma.characterProfile.findUnique({
    where: { characterId: args.characterId },
  });
  const fields: Array<'description' | 'personality' | 'speechStyle' | 'visualDescription'> = [
    'description', 'personality', 'speechStyle', 'visualDescription',
  ];
  const fieldMap = parseFieldSources(existing?.fieldSources);
  // Per-field fallback to row-level source when fieldSources is empty
  // (pre-migration rows + rows the user has only ever touched via the
  // old bulk-edit paths). User intent was "lock all my fields".
  const userLocksField = new Set<typeof fields[number]>();
  for (const f of fields) {
    if (fieldMap[f] === 'user') userLocksField.add(f);
    if (!fieldMap[f] && existing?.source === 'user' && existing[f] != null) userLocksField.add(f);
  }

  for (const field of fields) {
    const v = args[field];
    if (v === undefined) continue;
    if (userLocksField.has(field)) { skipped.push(field); continue; }
    const existingValue = existing ? existing[field] : null;
    if (existingValue == null) {
      // Fresh write — definitely applies.
      applied.push(field);
      continue;
    }
    if (fieldMatchesExisting(existingValue, v)) {
      // Same value — idempotent, count as applied (no actual change).
      applied.push(field);
      continue;
    }
    // Existing LLM value differs from proposed — DRIFT. Don't silently
    // overwrite; surface as a conflict for the caller to queue.
    conflicts.push(field);
  }

  if (applied.length === 0) {
    return { applied, skipped, conflicts };
  }

  // Apply the non-conflicting fields; clear any per-field source for the
  // fields we just overwrote (a user-locked field would have been in
  // `skipped` already).
  const newMap: Record<string, 'llm' | 'user'> = { ...fieldMap };
  for (const f of applied) delete newMap[f];
  const aggregateSource: ProfileSource =
    Object.values(newMap).some((v) => v === 'user') ? 'user' :
    existing ? 'mixed' : 'llm';

  const update: Record<string, string | number | null> = {
    version: (existing?.version ?? 0) + 1,
    source: aggregateSource,
    fieldSources: Object.keys(newMap).length > 0 ? JSON.stringify(newMap) : null,
  };
  if (applied.includes('description')) update.description = args.description ?? null;
  if (applied.includes('personality')) update.personality = args.personality ?? null;
  if (applied.includes('speechStyle')) update.speechStyle = args.speechStyle ?? null;
  if (applied.includes('visualDescription')) update.visualDescription = args.visualDescription ?? null;
  await prisma.characterProfile.upsert({
    where: { characterId: args.characterId },
    create: {
      characterId: args.characterId,
      description: applied.includes('description') ? (args.description ?? null) : (existing?.description ?? null),
      personality: applied.includes('personality') ? (args.personality ?? null) : (existing?.personality ?? null),
      speechStyle: applied.includes('speechStyle') ? (args.speechStyle ?? null) : (existing?.speechStyle ?? null),
      visualDescription: applied.includes('visualDescription') ? (args.visualDescription ?? null) : (existing?.visualDescription ?? null),
      fieldSources: update.fieldSources as string | null,
      source: aggregateSource,
      version: 1,
    },
    update: update as any,
  });
  return { applied, skipped, conflicts };
}

/** Cheap "did the LLM actually propose something materially new?"
 *  — strips surrounding whitespace + trailing punctuation and compares. */
function fieldMatchesExisting(existing: string, proposed: string | null): boolean {
  if (proposed == null) return false;
  const a = existing.trim().replace(/[.。]\s*$/, '');
  const b = proposed.trim().replace(/[.。]\s*$/, '');
  if (a === b) return true;
  // Tolerate trivial differences like a stray trailing period. Real drift
  // (different content) will fall through to conflicts[].
  return false;
}

/** Parse the JSON in fieldSources, tolerating garbage. Returns an empty
 *  object when the column is null or unparseable. */
function parseFieldSources(s: string | null | undefined): Partial<Record<'description' | 'personality' | 'speechStyle' | 'visualDescription', 'llm' | 'user'>> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== 'object') return {};
    const out: Partial<Record<'description' | 'personality' | 'speechStyle' | 'visualDescription', 'llm' | 'user'>> = {};
    for (const k of ['description', 'personality', 'speechStyle', 'visualDescription'] as const) {
      const x = v[k];
      if (x === 'llm' || x === 'user') out[k] = x;
    }
    return out;
  } catch {
    return {};
  }
}

// ── Relationships ─────────────────────────────────────────────────────────

export async function addOrUpdateRelationship(args: {
  bookId: string;
  fromCharId: string;
  toCharId: string;
  relationship: string;
  asOfChapterIdx?: number | null;
  notes?: string | null;
  source?: ProfileSource;
  /** When true, an existing user-locked row gets replaced. Default false. */
  force?: boolean;
}): Promise<{ id: string; updated: boolean; reason?: string }> {
  const existing = await prisma.characterRelationship.findUnique({
    where: {
      bookId_fromCharId_toCharId_relationship: {
        bookId: args.bookId,
        fromCharId: args.fromCharId,
        toCharId: args.toCharId,
        relationship: args.relationship,
      },
    },
  });
  if (existing && existing.source === 'user' && !args.force && (args.source ?? 'llm') !== 'user') {
    return { id: existing.id, updated: false, reason: 'relationship.source=user (locked)' };
  }
  const source = args.source ?? 'llm';
  const row = await prisma.characterRelationship.upsert({
    where: {
      bookId_fromCharId_toCharId_relationship: {
        bookId: args.bookId,
        fromCharId: args.fromCharId,
        toCharId: args.toCharId,
        relationship: args.relationship,
      },
    },
    create: {
      bookId: args.bookId,
      fromCharId: args.fromCharId,
      toCharId: args.toCharId,
      relationship: args.relationship,
      asOfChapterIdx: args.asOfChapterIdx ?? null,
      notes: args.notes ?? null,
      source,
    },
    update: {
      asOfChapterIdx: args.asOfChapterIdx ?? null,
      notes: args.notes ?? null,
      source,
    },
  });
  return { id: row.id, updated: true };
}

export async function removeRelationship(id: string): Promise<void> {
  await prisma.characterRelationship.delete({ where: { id } });
}

// ── Appearances ───────────────────────────────────────────────────────────

/** Bump a sparse ledger entry. Idempotent on chapterIndex — calling twice
 *  with mentions=1 writes { mentions: 2 }, etc. */
export async function recordAppearances(args: {
  bookId: string;
  chapterIndex: number;
  /** Names as recognised by the LLM (must match existing Character.name). */
  names: string[];
}): Promise<{ added: number; skipped: string[] }> {
  if (args.names.length === 0) return { added: 0, skipped: [] };
  const characters = await prisma.character.findMany({
    where: { bookId: args.bookId, name: { in: args.names } },
    select: { id: true, name: true },
  });
  const known = new Map(characters.map((c) => [c.name, c.id]));
  const skipped = args.names.filter((n) => !known.has(n));
  const ids = args.names
    .map((n) => known.get(n))
    .filter((v): v is string => Boolean(v));
  if (ids.length === 0) return { added: 0, skipped };
  // Upsert one row per (characterId, chapterIndex). SQLite doesn't have a
  // "RETURNING id" on INSERT ... ON CONFLICT, so we read-then-insert.
  // For typical chapter-sizes (<200 characters) this is fine.
  await prisma.$transaction(
    ids.map((characterId) =>
      prisma.characterChapterAppearance.upsert({
        where: {
          characterId_chapterIndex: { characterId, chapterIndex: args.chapterIndex },
        },
        create: {
          characterId,
          chapterIndex: args.chapterIndex,
          mentions: 1,
        },
        update: { mentions: { increment: 1 }, analyzedAt: new Date() },
      }),
    ),
  );
  return { added: ids.length, skipped };
}

// ── Character upsert ──────────────────────────────────────────────────────

/** Insert (or update aliases) a character by canonical name. Returns its
 *  id. Composite-unique (bookId, name) means duplicate inserts are safe.
 *
 *  Phase 4.4: aliases now live in the CharacterAlias side table, not on
 *  a JSON column. The character upsert here still takes a `string[]` for
 *  backwards compatibility — we just sync the CharacterAlias rows
 *  transactionally alongside the Character upsert.
 */
export async function ensureCharacter(args: {
  bookId: string;
  name: string;
  aliases?: string[];
  gender?: 'male' | 'female' | null;
  role?: 'main' | 'supporting' | 'minor' | 'crowd';
}): Promise<{ id: string; created: boolean }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.character.findUnique({
      where: { bookId_name: { bookId: args.bookId, name: args.name } },
      include: { aliases: true },
    });
    if (existing) {
      // Only update fields that the LLM provided AND the existing row has no
      // user-locked value for. We treat the existing 'gender' / 'role' as
      // authoritative; merge new aliases though.
      const existingAliasNames = existing.aliases.map((a) => a.alias);
      const incoming = args.aliases ?? [];
      const toAdd = mergeAliasLists(existingAliasNames, incoming);
      if (toAdd.length > 0) {
        for (const alias of toAdd) {
          await tx.characterAlias.upsert({
            where: { characterId_alias: { characterId: existing.id, alias } },
            update: {},
            create: {
              characterId: existing.id,
              alias,
              confidence: 1.0,
              source: 'user',
            },
          });
        }
      }
      const data: { gender?: string; role?: string } = {};
      if (args.gender && !existing.gender) data.gender = args.gender;
      if (args.role && existing.role === 'supporting') data.role = args.role;
      if (Object.keys(data).length > 0) {
        await tx.character.update({ where: { id: existing.id }, data });
      }
      return { id: existing.id, created: false };
    }
    const row = await tx.character.create({
      data: {
        bookId: args.bookId,
        name: args.name,
        gender: args.gender ?? null,
        role: args.role ?? 'supporting',
      },
    });
    if (args.aliases && args.aliases.length > 0) {
      for (const alias of args.aliases) {
        const trimmed = alias.trim();
        if (!trimmed) continue;
        await tx.characterAlias.create({
          data: {
            characterId: row.id,
            alias: trimmed,
            confidence: 1.0,
            source: 'user',
          },
        });
      }
    }
    return { id: row.id, created: true };
  });
}

/** Phase 4.4 — return the deduped subset of `incoming` aliases that
 *  aren't already on the character. The caller uses this to write only
 *  new CharacterAlias rows (existing ones are preserved with their
 *  confidence + source). Order is preserved. */
function mergeAliasLists(existing: string[], incoming: string[] | undefined): string[] {
  if (!incoming || incoming.length === 0) return [];
  const seen = new Set(existing);
  const out: string[] = [];
  for (const a of incoming) {
    const t = a.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseAliases(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

/** Resolve a list of names to Character.id in batch. Names not found return null.
 *
 *  Alias-aware + case-insensitive (Unicode NFC normalized). The previous
 *  implementation only matched `Character.name`, so "Linh" missed
 *  "Lâm Linh" and any alias-based reference. This is the single biggest
 *  source of "duplicate character created" bugs in the bible build.
 */
export async function resolveCharacterIds(
  bookId: string,
  names: string[],
): Promise<Record<string, string | null>> {
  if (names.length === 0) return {};
  // SQLite by default uses BINARY collation which IS case-sensitive — that's
  // why we can't rely on `mode: 'insensitive'`. Do it in app code instead.
  const characters = await prisma.character.findMany({
    where: { bookId },
    select: { id: true, name: true, aliases: { select: { alias: true } } },
  });
  const byName = new Map<string, string>();
  const byAlias = new Map<string, string>();
  for (const c of characters) {
    byName.set(normKey(c.name), c.id);
    for (const a of c.aliases) byAlias.set(normKey(a.alias), c.id);
  }
  const out: Record<string, string | null> = {};
  for (const n of names) {
    const k = normKey(n);
    out[n] = byName.get(k) ?? byAlias.get(k) ?? null;
  }
  return out;
}

/** Unicode-NFC fold + lowercase + whitespace-trim for name comparison. */
export function normKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Lookup single name → id (returns null if not found). Convenience
 *  wrapper used by sanitizePatches() and by the build pipeline. */
export async function findCharacterIdByName(
  bookId: string,
  name: string,
): Promise<string | null> {
  const [hit] = Object.values(await resolveCharacterIds(bookId, [name]));
  return hit ?? null;
}

// ── Relationship label canonicalization ────────────────────────────────────
//
// The unique constraint on CharacterRelationship includes `relationship`,
// so "mother", "mẹ", "mẹ nuôi" would each get their own row. LLM drafts
// vary the phrasing chapter to chapter. This map collapses the obvious
// synonyms before insert so we don't end up with two parallel edges for
// the same logical relationship. Add to this list freely; it's deliberately
// conservative (Vietnamese + English only, no regional slang).

const REL_CANONICAL: Record<string, string> = {
  // parents
  'mẹ': 'mother', 'me': 'mother', 'mother': 'mother', 'mẹ nuôi': 'mother',
  'cha': 'father', 'bố': 'father', 'father': 'father', 'dad': 'father',
  // siblings
  'anh trai': 'older_brother', 'anh': 'older_brother', 'older brother': 'older_brother',
  'chị gái': 'older_sister', 'chị': 'older_sister', 'older sister': 'older_sister',
  'em trai': 'younger_brother', 'em': 'younger_brother', 'younger brother': 'younger_brother',
  'em gái': 'younger_sister', 'younger sister': 'younger_sister',
  'chị em': 'sibling', 'anh em': 'sibling', 'sibling': 'sibling', 'siblings': 'sibling',
  // children
  'con trai': 'son', 'son': 'son',
  'con gái': 'daughter', 'daughter': 'daughter',
  'con': 'child', 'child': 'child', 'children': 'child',
  // partner
  'vợ': 'wife', 'wife': 'wife', 'người vợ': 'wife',
  'chồng': 'husband', 'husband': 'husband', 'người chồng': 'husband',
  'người yêu': 'lover', 'lover': 'lover', 'bạn gái': 'lover',
  // other
  'bạn thân': 'friend', 'bạn': 'friend', 'friend': 'friend',
  'thù': 'enemy', 'kẻ thù': 'enemy', 'enemy': 'enemy',
  'thầy': 'mentor', 'sư phụ': 'mentor', 'mentor': 'mentor',
  'đối thủ': 'rival', 'rival': 'rival',
  'đồng nghiệp': 'colleague', 'colleague': 'colleague',
};

/** Normalize a relationship label. Returns the input unchanged when no
 *  mapping is found — we don't want to invent canonical names for terms
 *  the LLM only used once. */
export function canonicalizeRelationship(label: string): string {
  const k = normKey(label);
  return REL_CANONICAL[k] ?? label.trim();
}

// ── Pending diff queue ────────────────────────────────────────────────────

export async function queueDiff(
  bookId: string,
  patch: BibleDiffPatch,
): Promise<string> {
  const row = await prisma.pendingBibleDiff.create({
    data: { bookId, patch: JSON.stringify(patch), status: 'pending' },
  });
  return row.id;
}

export async function applyDiff(id: string): Promise<{ applied: boolean; reason?: string }> {
  const row = await prisma.pendingBibleDiff.findUnique({ where: { id } });
  if (!row) return { applied: false, reason: 'diff-not-found' };
  if (row.status !== 'pending') return { applied: false, reason: `status=${row.status}` };
  const patch: BibleDiffPatch = JSON.parse(row.patch);
  // The actual application is the worker's job — this helper simply flips
  // status. The caller (worker / manual apply route) must have already
  // applied the patch via the LLM module before calling applyDiff().
  await prisma.pendingBibleDiff.update({
    where: { id },
    data: { status: 'applied' },
  });
  return { applied: true };
}

export async function rejectDiff(id: string): Promise<void> {
  await prisma.pendingBibleDiff.update({
    where: { id },
    data: { status: 'rejected' },
  });
}

/** Apply all pending non-conflicting diffs for a book. Returns ids that
 *  were flipped to 'applied'. Conflicts (autoReason starting with
 *  'conflict-') are skipped — they require explicit user review. */
export async function applyAllNonConflictingDiff(
  bookId: string,
): Promise<{ appliedIds: string[]; skipped: number }> {
  const rows = await prisma.pendingBibleDiff.findMany({
    where: { bookId, status: 'pending' },
  });
  const applied: string[] = [];
  for (const row of rows) {
    let patch: BibleDiffPatch;
    try { patch = JSON.parse(row.patch); }
    catch { continue; }
    if (patch.autoReason.startsWith('conflict-')) continue;
    await prisma.pendingBibleDiff.update({
      where: { id: row.id },
      data: { status: 'applied' },
    });
    applied.push(row.id);
  }
  return { appliedIds: applied, skipped: rows.length - applied.length };
}

/** When chapter HTMLs are deleted / re-ordered, mark diffs that referenced
 *  those chapter indices as 'stale'. UI hides them by default. */
export async function markStaleBeforeChapter(bookId: string, chapterIndex: number): Promise<number> {
  const rows = await prisma.pendingBibleDiff.findMany({ where: { bookId, status: 'pending' } });
  let stale = 0;
  for (const row of rows) {
    let patch: BibleDiffPatch;
    try { patch = JSON.parse(row.patch); } catch { continue; }
    const ref = patch.relationship?.asOfChapterIdx ?? patch.appearance?.chapterIndex;
    if (ref == null) continue;
    if (ref >= chapterIndex) {
      await prisma.pendingBibleDiff.update({
        where: { id: row.id },
        data: { status: 'stale' },
      });
      stale++;
    }
  }
  return stale;
}

// ── Assembled view (used by both UI and LLM prompt builder) ───────────────

export async function getCharacterBible(bookId: string): Promise<CharacterBibleView> {
  const [characters, profiles, relationships, appearances, diffs] = await Promise.all([
    prisma.character.findMany({
      where: { bookId },
      select: { id: true, name: true, aliases: true },
    }),
    prisma.characterProfile.findMany({
      where: { character: { bookId } },
    }),
    prisma.characterRelationship.findMany({ where: { bookId } }),
    prisma.characterChapterAppearance.findMany({
      where: { character: { bookId } },
    }),
    prisma.pendingBibleDiff.findMany({
      where: { bookId, status: 'pending' },
    }),
  ]);
  // Need names for relationship endpoints — fetch them once.
  const charIds = new Set<string>();
  for (const r of relationships) { charIds.add(r.fromCharId); charIds.add(r.toCharId); }
  const nameByCharId = new Map<string, string>();
  for (const c of characters) nameByCharId.set(c.id, c.name);
  for (const id of Array.from(charIds)) {
    if (nameByCharId.has(id)) continue;
    const c = await prisma.character.findUnique({ where: { id }, select: { name: true } });
    if (c) nameByCharId.set(id, c.name);
  }
  return {
    bookId,
    characters: characters.map((c) => ({
      id: c.id, name: c.name, aliases: c.aliases.map((a) => a.alias),
    })),
    profiles: Object.fromEntries(
      profiles.map((p) => [p.characterId, {
        description: p.description,
        personality: p.personality,
        speechStyle: p.speechStyle,
        visualDescription: p.visualDescription,
        source: p.source as ProfileSource,
        version: p.version,
        updatedAt: p.updatedAt,
      }]),
    ),
    relationships: relationships.map((r) => ({
      id: r.id,
      fromCharId: r.fromCharId,
      fromCharName: nameByCharId.get(r.fromCharId) ?? '?',
      toCharId: r.toCharId,
      toCharName: nameByCharId.get(r.toCharId) ?? '?',
      relationship: r.relationship,
      asOfChapterIdx: r.asOfChapterIdx,
      notes: r.notes,
      source: r.source as ProfileSource,
      updatedAt: r.updatedAt,
    })),
    appearances: appearances.reduce<Record<string, Record<number, { mentions: number; analyzedAt: Date }>>>((acc, row) => {
      if (!acc[row.characterId]) acc[row.characterId] = {};
      acc[row.characterId][row.chapterIndex] = { mentions: row.mentions, analyzedAt: row.analyzedAt };
      return acc;
    }, {}),
    pendingDiffs: diffs.map((d) => ({
      id: d.id,
      bookId: d.bookId,
      patch: JSON.parse(d.patch) as BibleDiffPatch,
      status: d.status as PendingDiffRow['status'],
      createdAt: d.createdAt,
    })),
  };
}

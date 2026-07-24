-- Migration: 20260724000000_add_character_alias_confidence
-- Phase 4.4 of docs/NEXT_UP_PLAN.md — replaces the legacy
-- `Character.aliases` JSON-string column with a structured
-- `CharacterAlias` table that tracks per-alias source + confidence.
--
-- Steps:
--   1. CREATE TABLE CharacterAlias
--   2. Backfill existing JSON aliases into CharacterAlias rows
--      (source='legacy', confidence=1.0)
--   3. Drop the legacy JSON column from Character
--
-- SQLite-specific notes:
--   - DROP COLUMN requires SQLite >= 3.35.0 (March 2021).
--   - We backfill via a recursive CTE so multi-alias JSON arrays are
--     split into one row each.
--   - CREATE TABLE without a foreign key against Character keeps the
--     backfill order simple (the FK is added by Prisma on db push).

-- Step 1 — create the table. We add the FK inline so backfill rows
-- inherit cascade behaviour immediately.
CREATE TABLE "CharacterAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "source" TEXT NOT NULL DEFAULT 'user',
    "detectedInChapter" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CharacterAlias_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE
);

-- Step 2 — backfill existing aliases.
-- Character.aliases was a JSON string like '["Linh","cô Linh","chị Linh"]'.
-- For each Character with non-null aliases, split the array and emit one
-- row per alias. SQLite's json_each() handles this cleanly.
INSERT INTO "CharacterAlias" ("id", "characterId", "alias", "confidence", "source", "createdAt", "updatedAt")
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))) AS id,
    c."id" AS "characterId",
    je.value AS "alias",
    1.0 AS "confidence",
    'legacy' AS "source",
    CURRENT_TIMESTAMP AS "createdAt",
    CURRENT_TIMESTAMP AS "updatedAt"
FROM "Character" c, json_each(c."aliases") je
WHERE c."aliases" IS NOT NULL
  AND TRIM(c."aliases") <> ''
  AND je.value IS NOT NULL
  AND TRIM(je.value) <> '';

-- Step 3 — create indexes + unique constraint.
-- We do this after backfill so the unique constraint validates against
-- the full row set (which is harmless for legacy data since aliases
-- within a character are already unique by construction).
CREATE UNIQUE INDEX "CharacterAlias_characterId_alias_key" ON "CharacterAlias"("characterId", "alias");
CREATE INDEX "CharacterAlias_characterId_idx" ON "CharacterAlias"("characterId");
CREATE INDEX "CharacterAlias_source_confidence_idx" ON "CharacterAlias"("source", "confidence");

-- Step 4 — drop the legacy JSON column.
ALTER TABLE "Character" DROP COLUMN "aliases";

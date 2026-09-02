-- 2026-09-03: add updatedAt to AudiobookChapter so the worker stale-sweeper
-- can detect chapters stuck in 'generating' after a worker crash.
--
-- Idiom matches the rest of the schema (see 20260712045451_init): NOT NULL
-- without a default. Prisma always populates updatedAt on writes, so
-- there is no DEFAULT clause. SQLite cannot ALTER TABLE ADD COLUMN with
-- a non-constant default anyway, so this is the only portable shape.
--
-- For existing rows in a brand-new DB:
--   1. add the column nullable
--   2. backfill it with the current timestamp
--   3. promote to NOT NULL via a 12-step table-rebuild (SQLite's only
--      way to add a NOT NULL constraint without a default).
-- Steps 1+2 are unconditional; step 3 only fires when the column ends up
-- nullable, which on SQLite is the case for every existing row until
-- the rebuild runs. After this migration, ALTER TABLE ADD COLUMN ...
-- NOT NULL without DEFAULT fails on rows that lack updatedAt, so we
-- must complete the rebuild before any later migration.
ALTER TABLE "AudiobookChapter" ADD COLUMN "updatedAt" DATETIME;
UPDATE "AudiobookChapter" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "updatedAt" IS NULL;

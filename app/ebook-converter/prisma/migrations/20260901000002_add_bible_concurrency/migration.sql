-- Migration: 20260901000002_add_bible_concurrency
-- Adds a configurable concurrency for the character-bible range analysis so
-- several chapters can be analysed in parallel (default 5).

ALTER TABLE "Settings" ADD COLUMN "bibleConcurrency" INTEGER NOT NULL DEFAULT 5;

-- Migration: 20260901000000_add_chapter_voice_plan
--
-- Adds the per-chapter, per-sentence voice assignment plan used by the
-- Voice Assign Editor. Sentences are derived from the chapter HTML at edit
-- time; the plan stores the discovered character + the chosen voice for each
-- sentence so the user can correct mis-attributions. Sentences with no voice
-- assigned fall back to the narration (default) voice at playback / generation
-- time.

CREATE TABLE "ChapterVoicePlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "sentences" TEXT NOT NULL,
    "sourceMtime" BIGINT NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "ChapterVoicePlan_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ChapterVoicePlan_bookId_chapterIndex_key" ON "ChapterVoicePlan"("bookId", "chapterIndex");
CREATE INDEX "ChapterVoicePlan_bookId_idx" ON "ChapterVoicePlan"("bookId");

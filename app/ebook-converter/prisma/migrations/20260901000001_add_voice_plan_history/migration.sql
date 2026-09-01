-- Migration: 20260901000001_add_voice_plan_history
--
-- Rolling history of voice-plan snapshots per chapter. Before any apply /
-- restore / manual save in the Voice Assign Editor, the current plan is pushed
-- here so the user can revert to a previous version. The API enforces a cap of
-- 30 entries per (bookId, chapterIndex); when the cap is exceeded the oldest
-- snapshot is dropped (ring buffer).

CREATE TABLE "VoicePlanHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "sentences" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Phiên bản',
    "createdAt" DATETIME NOT NULL,

    CONSTRAINT "VoicePlanHistory_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES
"Book"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "VoicePlanHistory_bookId_chapterIndex_idx" ON "VoicePlanHistory"("bookId", "chapterIndex");

-- Add user-configurable chapter-text cap for character-bible analysis.
ALTER TABLE "Settings" ADD COLUMN "bibleChapterChars" INTEGER NOT NULL DEFAULT 12000;
ALTER TABLE "UserSettings" ADD COLUMN "bibleChapterChars" INTEGER NOT NULL DEFAULT 12000;

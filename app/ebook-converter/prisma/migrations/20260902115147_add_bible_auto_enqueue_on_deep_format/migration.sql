-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "targetUserId" TEXT,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AuditLog" ("action", "actorId", "createdAt", "details", "id", "targetUserId") SELECT "action", "actorId", "createdAt", "details", "id", "targetUserId" FROM "AuditLog";
DROP TABLE "AuditLog";
ALTER TABLE "new_AuditLog" RENAME TO "AuditLog";
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");
CREATE INDEX "AuditLog_targetUserId_createdAt_idx" ON "AuditLog"("targetUserId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE TABLE "new_CharacterAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "source" TEXT NOT NULL DEFAULT 'user',
    "detectedInChapter" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CharacterAlias_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CharacterAlias" ("alias", "characterId", "confidence", "createdAt", "detectedInChapter", "id", "source", "updatedAt") SELECT "alias", "characterId", "confidence", "createdAt", "detectedInChapter", "id", "source", "updatedAt" FROM "CharacterAlias";
DROP TABLE "CharacterAlias";
ALTER TABLE "new_CharacterAlias" RENAME TO "CharacterAlias";
CREATE INDEX "CharacterAlias_characterId_idx" ON "CharacterAlias"("characterId");
CREATE INDEX "CharacterAlias_source_confidence_idx" ON "CharacterAlias"("source", "confidence");
CREATE UNIQUE INDEX "CharacterAlias_characterId_alias_key" ON "CharacterAlias"("characterId", "alias");
CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "aiProvider" TEXT NOT NULL DEFAULT 'omlx-local',
    "aiApiKey" TEXT,
    "aiBaseUrl" TEXT,
    "aiAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false,
    "aiModel" TEXT NOT NULL DEFAULT 'default',
    "aiMaxTokens" INTEGER NOT NULL DEFAULT 4096,
    "aiTemperature" REAL NOT NULL DEFAULT 0.2,
    "bibleChapterChars" INTEGER NOT NULL DEFAULT 12000,
    "aiThinkingCombine" BOOLEAN NOT NULL DEFAULT true,
    "aiThinkingFullLLM" BOOLEAN NOT NULL DEFAULT false,
    "ttsProvider" TEXT NOT NULL DEFAULT 'vieneu',
    "defaultAiEnhance" BOOLEAN NOT NULL DEFAULT true,
    "defaultAiWatermarkClean" BOOLEAN NOT NULL DEFAULT true,
    "defaultDeepFormat" BOOLEAN NOT NULL DEFAULT false,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'vi',
    "defaultReaderFriendly" BOOLEAN NOT NULL DEFAULT true,
    "aiEnhanceConcurrency" INTEGER NOT NULL DEFAULT 3,
    "imageProvider" TEXT NOT NULL DEFAULT 'none',
    "imageApiKey" TEXT,
    "imageBaseUrl" TEXT,
    "imageAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false,
    "imageModel" TEXT NOT NULL DEFAULT 'dall-e-3',
    "imageStyle" TEXT NOT NULL DEFAULT 'bw-anime',
    "imageMaxPerBook" INTEGER NOT NULL DEFAULT 6,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "workerConcurrency" INTEGER NOT NULL DEFAULT 2,
    "workerChapterConcurrency" INTEGER NOT NULL DEFAULT 1,
    "bibleConcurrency" INTEGER NOT NULL DEFAULT 5,
    "bibleAutoEnqueueOnDeepFormat" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Settings" ("aiAllowInsecureTls", "aiApiKey", "aiBaseUrl", "aiEnhanceConcurrency", "aiMaxTokens", "aiModel", "aiProvider", "aiTemperature", "aiThinkingCombine", "aiThinkingFullLLM", "bibleChapterChars", "bibleConcurrency", "createdAt", "defaultAiEnhance", "defaultAiWatermarkClean", "defaultDeepFormat", "defaultLanguage", "defaultReaderFriendly", "id", "imageAllowInsecureTls", "imageApiKey", "imageBaseUrl", "imageMaxPerBook", "imageModel", "imageProvider", "imageStyle", "theme", "ttsProvider", "updatedAt", "workerChapterConcurrency", "workerConcurrency") SELECT "aiAllowInsecureTls", "aiApiKey", "aiBaseUrl", "aiEnhanceConcurrency", "aiMaxTokens", "aiModel", "aiProvider", "aiTemperature", "aiThinkingCombine", "aiThinkingFullLLM", "bibleChapterChars", "bibleConcurrency", "createdAt", "defaultAiEnhance", "defaultAiWatermarkClean", "defaultDeepFormat", "defaultLanguage", "defaultReaderFriendly", "id", "imageAllowInsecureTls", "imageApiKey", "imageBaseUrl", "imageMaxPerBook", "imageModel", "imageProvider", "imageStyle", "theme", "ttsProvider", "updatedAt", "workerChapterConcurrency", "workerConcurrency" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
CREATE TABLE "new_UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "aiProvider" TEXT NOT NULL DEFAULT 'omlx-local',
    "aiApiKey" TEXT,
    "aiBaseUrl" TEXT,
    "aiAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false,
    "aiModel" TEXT NOT NULL DEFAULT 'default',
    "aiMaxTokens" INTEGER NOT NULL DEFAULT 4096,
    "aiTemperature" REAL NOT NULL DEFAULT 0.2,
    "bibleChapterChars" INTEGER NOT NULL DEFAULT 12000,
    "aiThinkingCombine" BOOLEAN NOT NULL DEFAULT true,
    "aiThinkingFullLLM" BOOLEAN NOT NULL DEFAULT false,
    "ttsProvider" TEXT NOT NULL DEFAULT 'vieneu',
    "defaultAiEnhance" BOOLEAN NOT NULL DEFAULT true,
    "defaultAiWatermarkClean" BOOLEAN NOT NULL DEFAULT true,
    "defaultDeepFormat" BOOLEAN NOT NULL DEFAULT false,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'vi',
    "defaultReaderFriendly" BOOLEAN NOT NULL DEFAULT true,
    "aiEnhanceConcurrency" INTEGER NOT NULL DEFAULT 3,
    "imageProvider" TEXT NOT NULL DEFAULT 'none',
    "imageApiKey" TEXT,
    "imageBaseUrl" TEXT,
    "imageAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false,
    "imageModel" TEXT NOT NULL DEFAULT 'dall-e-3',
    "imageStyle" TEXT NOT NULL DEFAULT 'bw-anime',
    "imageMaxPerBook" INTEGER NOT NULL DEFAULT 6,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_UserSettings" ("aiAllowInsecureTls", "aiApiKey", "aiBaseUrl", "aiEnhanceConcurrency", "aiMaxTokens", "aiModel", "aiProvider", "aiTemperature", "aiThinkingCombine", "aiThinkingFullLLM", "bibleChapterChars", "createdAt", "defaultAiEnhance", "defaultAiWatermarkClean", "defaultDeepFormat", "defaultLanguage", "defaultReaderFriendly", "id", "imageApiKey", "imageBaseUrl", "imageMaxPerBook", "imageModel", "imageProvider", "imageStyle", "theme", "ttsProvider", "updatedAt", "userId") SELECT "aiAllowInsecureTls", "aiApiKey", "aiBaseUrl", "aiEnhanceConcurrency", "aiMaxTokens", "aiModel", "aiProvider", "aiTemperature", "aiThinkingCombine", "aiThinkingFullLLM", "bibleChapterChars", "createdAt", "defaultAiEnhance", "defaultAiWatermarkClean", "defaultDeepFormat", "defaultLanguage", "defaultReaderFriendly", "id", "imageApiKey", "imageBaseUrl", "imageMaxPerBook", "imageModel", "imageProvider", "imageStyle", "theme", "ttsProvider", "updatedAt", "userId" FROM "UserSettings";
DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
CREATE TABLE "new_VoicePlanHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "sentences" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Phiên bản',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoicePlanHistory_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_VoicePlanHistory" ("bookId", "chapterIndex", "createdAt", "id", "label", "sentences") SELECT "bookId", "chapterIndex", "createdAt", "id", "label", "sentences" FROM "VoicePlanHistory";
DROP TABLE "VoicePlanHistory";
ALTER TABLE "new_VoicePlanHistory" RENAME TO "VoicePlanHistory";
CREATE INDEX "VoicePlanHistory_bookId_chapterIndex_idx" ON "VoicePlanHistory"("bookId", "chapterIndex");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "originalExt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL DEFAULT 'upload',
    "inputPath" TEXT NOT NULL,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "aiTotalTokens" INTEGER,
    "aiTotalDurationMs" INTEGER,
    "aiCallCount" INTEGER,
    "aiGenerationTokensPerSecond" REAL,
    "aiPromptTokensPerSecond" REAL,
    "logPath" TEXT,
    "outputPath" TEXT,
    "errorMsg" TEXT,
    "metadata" TEXT,
    "report" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "titleVi" TEXT,
    "author" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'vi',
    "description" TEXT,
    "publisher" TEXT,
    "publishDate" TEXT,
    "identifier" TEXT,
    "series" TEXT,
    "seriesIndex" REAL,
    "rating" INTEGER,
    "coverPath" TEXT,
    "filePath" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "tags" TEXT,
    "notes" TEXT,
    "readProgress" INTEGER NOT NULL DEFAULT 0,
    "readStatus" TEXT NOT NULL DEFAULT 'unread',
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "lastRead" DATETIME,
    "watermarks" TEXT,
    "ttsBackend" TEXT NOT NULL DEFAULT 'vieneu',
    "audiobookStatus" TEXT NOT NULL DEFAULT 'none',
    "audiobookGeneratedAt" DATETIME,
    "audiobookDurationMs" INTEGER,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Voice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "refAudioPath" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'vi',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "defaultSpeed" REAL,
    "defaultEmotion" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'character',
    "builtinName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Voice_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT,
    "voiceId" TEXT,
    "notes" TEXT,
    "role" TEXT NOT NULL DEFAULT 'supporting',
    "age" TEXT,
    "gender" TEXT,
    "tone" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Character_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Character_voiceId_fkey" FOREIGN KEY ("voiceId") REFERENCES "Voice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CharacterProfile" (
    "characterId" TEXT NOT NULL PRIMARY KEY,
    "description" TEXT,
    "personality" TEXT,
    "speechStyle" TEXT,
    "visualDescription" TEXT,
    "visualSource" TEXT DEFAULT 'llm',
    "fieldSources" TEXT,
    "source" TEXT NOT NULL DEFAULT 'llm',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CharacterProfile_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CharacterRelationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "fromCharId" TEXT NOT NULL,
    "toCharId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'llm',
    "asOfChapterIdx" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CharacterRelationship_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CharacterRelationship_fromCharId_fkey" FOREIGN KEY ("fromCharId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CharacterRelationship_toCharId_fkey" FOREIGN KEY ("toCharId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CharacterChapterAppearance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "mentions" INTEGER NOT NULL DEFAULT 1,
    "analyzedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CharacterChapterAppearance_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PendingBibleDiff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "patch" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingBibleDiff_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BibleRefreshLog" (
    "bookId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "analyzedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("bookId", "chapterIndex"),
    CONSTRAINT "BibleRefreshLog_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BookConversationState" (
    "bookId" TEXT NOT NULL PRIMARY KEY,
    "lastChapterIndex" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookConversationState_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AudiobookChapter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "chapterFile" TEXT NOT NULL,
    "chapterTitle" TEXT,
    "audioPath" TEXT,
    "durationMs" INTEGER,
    "sizeBytes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "errorMsg" TEXT,
    "generatedAt" DATETIME,
    "configHash" TEXT,
    CONSTRAINT "AudiobookChapter_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Shelf" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShelfBook" (
    "shelfId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("shelfId", "bookId"),
    CONSTRAINT "ShelfBook_shelfId_fkey" FOREIGN KEY ("shelfId") REFERENCES "Shelf" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShelfBook_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "aiProvider" TEXT NOT NULL DEFAULT 'omlx-local',
    "aiApiKey" TEXT,
    "aiBaseUrl" TEXT,
    "aiModel" TEXT NOT NULL DEFAULT 'default',
    "aiMaxTokens" INTEGER NOT NULL DEFAULT 4096,
    "aiTemperature" REAL NOT NULL DEFAULT 0.2,
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
    "imageModel" TEXT NOT NULL DEFAULT 'dall-e-3',
    "imageStyle" TEXT NOT NULL DEFAULT 'bw-anime',
    "imageMaxPerBook" INTEGER NOT NULL DEFAULT 6,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "workerConcurrency" INTEGER NOT NULL DEFAULT 2,
    "workerChapterConcurrency" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WatermarkMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phrase" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Illustration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "chapterTitle" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "imagePath" TEXT NOT NULL,
    "imageModel" TEXT,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Illustration_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChapterAttribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "sourceMtime" BIGINT NOT NULL,
    "parserVersion" TEXT NOT NULL DEFAULT 'conversation-v3',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChapterAttribution_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");

-- CreateIndex
CREATE INDEX "Book_addedAt_idx" ON "Book"("addedAt");

-- CreateIndex
CREATE INDEX "Book_language_idx" ON "Book"("language");

-- CreateIndex
CREATE INDEX "Book_readStatus_idx" ON "Book"("readStatus");

-- CreateIndex
CREATE INDEX "Book_lastRead_idx" ON "Book"("lastRead");

-- CreateIndex
CREATE INDEX "Book_isFavorite_idx" ON "Book"("isFavorite");

-- CreateIndex
CREATE INDEX "Voice_bookId_idx" ON "Voice"("bookId");

-- CreateIndex
CREATE INDEX "Voice_bookId_kind_idx" ON "Voice"("bookId", "kind");

-- CreateIndex
CREATE INDEX "Character_bookId_idx" ON "Character"("bookId");

-- CreateIndex
CREATE INDEX "Character_bookId_role_idx" ON "Character"("bookId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Character_bookId_name_key" ON "Character"("bookId", "name");

-- CreateIndex
CREATE INDEX "CharacterRelationship_bookId_idx" ON "CharacterRelationship"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterRelationship_bookId_fromCharId_toCharId_relationship_key" ON "CharacterRelationship"("bookId", "fromCharId", "toCharId", "relationship");

-- CreateIndex
CREATE INDEX "CharacterChapterAppearance_characterId_idx" ON "CharacterChapterAppearance"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterChapterAppearance_characterId_chapterIndex_key" ON "CharacterChapterAppearance"("characterId", "chapterIndex");

-- CreateIndex
CREATE INDEX "PendingBibleDiff_bookId_status_idx" ON "PendingBibleDiff"("bookId", "status");

-- CreateIndex
CREATE INDEX "BibleRefreshLog_bookId_idx" ON "BibleRefreshLog"("bookId");

-- CreateIndex
CREATE INDEX "AudiobookChapter_bookId_status_idx" ON "AudiobookChapter"("bookId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AudiobookChapter_bookId_chapterFile_key" ON "AudiobookChapter"("bookId", "chapterFile");

-- CreateIndex
CREATE INDEX "Shelf_sortOrder_idx" ON "Shelf"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "WatermarkMemory_phrase_key" ON "WatermarkMemory"("phrase");

-- CreateIndex
CREATE INDEX "WatermarkMemory_hitCount_idx" ON "WatermarkMemory"("hitCount");

-- CreateIndex
CREATE INDEX "WatermarkMemory_source_idx" ON "WatermarkMemory"("source");

-- CreateIndex
CREATE INDEX "Illustration_bookId_idx" ON "Illustration"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "Illustration_bookId_chapterIndex_key" ON "Illustration"("bookId", "chapterIndex");

-- CreateIndex
CREATE INDEX "ChapterAttribution_bookId_idx" ON "ChapterAttribution"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "ChapterAttribution_bookId_chapterIndex_key" ON "ChapterAttribution"("bookId", "chapterIndex");


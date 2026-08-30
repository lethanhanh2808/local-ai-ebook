-- Migration: 20260829000000_create_user_and_user_settings
--
-- Backfills the User / UserSettings / AuditLog tables that were added to
-- schema.prisma by the auth refactor (commit 805b55bb) but never given a
-- matching migration. Existing VM deployments created these tables by hand,
-- so all CREATE statements are guarded with IF NOT EXISTS — applying this
-- migration on a live DB is a no-op, while fresh deploys get the tables.
--
-- Must run BEFORE 20260830000000_add_ai_allow_insecure_tls because that
-- migration ALTERs UserSettings.
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL DEFAULT 'admin',
    "name" TEXT NOT NULL DEFAULT 'Local user',
    "email" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key"    ON "User"("email");

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "targetUserId" TEXT,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AuditLog_actorId_createdAt_idx"     ON "AuditLog"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_targetUserId_createdAt_idx" ON "AuditLog"("targetUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx"      ON "AuditLog"("action", "createdAt");

CREATE TABLE IF NOT EXISTS "UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "aiProvider" TEXT NOT NULL DEFAULT 'omlx-local',
    "aiApiKey" TEXT,
    "aiBaseUrl" TEXT,
    "aiAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserSettings_userId_key" ON "UserSettings"("userId");
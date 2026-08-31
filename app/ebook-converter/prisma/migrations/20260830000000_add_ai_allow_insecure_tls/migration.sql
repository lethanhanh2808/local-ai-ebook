-- Migration: 20260830000000_add_ai_allow_insecure_tls
-- Adds the insecure-TLS override for custom OpenAI-compatible gateways
-- to both the app-level Settings and per-user overrides.

ALTER TABLE "Settings"
ADD COLUMN "aiAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false;

  -- NOTE: UserSettings.aiAllowInsecureTls is already created by migration
  -- 20260829000000_create_user_and_user_settings (its CREATE TABLE includes the
  -- column). This ALTER was removed to keep the history replayable on a fresh
  -- shadow database.

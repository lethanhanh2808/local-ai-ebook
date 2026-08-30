-- Migration: 20260830000000_add_ai_allow_insecure_tls
-- Adds the insecure-TLS override for custom OpenAI-compatible gateways
-- to both the app-level Settings and per-user overrides.

ALTER TABLE "Settings"
ADD COLUMN "aiAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "UserSettings"
ADD COLUMN "aiAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false;

-- Migration: 20260831000000_add_image_allow_insecure_tls
-- Adds the insecure-TLS override for custom OpenAI-compatible image
-- gateways to both the app-level Settings and per-user overrides, so the
-- same self-signed/private gateway used for text AI can also serve image
-- generation.

ALTER TABLE "Settings"
ADD COLUMN "imageAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "UserSettings"
ADD COLUMN "imageAllowInsecureTls" BOOLEAN NOT NULL DEFAULT false;

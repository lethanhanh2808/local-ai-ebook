-- Migration: 20260901000003_add_character_voice_settings
-- Moves per-character voice customization (speed/emotion) onto the Character
-- row instead of the shared Voice row, so two characters that share the same
-- voiceId keep independent speed/emotion settings.

ALTER TABLE "Character" ADD COLUMN "defaultEmotion" TEXT;
ALTER TABLE "Character" ADD COLUMN "defaultSpeed" REAL;

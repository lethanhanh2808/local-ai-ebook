// src/lib/db/settings.ts
// Singleton settings row helpers.
import { prisma } from './client';
import type { Settings } from '@prisma/client';
import { DEFAULT_IMAGE_STYLE, normalizeImageStyle } from '@/lib/ai/image-generator';

export type AIProvider = 'omlx-local' | 'minimax-cloud' | 'openai' | 'custom';
export type TTSProvider = 'vieneu' | 'piper' | 'moss-nano';

export const AI_PROVIDERS: Array<{
  id: AIProvider; label: string; desc: string; needsKey: boolean;
}> = [
  { id: 'omlx-local',    label: 'OMLX (local)',     desc: 'Local Qwen/DeepSeek model — no API key, runs on your machine', needsKey: false },
  { id: 'minimax-cloud', label: 'MiniMax Cloud',    desc: 'MiniMax M-series models — fast cloud inference, requires API key', needsKey: true },
  { id: 'openai',        label: 'OpenAI',           desc: 'GPT-4o / GPT-4 / o1 — high quality, requires OpenAI API key', needsKey: true },
  { id: 'custom',        label: 'Custom (OpenAI-compatible)', desc: 'Any OpenAI-compatible endpoint (Together, Anyscale, local llama.cpp…)', needsKey: true },
];

export const TTS_PROVIDERS: Array<{ id: TTSProvider; label: string; desc: string }> = [
  { id: 'vieneu',  label: 'VieNeu-TTS',    desc: 'Vietnamese-native, 10 built-in voices, voice cloning (recommended)' },
  { id: 'piper',   label: 'Piper',         desc: 'Legacy Vietnamese TTS — single voice, 22 kHz' },
  { id: 'moss-nano', label: 'MOSS-TTS-Nano', desc: 'English voice cloning (no Vietnamese support)' },
];

/** Get the current settings (creates the singleton row if missing).
 *  Auto-upgrades legacy `imageStyle` values to the new black-and-white
 *  family so existing installs silently switch to the cohesive B&W look
 *  the user asked for. Persists the upgrade so subsequent reads skip
 *  this work. */
export async function getSettings(): Promise<Settings> {
  // Atomic singleton initialization avoids a first-request race where two
  // concurrent pages both observed no row and one failed its create.
  let s = await prisma.settings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
  // One-time migration: legacy "" / "ink" gets bumped to bw-anime so
  // every existing install picks up the new default without a manual
  // /settings visit. Unknown values get normalised to the default.
  if (!s.imageStyle || s.imageStyle === 'ink') {
    const next = DEFAULT_IMAGE_STYLE;
    if (next !== s.imageStyle) {
      const updated = await prisma.settings.update({
        where: { id: 'singleton' },
        data: { imageStyle: next },
      });
      return updated;
    }
  } else if (normalizeImageStyle(s.imageStyle) !== s.imageStyle) {
    const next = normalizeImageStyle(s.imageStyle);
    const updated = await prisma.settings.update({
      where: { id: 'singleton' },
      data: { imageStyle: next },
    });
    return updated;
  }
  return s;
}

/** Update one or more settings fields. */
export async function updateSettings(data: Partial<Omit<Settings, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Settings> {
  await getSettings(); // ensure singleton exists
  return prisma.settings.update({
    where: { id: 'singleton' },
    data,
  });
}

/** Sanitize settings for client — NEVER expose the raw API keys.
 *  Returns separate `aiApiKeyMasked` and `imageApiKeyMasked` fields for display.
 *  Clears the actual key fields in the response so a stale masked value
 *  can't be re-submitted as the new key. */
export function maskSettings(s: Settings): Settings & { aiApiKeyMasked: string | null; imageApiKeyMasked: string | null; aiApiKey: null; imageApiKey: null } {
  let masked: string | null = null;
  if (s.aiApiKey) {
    if (s.aiApiKey.length <= 4) masked = '••••';
    else masked = '••••••••' + s.aiApiKey.slice(-4);
  }
  let maskedImg: string | null = null;
  if (s.imageApiKey) {
    if (s.imageApiKey.length <= 4) maskedImg = '••••';
    else maskedImg = '••••••••' + s.imageApiKey.slice(-4);
  }
  const { aiApiKey: _a, imageApiKey: _i, ...rest } = s;
  return {
    ...rest,
    aiApiKey: null,
    imageApiKey: null,
    aiApiKeyMasked: masked,
    imageApiKeyMasked: maskedImg,
  };
}

// src/lib/db/settings.ts
// Singleton settings row helpers.
import { prisma } from './client';
import type { Settings } from '@prisma/client';
import { DEFAULT_IMAGE_STYLE, normalizeImageStyle } from '@/lib/ai/image-generator';

export type AIProvider = 'omlx-local' | 'minimax-cloud' | 'openai' | 'custom';
// 2026-07-12: Piper and MOSS-TTS-Nano removed. VieNeu is the sole backend.
export type TTSProvider = 'vieneu';

export type AIProviderDefaults = {
  provider: AIProvider;
  label: string;
  desc: string;
  needsKey: boolean;
  baseUrl: string;
  model: string;
  maxTokens: number;
};

export const AI_PROVIDER_DEFAULTS: Record<AIProvider, AIProviderDefaults> = {
  'omlx-local': {
    provider: 'omlx-local',
    label: 'OMLX (local)',
    desc: 'Local Qwen/DeepSeek model — no API key, runs on your machine',
    needsKey: false,
    baseUrl: '',
    model: 'Ornith-1.0-9B-mlx-4Bit',
    maxTokens: 16384,
  },
  'minimax-cloud': {
    provider: 'minimax-cloud',
    label: 'MiniMax Cloud',
    desc: 'MiniMax M-series models — fast cloud inference, requires API key',
    needsKey: true,
    baseUrl: 'https://api.minimax.io/v1',
    model: 'MiniMax-Text-01',
    maxTokens: 16384,
  },
  openai: {
    provider: 'openai',
    label: 'OpenAI',
    desc: 'GPT-4o / GPT-4 / o1 — high quality, requires OpenAI API key',
    needsKey: true,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    maxTokens: 16384,
  },
  custom: {
    provider: 'custom',
    label: 'Custom (OpenAI-compatible)',
    desc: 'Any OpenAI-compatible endpoint (Together, Anyscale, local llama.cpp…)',
    needsKey: true,
    baseUrl: '',
    model: '',
    maxTokens: 8192,
  },
};

export const AI_PROVIDERS: Array<{
  id: AIProvider; label: string; desc: string; needsKey: boolean;
}> = Object.values(AI_PROVIDER_DEFAULTS).map(({ provider, label, desc, needsKey }) => ({
  id: provider,
  label,
  desc,
  needsKey,
}));

export function getAiProviderDefaults(provider: AIProvider): AIProviderDefaults {
  return AI_PROVIDER_DEFAULTS[provider];
}

export const TTS_PROVIDERS: Array<{ id: TTSProvider; label: string; desc: string }> = [
  { id: 'vieneu',  label: 'VieNeu-TTS',    desc: 'Vietnamese-native, 10 built-in voices, voice cloning (only TTS backend)' },
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

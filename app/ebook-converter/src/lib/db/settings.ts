// src/lib/db/settings.ts
// Singleton settings row helpers.
import { prisma } from './client';
import type { Settings } from '@prisma/client';
import { DEFAULT_IMAGE_STYLE, normalizeImageStyle } from '@/lib/ai/image-generator';

export type AIProvider = 'omlx-local' | 'minimax-cloud' | 'openai' | 'custom';
// TTSProvider and TTS_PROVIDERS live in src/lib/settings/tts-providers.ts
// (client-safe — must not pull in Prisma/node:* builtins because
// src/app/settings/page.tsx is a `'use client'` component).
// 2026-07-12: Piper and MOSS-TTS-Nano removed.
// 2026-08-31: VieNeu is the only TTS backend. The provider registry in
// lib/tts/provider.ts is kept so swapping in a second engine is a single
// entry in tts-providers.ts.
export type { TTSProvider } from '@/lib/settings/tts-providers';
export { TTS_PROVIDERS } from '@/lib/settings/tts-providers';

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
    model: 'default',
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

export type SettingsScope = 'app' | 'session' | 'user';
export type UserRole = 'ADMIN' | 'USER';

export const SETTINGS_SESSION_COOKIE = 'ai-settings-session';
export const SETTINGS_USER_COOKIE = 'ai-settings-user';
export const CURRENT_USER_COOKIE = 'ebook-user-id';

export function normalizeUserRole(role?: string | null): UserRole {
  const normalized = (role ?? 'USER').toUpperCase();
  return normalized === 'ADMIN' ? 'ADMIN' : 'USER';
}

export function canUpdateSettings(role?: string | null): boolean {
  return normalizeUserRole(role) === 'ADMIN';
}

export function parseCookieValue(cookieHeader: string | null | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  const section = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (!section) return null;
  const raw = section.slice(cookieName.length + 1);
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw || null;
  }
}

export function getAiProviderDefaults(provider: AIProvider): AIProviderDefaults {
  return AI_PROVIDER_DEFAULTS[provider];
}

export function readCookieOverrides(cookieHeader: string | null | undefined, cookieName: string): Partial<Settings> {
  if (!cookieHeader) return {};
  const section = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (!section) return {};

  const raw = section.slice(cookieName.length + 1);
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded) as Partial<Settings>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readSessionOverrides(cookieHeader?: string | null): Partial<Settings> {
  return readCookieOverrides(cookieHeader, SETTINGS_SESSION_COOKIE);
}

export function readUserOverrides(cookieHeader?: string | null): Partial<Settings> {
  return readCookieOverrides(cookieHeader, SETTINGS_USER_COOKIE);
}

export function mergeEffectiveSettings(
  appDefaults: Partial<Settings> | null | undefined,
  userOverride: Partial<Settings> | null | undefined,
  sessionOverride: Partial<Settings> | null | undefined,
): Settings {
  const base = { ...(appDefaults ?? {}) } as Settings;
  const merged = {
    ...base,
    ...(userOverride ?? {}),
    ...(sessionOverride ?? {}),
  } as Settings;
  return merged;
}

export function mergeSettingsWithOverrides(base: Settings, overrides: Array<Partial<Settings> | null | undefined>): Settings {
  let merged = { ...base };
  for (const override of overrides) {
    if (!override || Object.keys(override).length === 0) continue;
    merged = { ...merged, ...override };
  }
  return merged;
}

export function buildOverrideCookieValue(cookieName: string, settings: Partial<Settings>): string {
  const payload = JSON.stringify(settings);
  return `${cookieName}=${encodeURIComponent(payload)}; Path=/; SameSite=Lax; Max-Age=86400`;
}

export function buildSessionCookieValue(settings: Partial<Settings>): string {
  return buildOverrideCookieValue(SETTINGS_SESSION_COOKIE, settings);
}

export function buildUserCookieValue(settings: Partial<Settings>): string {
  return buildOverrideCookieValue(SETTINGS_USER_COOKIE, settings);
}

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

export async function ensureDefaultUser() {
  let user = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
  });
  if (!user) {
    user = await prisma.user.create({
      data: {
        username: 'admin',
        name: 'Local admin',
        email: 'admin@local',
        role: 'ADMIN',
      },
    });
  }
  return user;
}

export async function resolveCurrentUser(
  reqOrHeaders?: { get?: (headerName: string) => string | null } | string | null,
): Promise<{ id: string; role: UserRole; name: string }> {
  const cookieHeader = typeof reqOrHeaders === 'string' ? reqOrHeaders : reqOrHeaders?.get?.('cookie') ?? null;
  const userIdFromCookie = parseCookieValue(cookieHeader, CURRENT_USER_COOKIE);
  const explicitUserId = userIdFromCookie || undefined;

  let user = explicitUserId ? await prisma.user.findUnique({ where: { id: explicitUserId } }) : null;
  if (!user) {
    user = await ensureDefaultUser();
  }

  return {
    id: user.id,
    role: normalizeUserRole(user.role),
    name: user.name,
  };
}

export async function getUserSettings(userId?: string): Promise<Partial<Settings> | null> {
  const resolvedUserId = userId ?? (await ensureDefaultUser()).id;
  const row = await prisma.userSettings.findUnique({
    where: { userId: resolvedUserId },
  });
  if (!row) return null;

  return {
    aiProvider: row.aiProvider,
    aiApiKey: row.aiApiKey,
    aiBaseUrl: row.aiBaseUrl,
    aiAllowInsecureTls: row.aiAllowInsecureTls,
    aiModel: row.aiModel,
    aiMaxTokens: row.aiMaxTokens,
    aiTemperature: row.aiTemperature,
    aiThinkingCombine: row.aiThinkingCombine,
    aiThinkingFullLLM: row.aiThinkingFullLLM,
    ttsProvider: row.ttsProvider,
    defaultAiEnhance: row.defaultAiEnhance,
    defaultAiWatermarkClean: row.defaultAiWatermarkClean,
    defaultDeepFormat: row.defaultDeepFormat,
    defaultLanguage: row.defaultLanguage,
    defaultReaderFriendly: row.defaultReaderFriendly,
    aiEnhanceConcurrency: row.aiEnhanceConcurrency,
    imageProvider: row.imageProvider,
    imageApiKey: row.imageApiKey,
    imageBaseUrl: row.imageBaseUrl,
    imageAllowInsecureTls: row.imageAllowInsecureTls,
    imageModel: row.imageModel,
    imageStyle: row.imageStyle,
    imageMaxPerBook: row.imageMaxPerBook,
    theme: row.theme,
  } as Partial<Settings>;
}

export async function upsertUserSettings(userId: string | undefined, data: Partial<Settings>): Promise<Partial<Settings>> {
  const resolvedUserId = userId ?? (await ensureDefaultUser()).id;
  const row = await prisma.userSettings.upsert({
    where: { userId: resolvedUserId },
    update: {
      aiProvider: data.aiProvider ?? undefined,
      aiApiKey: data.aiApiKey ?? undefined,
      aiBaseUrl: data.aiBaseUrl ?? undefined,
      aiAllowInsecureTls: data.aiAllowInsecureTls ?? undefined,
      aiModel: data.aiModel ?? undefined,
      aiMaxTokens: data.aiMaxTokens ?? undefined,
      aiTemperature: data.aiTemperature ?? undefined,
      aiThinkingCombine: data.aiThinkingCombine ?? undefined,
      aiThinkingFullLLM: data.aiThinkingFullLLM ?? undefined,
      ttsProvider: data.ttsProvider ?? undefined,
      defaultAiEnhance: data.defaultAiEnhance ?? undefined,
      defaultAiWatermarkClean: data.defaultAiWatermarkClean ?? undefined,
      defaultDeepFormat: data.defaultDeepFormat ?? undefined,
      defaultLanguage: data.defaultLanguage ?? undefined,
      defaultReaderFriendly: data.defaultReaderFriendly ?? undefined,
      aiEnhanceConcurrency: data.aiEnhanceConcurrency ?? undefined,
      imageProvider: data.imageProvider ?? undefined,
      imageApiKey: data.imageApiKey ?? undefined,
      imageBaseUrl: data.imageBaseUrl ?? undefined,
      imageAllowInsecureTls: data.imageAllowInsecureTls ?? undefined,
      imageModel: data.imageModel ?? undefined,
      imageStyle: data.imageStyle ?? undefined,
      imageMaxPerBook: data.imageMaxPerBook ?? undefined,
      theme: data.theme ?? undefined,
    },
    create: {
      userId: resolvedUserId,
      aiProvider: data.aiProvider ?? 'omlx-local',
      aiApiKey: data.aiApiKey ?? null,
      aiBaseUrl: data.aiBaseUrl ?? null,
      aiAllowInsecureTls: data.aiAllowInsecureTls ?? false,
      aiModel: data.aiModel ?? 'default',
      aiMaxTokens: data.aiMaxTokens ?? 4096,
      aiTemperature: data.aiTemperature ?? 0.2,
      aiThinkingCombine: data.aiThinkingCombine ?? true,
      aiThinkingFullLLM: data.aiThinkingFullLLM ?? false,
      ttsProvider: data.ttsProvider ?? 'vieneu',
      defaultAiEnhance: data.defaultAiEnhance ?? true,
      defaultAiWatermarkClean: data.defaultAiWatermarkClean ?? true,
      defaultDeepFormat: data.defaultDeepFormat ?? false,
      defaultLanguage: data.defaultLanguage ?? 'vi',
      defaultReaderFriendly: data.defaultReaderFriendly ?? true,
      aiEnhanceConcurrency: data.aiEnhanceConcurrency ?? 3,
      imageProvider: data.imageProvider ?? 'none',
      imageApiKey: data.imageApiKey ?? null,
      imageBaseUrl: data.imageBaseUrl ?? null,
      imageAllowInsecureTls: data.imageAllowInsecureTls ?? false,
      imageModel: data.imageModel ?? 'dall-e-3',
      imageStyle: data.imageStyle ?? 'bw-anime',
      imageMaxPerBook: data.imageMaxPerBook ?? 6,
      theme: data.theme ?? 'system',
    },
  });

  return await getUserSettings(resolvedUserId) ?? {};
}

export async function getEffectiveSettings(userId?: string, sessionOverride?: Partial<Settings> | null): Promise<Settings> {
  const base = await getSettings();
  const userOverride = await getUserSettings(userId);
  return mergeEffectiveSettings(base, userOverride, sessionOverride ?? null);
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

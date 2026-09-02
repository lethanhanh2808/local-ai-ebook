// src/app/api/settings/route.ts
// GET   /api/settings   – fetch current settings (API key masked)
// PUT   /api/settings   – update fields (apiKey: '' to clear)
// (POST /api/settings/test-ai lives in ./test-ai/route.ts)
import { NextRequest, NextResponse } from 'next/server';
import type { Settings } from '@prisma/client';
import {
  getSettings,
  updateSettings,
  maskSettings,
  AI_PROVIDERS,
  readSessionOverrides,
  readUserOverrides,
  mergeSettingsWithOverrides,
  buildSessionCookieValue,
  buildUserCookieValue,
  getUserSettings,
  upsertUserSettings,
  resolveCurrentUser,
  normalizeUserRole,
  canUpdateSettings,
  CURRENT_USER_COOKIE,
  type SettingsScope,
} from '@/lib/db/settings';
import { writeAuditLog } from '@/lib/audit-log';
import { TTS_PROVIDERS } from '@/lib/settings/tts-providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const currentUser = await resolveCurrentUser(req.headers);
    const base = await getSettings();
    const sessionOverride = readSessionOverrides(req.headers.get('cookie'));
    const userOverride = await getUserSettings(currentUser.id);
    const effective = mergeSettingsWithOverrides(base, [userOverride, sessionOverride]);

    const response = NextResponse.json(maskSettings(effective));
    const currentCookie = req.headers.get('cookie') ?? '';
    if (!currentCookie.includes(`${CURRENT_USER_COOKIE}=`)) {
      response.headers.set('Set-Cookie', `${CURRENT_USER_COOKIE}=${encodeURIComponent(currentUser.id)}; Path=/; SameSite=Lax; Max-Age=31536000`);
    }
    return response;
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

const ALLOWED_AI_PROVIDERS = new Set(AI_PROVIDERS.map((p) => p.id));
const ALLOWED_TTS_PROVIDERS = new Set<string>(TTS_PROVIDERS.map((p) => p.id));
const ALLOWED_IMAGE_PROVIDERS = new Set(['none', 'openai', 'minimax', 'custom']);
const ALLOWED_THEMES = new Set(['light', 'dark', 'system']);

export async function PUT(req: NextRequest) {
  try {
    const currentUser = await resolveCurrentUser(req.headers);
    const body = await req.json() as Record<string, unknown>;
    const request = body as any;
    if (!canUpdateSettings(currentUser.role)) {
      return NextResponse.json({ error: 'Forbidden: admin role required to change settings.' }, { status: 403 });
    }

    const scope = (request.scope ?? 'app') as SettingsScope;
    const data: Record<string, unknown> = {};

    if (scope === 'session' || scope === 'user') {
      const base = await getSettings();
      const sessionOverride = readSessionOverrides(req.headers.get('cookie'));
      const userOverride = await getUserSettings(currentUser.id);
      const effectiveBase = mergeSettingsWithOverrides(base, [userOverride, sessionOverride]);

      const effectiveOverride = {
        aiProvider: request.aiProvider,
        aiApiKey: request.aiApiKey,
        aiBaseUrl: request.aiBaseUrl,
        aiAllowInsecureTls: request.aiAllowInsecureTls,
        aiModel: request.aiModel,
        aiMaxTokens: request.aiMaxTokens,
        aiTemperature: request.aiTemperature,
        ttsProvider: request.ttsProvider,
        defaultAiEnhance: request.defaultAiEnhance,
        defaultAiWatermarkClean: request.defaultAiWatermarkClean,
        defaultDeepFormat: request.defaultDeepFormat,
        defaultReaderFriendly: request.defaultReaderFriendly,
        defaultLanguage: request.defaultLanguage,
        imageProvider: request.imageProvider,
        imageApiKey: request.imageApiKey,
        imageBaseUrl: request.imageBaseUrl,
        imageAllowInsecureTls: request.imageAllowInsecureTls,
        imageModel: request.imageModel,
        imageStyle: request.imageStyle,
        imageMaxPerBook: request.imageMaxPerBook,
        theme: request.theme,
      } as Partial<Settings>;

      const nextValue = {
        ...effectiveBase,
        ...effectiveOverride,
        aiAllowInsecureTls: request.aiAllowInsecureTls ?? effectiveBase.aiAllowInsecureTls ?? false,
        aiApiKey: request.aiApiKey ?? effectiveBase.aiApiKey ?? null,
        imageApiKey: request.imageApiKey ?? effectiveBase.imageApiKey ?? null,
      } as Partial<Settings>;

      if (scope === 'user') {
        const saved = await upsertUserSettings(currentUser.id, {
          ...effectiveOverride,
          aiApiKey: request.aiApiKey ?? null,
          imageApiKey: request.imageApiKey ?? null,
        } as Partial<Settings>);
        const response = NextResponse.json(maskSettings({ ...base, ...saved, ...nextValue } as Settings));
        response.headers.set('Set-Cookie', `${CURRENT_USER_COOKIE}=${encodeURIComponent(currentUser.id)}; Path=/; SameSite=Lax; Max-Age=31536000`);
        return response;
      }

      const cookieName = 'ai-settings-session';
      const response = NextResponse.json(maskSettings(nextValue as Settings), {
        headers: {
          'Set-Cookie': [
            buildSessionCookieValue({
              ...nextValue,
              aiApiKey: nextValue.aiApiKey ?? null,
              imageApiKey: nextValue.imageApiKey ?? null,
            }),
            `${CURRENT_USER_COOKIE}=${encodeURIComponent(currentUser.id)}; Path=/; SameSite=Lax; Max-Age=31536000`,
          ].join(', '),
        },
      });
      response.headers.set('X-Settings-Scope', cookieName);
      return response;
    }

    // Whitelist of allowed fields
    if (typeof request.aiProvider === 'string' && ALLOWED_AI_PROVIDERS.has(request.aiProvider as 'omlx-local' | 'minimax-cloud' | 'openai' | 'custom')) {
      data.aiProvider = request.aiProvider;
    }
    if (request.aiApiKey === '' || typeof request.aiApiKey === 'string') {
      data.aiApiKey = request.aiApiKey || null; // empty string clears the key
    }
    if (request.aiBaseUrl === '' || typeof request.aiBaseUrl === 'string') {
      data.aiBaseUrl = request.aiBaseUrl || null;
    }
    if (typeof request.aiAllowInsecureTls === 'boolean') data.aiAllowInsecureTls = request.aiAllowInsecureTls;
    if (typeof request.aiModel === 'string' && request.aiModel.trim()) data.aiModel = request.aiModel.trim().slice(0, 200);
    if (typeof request.aiMaxTokens === 'number' && Number.isFinite(request.aiMaxTokens)) data.aiMaxTokens = Math.max(64, Math.min(32000, Math.floor(request.aiMaxTokens)));
    if (typeof request.aiTemperature === 'number' && Number.isFinite(request.aiTemperature)) data.aiTemperature = Math.max(0, Math.min(2, request.aiTemperature));
    if (typeof request.ttsProvider === 'string' && ALLOWED_TTS_PROVIDERS.has(request.ttsProvider)) data.ttsProvider = request.ttsProvider;
    if (typeof request.defaultAiEnhance === 'boolean') data.defaultAiEnhance = request.defaultAiEnhance;
    if (typeof request.defaultAiWatermarkClean === 'boolean') data.defaultAiWatermarkClean = request.defaultAiWatermarkClean;
    if (typeof request.defaultDeepFormat === 'boolean') data.defaultDeepFormat = request.defaultDeepFormat;
    if (typeof request.defaultReaderFriendly === 'boolean') data.defaultReaderFriendly = request.defaultReaderFriendly;
    if (typeof request.workerConcurrency === 'number' && Number.isFinite(request.workerConcurrency)) {
      data.workerConcurrency = Math.max(1, Math.min(8, Math.floor(request.workerConcurrency)));
    }
    if (typeof request.workerChapterConcurrency === 'number' && Number.isFinite(request.workerChapterConcurrency)) {
      data.workerChapterConcurrency = Math.max(1, Math.min(8, Math.floor(request.workerChapterConcurrency)));
    }
    // AI-enhancement concurrency: live-readable from chapter-enhancer.ts
    // each batch, so the user can dial this from the settings page while
    // a long conversion is in progress. Clamped to [1, 16] — higher values
    // saturate Apple Silicon KV cache on a 9B 4Bit model.
    if (typeof request.aiEnhanceConcurrency === 'number' && Number.isFinite(request.aiEnhanceConcurrency)) {
      data.aiEnhanceConcurrency = Math.max(1, Math.min(16, Math.floor(request.aiEnhanceConcurrency)));
    }
    // Character-bible analysis concurrency: 1=sequential, 2-16=parallel.
    if (typeof request.bibleConcurrency === 'number' && Number.isFinite(request.bibleConcurrency)) {
      data.bibleConcurrency = Math.max(1, Math.min(16, Math.floor(request.bibleConcurrency)));
    }
    // Max chapter characters fed to the character-bible LLM per chapter.
    // Clamped to [2000, 40000] — too low loses context, too high risks
    // upstream gateway 504 time-outs on slow models.
    if (typeof request.bibleChapterChars === 'number' && Number.isFinite(request.bibleChapterChars)) {
      data.bibleChapterChars = Math.max(2000, Math.min(40000, Math.floor(request.bibleChapterChars)));
    }
    if (typeof request.imageProvider === 'string' && ALLOWED_IMAGE_PROVIDERS.has(request.imageProvider)) data.imageProvider = request.imageProvider;
    if (request.imageApiKey === '' || typeof request.imageApiKey === 'string') data.imageApiKey = request.imageApiKey || null;
    if (request.imageBaseUrl === '' || typeof request.imageBaseUrl === 'string') data.imageBaseUrl = request.imageBaseUrl || null;
    if (typeof request.imageAllowInsecureTls === 'boolean') data.imageAllowInsecureTls = request.imageAllowInsecureTls;
    if (typeof request.imageModel === 'string' && request.imageModel.trim()) data.imageModel = request.imageModel.trim().slice(0, 200);
    if (typeof request.imageStyle === 'string') data.imageStyle = request.imageStyle.trim().slice(0, 80);
    if (typeof request.imageMaxPerBook === 'number' && Number.isFinite(request.imageMaxPerBook)) data.imageMaxPerBook = Math.max(0, Math.min(50, Math.floor(request.imageMaxPerBook)));
    if (typeof request.defaultLanguage === 'string' && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(request.defaultLanguage.trim())) data.defaultLanguage = request.defaultLanguage.trim();
    if (typeof request.theme === 'string' && ALLOWED_THEMES.has(request.theme)) data.theme = request.theme;

    const updated = await updateSettings(data as Partial<Omit<Settings, 'id' | 'createdAt' | 'updatedAt'>>);
    await writeAuditLog({
      action: 'settings_updated',
      actorId: currentUser.id,
      details: `Updated settings scope=${scope}: ${Object.keys(data).join(', ') || 'no fields visible'}`,
    });
    return NextResponse.json(maskSettings(updated));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

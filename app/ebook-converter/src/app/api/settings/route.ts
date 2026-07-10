// src/app/api/settings/route.ts
// GET   /api/settings   – fetch current settings (API key masked)
// PUT   /api/settings   – update fields (apiKey: '' to clear)
// (POST /api/settings/test-ai lives in ./test-ai/route.ts)
import { NextRequest, NextResponse } from 'next/server';
import { getSettings, updateSettings, maskSettings, AI_PROVIDERS, TTS_PROVIDERS } from '@/lib/db/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const s = await getSettings();
    return NextResponse.json(maskSettings(s));
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
    const body = await req.json() as Record<string, unknown>;
    // Whitelist of allowed fields
    const data: Record<string, unknown> = {};
    if (typeof body.aiProvider === 'string' && ALLOWED_AI_PROVIDERS.has(body.aiProvider as 'omlx-local' | 'minimax-cloud' | 'openai' | 'custom')) {
      data.aiProvider = body.aiProvider;
    }
    if (body.aiApiKey === '' || typeof body.aiApiKey === 'string') {
      data.aiApiKey = body.aiApiKey || null; // empty string clears the key
    }
    if (body.aiBaseUrl === '' || typeof body.aiBaseUrl === 'string') {
      data.aiBaseUrl = body.aiBaseUrl || null;
    }
    if (typeof body.aiModel === 'string' && body.aiModel.trim()) data.aiModel = body.aiModel.trim().slice(0, 200);
    if (typeof body.aiMaxTokens === 'number' && Number.isFinite(body.aiMaxTokens)) data.aiMaxTokens = Math.max(64, Math.min(32000, Math.floor(body.aiMaxTokens)));
    if (typeof body.aiTemperature === 'number' && Number.isFinite(body.aiTemperature)) data.aiTemperature = Math.max(0, Math.min(2, body.aiTemperature));
    if (typeof body.ttsProvider === 'string' && ALLOWED_TTS_PROVIDERS.has(body.ttsProvider)) data.ttsProvider = body.ttsProvider;
    if (typeof body.defaultAiEnhance === 'boolean') data.defaultAiEnhance = body.defaultAiEnhance;
    if (typeof body.defaultAiWatermarkClean === 'boolean') data.defaultAiWatermarkClean = body.defaultAiWatermarkClean;
    if (typeof body.defaultDeepFormat === 'boolean') data.defaultDeepFormat = body.defaultDeepFormat;
    if (typeof body.defaultReaderFriendly === 'boolean') data.defaultReaderFriendly = body.defaultReaderFriendly;
    if (typeof body.workerConcurrency === 'number' && Number.isFinite(body.workerConcurrency)) {
      data.workerConcurrency = Math.max(1, Math.min(8, Math.floor(body.workerConcurrency)));
    }
    if (typeof body.workerChapterConcurrency === 'number' && Number.isFinite(body.workerChapterConcurrency)) {
      data.workerChapterConcurrency = Math.max(1, Math.min(8, Math.floor(body.workerChapterConcurrency)));
    }
    // AI-enhancement concurrency: live-readable from chapter-enhancer.ts
    // each batch, so the user can dial this from the settings page while
    // a long conversion is in progress. Clamped to [1, 16] — higher values
    // saturate Apple Silicon KV cache on a 9B 4Bit model.
    if (typeof body.aiEnhanceConcurrency === 'number' && Number.isFinite(body.aiEnhanceConcurrency)) {
      data.aiEnhanceConcurrency = Math.max(1, Math.min(16, Math.floor(body.aiEnhanceConcurrency)));
    }
    if (typeof body.imageProvider === 'string' && ALLOWED_IMAGE_PROVIDERS.has(body.imageProvider)) data.imageProvider = body.imageProvider;
    if (body.imageApiKey === '' || typeof body.imageApiKey === 'string') data.imageApiKey = body.imageApiKey || null;
    if (body.imageBaseUrl === '' || typeof body.imageBaseUrl === 'string') data.imageBaseUrl = body.imageBaseUrl || null;
    if (typeof body.imageModel === 'string' && body.imageModel.trim()) data.imageModel = body.imageModel.trim().slice(0, 200);
    if (typeof body.imageStyle === 'string') data.imageStyle = body.imageStyle.trim().slice(0, 80);
    if (typeof body.imageMaxPerBook === 'number' && Number.isFinite(body.imageMaxPerBook)) data.imageMaxPerBook = Math.max(0, Math.min(50, Math.floor(body.imageMaxPerBook)));
    if (typeof body.defaultLanguage === 'string' && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(body.defaultLanguage.trim())) data.defaultLanguage = body.defaultLanguage.trim();
    if (typeof body.theme === 'string' && ALLOWED_THEMES.has(body.theme)) data.theme = body.theme;

    const updated = await updateSettings(data);
    return NextResponse.json(maskSettings(updated));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

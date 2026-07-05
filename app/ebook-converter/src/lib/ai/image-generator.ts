// src/lib/ai/image-generator.ts
//
// Image generation client. Supports multiple backends through a single
// generateImage() interface — picks the right URL/format based on Settings.
//
// Backends (each has a different request/response shape):
//   - "none"      : disabled
//   - "openai"    : OpenAI DALL-E 3 (api.openai.com/v1/images/generations)
//   - "minimax"   : MiniMax (api.minimax.io/v1/image_generation) — MiniMax-specific format
//   - "custom"    : any OpenAI-compatible /v1/images/generations endpoint
//
// Image style presets adapt the prompt to match the novel's visual language:
//   ink        : traditional ink-wash (水墨画) — black/grey, dramatic
//   sketch     : pencil sketch, loose lines
//   watercolor : soft washes, light
//   manga      : manga/manhua style — clean lines, halftone shading
//   none       : provider default — no style guidance

import { getSettings } from '@/lib/db/settings';
import { chat, chatJSON } from './';

export type ImageStyle = 'ink' | 'sketch' | 'watercolor' | 'manga' | 'none';

/** Our internal size spec — mapped to provider-specific params. */
export type ImageSize =
  | '1024x1024'   // 1:1 square
  | '1024x1792'   // portrait
  | '1792x1024'   // landscape
  | '1024x1280'   // 4:5
  | '1280x1024';  // 5:4

export interface GenerateImageOptions {
  prompt: string;
  /** Defaults to "1024x1024". Mapped to aspect_ratio (MiniMax) or size (OpenAI). */
  size?: ImageSize;
  /** Style hint appended to the prompt. Default = settings.imageStyle. */
  style?: ImageStyle;
  /** Override the model (defaults to settings.imageModel). */
  model?: string;
  /** Random seed for reproducibility. */
  seed?: number;
}

export interface GenerateImageResult {
  /** Public URL (http(s)://...) or data: URL where the image can be fetched. */
  url: string;
  /** Base64 PNG bytes if returned in the response. */
  b64?: string;
  model: string;
  revisedPrompt?: string;
  /** Trace/request ID from the provider (useful for debugging MiniMax calls). */
  traceId?: string;
}

const STYLE_HINTS: Record<ImageStyle, string> = {
  ink: 'Traditional East-Asian ink-wash painting (水墨画). Black ink on white paper. Soft brush strokes, dramatic composition. Black and white only.',
  sketch: 'Pencil sketch. Loose confident lines, crosshatching for shading. White background. Black and white only.',
  watercolor: 'Soft watercolor wash. Light greyscale palette. Gentle gradients, no hard edges. Black and white only.',
  manga: 'Manga / manhua style. Clean line art, halftone shading. White background. Black and white only.',
  none: 'Black and white illustration. High contrast. White background.',
};

/** Build the full prompt with style + novel-context adaptation. */
function buildPrompt(opts: GenerateImageOptions, style: ImageStyle): string {
  const hint = STYLE_HINTS[style] ?? STYLE_HINTS.none;
  // For novels, we always want grayscale / black-and-white to feel cohesive
  // with the text — colour would feel out of place.
  return [
    opts.prompt.trim(),
    '',
    '── VISUAL STYLE ──',
    hint,
    '',
    'IMPORTANT: This is a black-and-white illustration. No colour. High contrast. White background. No text, no speech bubbles, no watermarks, no signatures, no borders.',
  ].join('\n');
}

// ── Provider config ──────────────────────────────────────────────────────
type Provider = 'none' | 'openai' | 'minimax' | 'custom';
interface ProviderCfg {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

async function pickProviderCfg(): Promise<ProviderCfg> {
  const s = await getSettings();
  const provider = (s.imageProvider ?? 'none') as Provider;
  const model = s.imageModel || (provider === 'minimax' ? 'image-01' : 'dall-e-3');
  const apiKey = s.imageApiKey?.trim() || '';
  switch (provider) {
    case 'none':
      throw new Error('Image generation is disabled (imageProvider=none). Configure it in /settings.');
    case 'openai':
      return {
        provider,
        baseUrl: s.imageBaseUrl?.trim() || 'https://api.openai.com/v1',
        apiKey,
        model,
      };
    case 'minimax':
      // MiniMax image API endpoint: https://api.minimax.io/v1/image_generation
      return {
        provider,
        baseUrl: s.imageBaseUrl?.trim() || 'https://api.minimax.io/v1',
        apiKey,
        model,
      };
    case 'custom':
      if (!s.imageBaseUrl) throw new Error('Custom image provider requires imageBaseUrl');
      return { provider, baseUrl: s.imageBaseUrl, apiKey, model };
  }
}

// ── Size mapping ─────────────────────────────────────────────────────────
// OpenAI uses pixel sizes; MiniMax uses aspect ratios. Convert our common
// "1024x1024" etc. to whichever the provider expects.

function sizeToOpenAISize(s: ImageSize | undefined): string {
  // OpenAI DALL-E 3 accepts: 1024x1024, 1024x1792, 1792x1024
  if (s === '1024x1792' || s === '1280x1024') return '1024x1792';
  if (s === '1792x1024' || s === '1024x1280') return '1792x1024';
  return '1024x1024';
}

function sizeToMiniMaxAspect(s: ImageSize | undefined): string {
  // MiniMax options: 1:1, 16:9, 4:3, 3:2, 2:3, 3:4, 9:16, 21:9
  // We map our novel-friendly sizes:
  if (s === '1024x1792' || s === '1024x1280') return '3:4';   // portrait, novel illustration
  if (s === '1792x1024' || s === '1280x1024') return '16:9';  // landscape
  return '1:1';
}

// ── MiniMax error code → human message ──────────────────────────────────
// (subset; full list at platform.minimax.io/docs/api-reference/image-generation-t2i)
const MINIMAX_ERRORS: Record<number, string> = {
  0: 'Thành công',
  1002: 'Rate limit — vui lòng thử lại sau',
  1004: 'API key không hợp lệ hoặc tài khoản chưa xác thực',
  1008: 'Tài khoản không đủ số dư — nạp thêm credits',
  1026: 'Nội dung prompt bị hệ thống chặn (vi phạm chính sách)',
  2013: 'Tham số request không hợp lệ (model, prompt, hoặc size)',
  2049: 'API key không đúng hoặc đã hết hạn — vui lòng tạo key mới',
};

// ── Main API ─────────────────────────────────────────────────────────────
/** Generate an image. Returns the public URL (or data: URL) of the result. */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const s = await getSettings();
  const style = opts.style ?? (s.imageStyle as ImageStyle) ?? 'ink';
  const cfg = await pickProviderCfg();

  if (!cfg.apiKey) throw new Error(`Image provider "${cfg.provider}" requires an image API key. Set it in /settings.`);

  const prompt = buildPrompt(opts, style);

  if (cfg.provider === 'minimax') {
    return generateViaMiniMax({ prompt, model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, size: opts.size, seed: opts.seed });
  }
  // openai + custom both use the OpenAI-compatible /v1/images/generations shape
  return generateViaOpenAI({ prompt, model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, size: opts.size });
}

// ── MiniMax image generation (https://api.minimax.io/v1/image_generation) ──
async function generateViaMiniMax(args: {
  prompt: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  size?: ImageSize;
  seed?: number;
}): Promise<GenerateImageResult> {
  const aspect_ratio = sizeToMiniMaxAspect(args.size);
  const body: Record<string, unknown> = {
    model: args.model || 'image-01',
    prompt: args.prompt,
    aspect_ratio,
    response_format: 'base64',  // we want the bytes to save locally
    n: 1,
    prompt_optimizer: false,
  };
  if (typeof args.seed === 'number') body.seed = args.seed;

  const res = await fetchWithTimeout(`${args.baseUrl.replace(/\/$/, '')}/image_generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MiniMax image API ${res.status}: ${friendlyError(text)}`);
  }

  const data = JSON.parse(text) as {
    data?: { image_urls?: string[]; image_base64?: string[] };
    metadata?: { success_count?: number; failed_count?: number };
    id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };

  // MiniMax returns base_resp.status_code — 0 = success, anything else = error
  const status = data.base_resp?.status_code ?? 0;
  if (status !== 0) {
    const msg = MINIMAX_ERRORS[status] ?? data.base_resp?.status_msg ?? `MiniMax error ${status}`;
    throw new Error(`MiniMax: ${msg}`);
  }

  // MiniMax returns image_base64[] (we requested base64 format)
  const b64 = data.data?.image_base64?.[0];
  const url = data.data?.image_urls?.[0];
  if (!b64 && !url) {
    throw new Error(`MiniMax returned no image (success=${data.metadata?.success_count}, failed=${data.metadata?.failed_count})`);
  }
  return {
    url: url ?? `data:image/png;base64,${b64}`,
    b64,
    model: args.model || 'image-01',
    traceId: data.id,
  };
}

// ── OpenAI-compatible image generation (DALL-E, Together, custom, …) ──
async function generateViaOpenAI(args: {
  prompt: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  size?: ImageSize;
}): Promise<GenerateImageResult> {
  const body = {
    model: args.model || 'dall-e-3',
    prompt: args.prompt,
    n: 1,
    size: sizeToOpenAISize(args.size),
    response_format: 'b64_json',
  };

  const res = await fetchWithTimeout(`${args.baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Image API ${res.status}: ${friendlyError(text)}`);

  const data = JSON.parse(text) as {
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };
  const item = data.data?.[0];
  if (!item) throw new Error('Image API returned no data');
  return {
    url: item.url ?? `data:image/png;base64,${item.b64_json ?? ''}`,
    b64: item.b64_json,
    model: args.model || 'dall-e-3',
    revisedPrompt: item.revised_prompt,
  };
}

// ── Shared helpers ──────────────────────────────────────────────────────
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a clean error message from a variety of provider error formats. */
function friendlyError(text: string): string {
  try {
    const data = JSON.parse(text) as {
      error?: { message?: string; type?: string };
      type?: string;
      message?: string;
      base_resp?: { status_msg?: string };
    };
    // MiniMax: { base_resp: { status_msg } }
    if (data.base_resp?.status_msg) return data.base_resp.status_msg;
    // MiniMax: { error: { message } }
    if (data.error?.message) return data.error.message;
    // OpenAI: { error: { message } }
    if ((data as { error?: { message?: string } }).error?.message) return (data as { error: { message: string } }).error.message;
    // Bare: { message }
    if (data.message) return data.message;
  } catch { /* not JSON */ }
  return text.slice(0, 300);
}

// ── Chapter analysis (text AI) ──────────────────────────────────────────
/** Analyze a chapter and decide whether to illustrate it + write the prompt.
 *  Uses the text-generation AI (cheap) to score visual richness. */
export async function analyzeChapterForIllustration(
  chapterTitle: string,
  chapterBody: string,
  novelContext: { title?: string; author?: string; language?: string },
): Promise<{ shouldIllustrate: boolean; prompt?: string; confidence: number; reason?: string }> {
  const truncated = chapterBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);

  const result = await chatJSON<{
    shouldIllustrate: boolean;
    confidence: number;
    reason?: string;
    prompt?: string;
  }>({
    messages: [
      { role: 'system', content: `Bạn là trợ lý phân tích văn bản văn học. Nhiệm vụ: đánh giá xem một chương truyện có đáng để minh họa (tạo ảnh) hay không.

Trả lời JSON với schema:
- shouldIllustrate: boolean — true nếu chương có cảnh đẹp, kịch tính, hoặc quan trọng
- confidence: number 0-1 — độ tự tin
- reason: string — giải thích ngắn (1 câu)
- prompt: string — nếu shouldIllustrate=true, viết prompt tiếng Anh mô tả cảnh (cho AI image gen). Tối đa 200 từ. Bao gồm:
  * Bối cảnh (địa điểm, thời gian, không khí)
  * Nhân vật chính trong cảnh (ngoại hình, tư thế, biểu cảm nếu rõ)
  * Hành động đang diễn ra
  * Phong cách nghệ thuật phù hợp (tu tiểu thuyết → epic fantasy, hiện đại → contemporary, etc.)
- KHÔNG bao gồm: text/watermark/border, màu sắc (sẽ thêm ở bước sau)` },
      { role: 'user', content: `Tiểu thuyết: ${novelContext.title ?? 'Không rõ'} (${novelContext.author ?? ''})
Ngôn ngữ: ${novelContext.language ?? 'vi'}
Chương: ${chapterTitle}

Nội dung (trích):
${truncated}

JSON:` },
    ],
    temperature: 0.3,
    max_tokens: 800,
    enable_thinking: false,
  });

  return {
    shouldIllustrate: !!result.shouldIllustrate,
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    reason: result.reason,
    prompt: result.prompt,
  };
}
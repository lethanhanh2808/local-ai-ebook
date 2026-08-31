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
//   bw-anime   : anime line art, black ink on white paper — DEFAULT for novels
//   bw-manga   : manga/manhua halftone + screentone — black-and-white only
//   bw-ink     : ink-wash (水墨画) line drawing — black-and-white only
//   bw-sketch  : pencil sketch, loose lines — black-and-white only
//   ink        : legacy ink-wash (now also B&W)
//   sketch     : legacy pencil sketch (now also B&W)
//   watercolor : soft washes, light (allowed grayscale / muted color)
//   manga      : legacy manga style
//   none       : provider default — no style guidance
//
// All "bw-" presets are GUARANTEED monochrome: prompt instructs the
// provider for "no color, no fills, white background", and the result is
// checked for grayscale content before being kept.

import { getEffectiveSettings } from '@/lib/db/settings';
import { chat, chatJSON } from './';

export type ImageStyle =
  | 'bw-anime'    // anime line art — DEFAULT
  | 'bw-manga'    // manga / manhua
  | 'bw-ink'      // ink-wash line drawing
  | 'bw-sketch'   // pencil sketch
  | 'ink'
  | 'sketch'
  | 'watercolor'
  | 'manga'
  | 'none';

export const DEFAULT_IMAGE_STYLE: ImageStyle = 'bw-anime';

/** True if this style is the B&W family — prompt will be locked to monochrome. */
export function isMonochromeStyle(s: ImageStyle | string | null | undefined): boolean {
  return !!s && s.startsWith('bw-');
}

/** Back-compat: legacy 'ink' / 'sketch' / 'manga' / 'watercolor' values get
 *  upgraded to the closest B&W equivalent so existing settings rows silently
 *  switch to the new visual identity. */
export function normalizeImageStyle(s: string | null | undefined): ImageStyle {
  if (!s) return DEFAULT_IMAGE_STYLE;
  if ((['bw-anime', 'bw-manga', 'bw-ink', 'bw-sketch', 'ink', 'sketch', 'watercolor', 'manga', 'none'] as const).includes(s as ImageStyle)) {
    return s as ImageStyle;
  }
  return DEFAULT_IMAGE_STYLE;
}

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
  // — Black-and-white family (preferred for novels — keeps the book visually
  //   cohesive and makes per-character image consistency possible since the
  //   image provider has fewer degrees of freedom in monochrome) —
  'bw-anime': 'Anime line-art (アニメ風インク画). Crisp clean confident black ink linework over white paper. Expressive eyes, dynamic hair, light hatching for shading. Strictly monochrome: NO color, NO fills, NO gradient washes. Pure white background. High contrast. Hand-drawn strokes.',
  'bw-manga':  'Manga / manhua ink-and-paper style. Clean confident line art, halftone / screentone shading, speed lines. Strictly black and white on pure white paper. No color, no fills, no gradients.',
  'bw-ink':    'Traditional East-Asian ink-wash line drawing (水墨画). Black ink on white paper. Soft brush strokes, controlled washes, dramatic composition. Strictly black and white — no color, no flat fills.',
  'bw-sketch': 'Pencil sketch. Loose confident graphite lines, crosshatching for shading, smudges for shadow. Pure white background. Strictly black and white — no color, no fills.',
  // — Legacy styles (now also rendered monochrome) —
  ink:         'Traditional East-Asian ink-wash painting (水墨画). Black ink on white paper. Soft brush strokes, dramatic composition. Black and white only.',
  sketch:      'Pencil sketch. Loose confident lines, crosshatching for shading. White background. Black and white only.',
  watercolor:  'Soft watercolor wash. Light greyscale palette (or muted, restrained color). Gentle gradients, no hard edges.',
  manga:       'Manga / manhua style. Clean line art, halftone shading. White background. Black and white only.',
  none:        'Black and white illustration. High contrast. White background.',
};

/** Suffix appended for B&W-family styles to lock the provider out of color. */
const MONOCHROME_LOCK = 'STRICT PALETTE: black ink, mid-greys, white. No colour, no flat fills, no gradient washes. Pure white background. Hand-inked strokes only.';

/** Build the full prompt with style + novel-context adaptation. */
function buildPrompt(opts: GenerateImageOptions, style: ImageStyle): string {
  const hint = STYLE_HINTS[style] ?? STYLE_HINTS[DEFAULT_IMAGE_STYLE];
  const monoSuffix = isMonochromeStyle(style) ? `\n\n${MONOCHROME_LOCK}` : '';
  return [
    opts.prompt.trim(),
    '',
    '── VISUAL STYLE ──',
    hint,
    '',
    'IMPORTANT: Black-and-white illustration. High contrast. White background. No text, no speech bubbles, no watermarks, no signatures, no borders, no frames.',
    monoSuffix,
  ].join('\n');
}
type Provider = 'none' | 'openai' | 'minimax' | 'custom';
interface ProviderCfg {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  allowInsecureTls: boolean;
}

async function pickProviderCfg(): Promise<ProviderCfg> {
  const s = await getEffectiveSettings();
  const provider = (s.imageProvider ?? 'none') as Provider;
  const model = s.imageModel || (provider === 'minimax' ? 'image-01' : 'dall-e-3');
  const apiKey = s.imageApiKey?.trim() || '';
  const allowInsecureTls = Boolean(s.imageAllowInsecureTls);
  switch (provider) {
    case 'none':
      throw new Error('Image generation is disabled (imageProvider=none). Configure it in /settings.');
    case 'openai':
      return {
        provider,
        baseUrl: s.imageBaseUrl?.trim() || 'https://api.openai.com/v1',
        apiKey,
        model,
        allowInsecureTls,
      };
    case 'minimax':
      // MiniMax image API endpoint: https://api.minimax.io/v1/image_generation
      return {
        provider,
        baseUrl: s.imageBaseUrl?.trim() || 'https://api.minimax.io/v1',
        apiKey,
        model,
        allowInsecureTls,
      };
    case 'custom':
      if (!s.imageBaseUrl) throw new Error('Custom image provider requires imageBaseUrl');
      return { provider, baseUrl: s.imageBaseUrl, apiKey, model, allowInsecureTls };
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
  const s = await getEffectiveSettings();
  // Allow callers to force a specific style; otherwise pick up the user's
  // saved preference (auto-normalised so legacy values map to the closest
  // B&W preset, and an empty string falls back to the bw-anime default).
  const style: ImageStyle = opts.style ?? normalizeImageStyle(s.imageStyle);
  const cfg = await pickProviderCfg();

  if (!cfg.apiKey) throw new Error(`Image provider "${cfg.provider}" requires an image API key. Set it in /settings.`);

  const prompt = buildPrompt(opts, style);

  if (cfg.provider === 'minimax') {
    return generateViaMiniMax({ prompt, model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, size: opts.size, seed: opts.seed, allowInsecureTls: cfg.allowInsecureTls });
  }
  // openai + custom both use the OpenAI-compatible /v1/images/generations shape
  return generateViaOpenAI({ prompt, model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, size: opts.size, allowInsecureTls: cfg.allowInsecureTls });
}

// ── MiniMax image generation (https://api.minimax.io/v1/image_generation) ──
async function generateViaMiniMax(args: {
  prompt: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  size?: ImageSize;
  seed?: number;
  allowInsecureTls?: boolean;
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
  }, args.allowInsecureTls);

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
  allowInsecureTls?: boolean;
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
  }, args.allowInsecureTls);

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
/** Temporarily disable TLS certificate validation (for private/self-signed
 *  gateways). Restores the previous value afterwards so other requests in
 *  the same process are unaffected. */
async function withInsecureTls<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, allowInsecureTls = false): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const doFetch = () => fetch(url, { ...init, signal: controller.signal });
    return allowInsecureTls ? await withInsecureTls(doFetch) : await doFetch();
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
/** Per-character visual anchor. If the LLM detector has inferred a
 *  physical appearance for a character, we pass it to the illustration
 *  analyzer so the same character wears the same robe / has the same
 *  hair in every chapter. Names are stripped before the prompt reaches
 *  the image generator (some providers refuse brand-name-adjacent
 *  character names; the visual description is the contract). */
export interface CastMember {
  name: string;
  visualDescription?: string | null;
}

/** Deterministic 32-bit positive integer seed for an illustration call.
 *  Used to anchor the image provider's noise pattern so the same
 *  character + same book + same chapter produces the same image across
 *  regenerations — MiniMax supports `seed` in its request body and we
 *  rely on it for visual consistency; OpenAI / custom endpoints ignore
 *  the field but the locked prompt wording still keeps the character
 *  recognisable.
 *
 *  Algorithm: djb2 on `${bookId}|${chapterIndex}|${name}`. Same input
 *  always yields the same number; different inputs spread across the
 *  positive 31-bit range. */
export function characterSeed(bookId: string, chapterIndex: number, name: string): number {
  const s = `${bookId}|${chapterIndex}|${name}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  // Force 31-bit positive integer (mask off sign bit). 0 is reserved by
  // some providers as "use random seed" so we bump to 1 if we land there.
  // Mask order matters: `(h | 0)` keeps only the low 32 bits as signed;
  // `& 0x7fffffff` then strips the sign bit so the result is always a
  // valid positive int that fits the spec that most image APIs publish.
  return ((h | 0) & 0x7fffffff) || 1;
}

/** Analyze a chapter and decide whether to illustrate it + write the prompt.
 *  Uses the text-generation AI (cheap) to score visual richness. */
export async function analyzeChapterForIllustration(
  chapterTitle: string,
  chapterBody: string,
  novelContext: { title?: string; author?: string; language?: string },
  /** Optional cast with visual anchors. Names are NEVER injected into
   *  the image prompt — only the visual description. */
  cast?: CastMember[],
): Promise<{ shouldIllustrate: boolean; prompt?: string; confidence: number; reason?: string }> {
  const truncated = chapterBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);

  // Build a cast anchor block. Only members with a real visual description
  // are included — LLM-saved "unspecified" sentinels and null fields are
  // silently dropped so the prompt stays focused on characters we can
  // actually depict consistently.
  const castLines = (cast ?? [])
    .filter((c) => c.visualDescription && c.visualDescription.trim() && c.visualDescription.trim().toLowerCase() !== 'unspecified')
    .map((c) => `* ${c.visualDescription!.trim()}`)
    .join('\n');
  // CRITICAL: when a character anchor is supplied, every physical trait in
  // it MUST appear in the scene prompt VERBATIM (or near-verbatim) — these
  // words are the contract with the image provider. Rewriting "long black
  // hair tied with a red ribbon" as "raven locks" breaks the per-character
  // consistency contract across regenerations and across chapters.
  const castBlock = castLines
    ? `\n\nCAST VISUAL ANCHORS (CANONICAL — keep character appearance IDENTICAL across chapters; do NOT paraphrase or substitute synonyms; copy the exact wording for hair, eyes, skin, clothing, accessories, distinguishing marks into the scene prompt so the image provider renders the same character the same way every time):\n${castLines}\n`
    : '';

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
  * Nhân vật chính trong cảnh — khi có CAST VISUAL ANCHORS bên dưới, hãy dùng NGUYÊN VĂN mô tả ngoại hình (tóc, mắt, da, quần áo, phụ kiện, đặc điểm nhận dạng) chứ KHÔNG diễn giải lại; đây là hợp đồng với image provider để nhân vật trông giống nhau giữa các chương
  * Tư thế, biểu cảm nếu rõ
  * Hành động đang diễn ra
  * Phong cách nghệ thuật phù hợp (tu tiểu thuyết → epic fantasy, hiện đại → contemporary, etc.)
- KHÔNG bao gồm: text/watermark/border, màu sắc (sẽ thêm ở bước sau), tên riêng nhân vật (chỉ dùng mô tả ngoại hình)` },
      { role: 'user', content: `Tiểu thuyết: ${novelContext.title ?? 'Không rõ'} (${novelContext.author ?? ''})
Ngôn ngữ: ${novelContext.language ?? 'vi'}
Chương: ${chapterTitle}
${castBlock}
Nội dung (trích):
${truncated}

JSON:` },
    ],
    temperature: 0.2,  // low — keeps the visual-description wording stable across runs
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
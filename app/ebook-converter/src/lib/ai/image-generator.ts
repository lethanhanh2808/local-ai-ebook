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
//   chibi      : super-deformed 2-3 head proportions, kawaii, colorful — DEFAULT
//   bw-anime   : anime line art, black ink on white paper
//   bw-manga   : manga/manhua halftone + screentone — black-and-white only
//   bw-ink     : ink-wash (水墨画) line drawing — black-and-white only
//   bw-sketch  : pencil sketch, loose lines — black-and-white only
//   ink        : legacy ink-wash (now also B&W)
//   sketch     : legacy pencil sketch (now also B&W)
//   watercolor : soft washes, light (allowed grayscale / muted color)
//   manga      : legacy manga style
//   none       : provider default — no style guidance
//
// All "bw-" presets rely on prompt-level instructions ("no color, no
// fills, white background") to lock the provider to monochrome. The
// generated image is NOT post-checked for grayscale content — it is
// rendered-as-monochrome by instruction. (Cover placement scoring
// in covers/image-analysis.ts inspects pixels for *placement*, not for
// color verification.)

import { getEffectiveSettings } from '@/lib/db/settings';
import { chat, chatJSON } from './';

export type ImageStyle =
  | 'chibi'      // super-deformed kawaii — DEFAULT for novels
  | 'bw-anime'   // anime line art — was default before chibi
  | 'bw-manga'   // manga / manhua
  | 'bw-ink'     // ink-wash line drawing
  | 'bw-sketch'  // pencil sketch
  | 'ink'
  | 'sketch'
  | 'watercolor'
  | 'manga'
  | 'none';

export const DEFAULT_IMAGE_STYLE: ImageStyle = 'chibi';

/** True if this style is the B&W family — prompt will be locked to monochrome. */
export function isMonochromeStyle(s: ImageStyle | string | null | undefined): boolean {
  return !!s && s.startsWith('bw-');
}

/** Back-compat: legacy 'ink' / 'sketch' / 'manga' / 'watercolor' values get
 *  upgraded to the closest B&W equivalent so existing settings rows silently
 *  switch to the new visual identity. */
export function normalizeImageStyle(s: string | null | undefined): ImageStyle {
  if (!s) return DEFAULT_IMAGE_STYLE;
  if ((['chibi', 'bw-anime', 'bw-manga', 'bw-ink', 'bw-sketch', 'ink', 'sketch', 'watercolor', 'manga', 'none'] as const).includes(s as ImageStyle)) {
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
  // — Chibi (default) — super-deformed kawaii, vibrant color, fun. Big head,
  //   tiny body (2-3 head proportions), huge expressive eyes, small limbs,
  //   playful poses. Used for novel chapter illustrations + covers. NOT
  //   monochrome — chibi reads as flat-color kawaii. The provider has more
  //   freedom in color so per-character consistency is harder, but the cute
  //   aesthetic is the deliberate payoff.
  'chibi': 'Chibi / super-deformed (SD) anime illustration. 2 to 3 head-to-body proportions: oversized head, tiny body, short stubby limbs, huge round expressive eyes taking ~1/3 of the face, simplified tiny nose and mouth. Cute kawaii aesthetic — adorable, playful, fun, lighthearted mood. Bright cheerful color palette (pastel + saturated accents). Clean confident line art, flat color fills with minimal cel-shading. Pure white or soft pastel gradient background. Expressive over realistic; mood over detail. Studio Ghibli kawaii chibi style blended with modern mobile-game character art (Genshin Impact chibi / Honkai chibi / Cookie Run style).',
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

/** Quick-and-dirty check that the imagePrompt is English-only. Shared
 *  between cover + chapter pipelines.
 *  - Hard-rejects on CJK / Greek / Cyrillic scripts (no English prompt
 *    should contain those).
 *  - Counts words containing accented Latin (Vietnamese, Polish, French,
 *    …) and falls back to the generic English template when those make
 *    up the majority of the prompt (i.e. the LLM emitted pure
 *    Vietnamese prose rather than English-with-a-character-name).
 *  - Accepts prompts with a small number of accented-Latin words so
 *    legitimate prose like "Vũ An Bang stands in the rain" still passes. */
export function isLikelyEnglishPrompt(s: string | null | undefined): boolean {
  if (!s) return false;
  if (s.length < 40) return false;
  // Hard reject on scripts that have no business in an English prompt:
  // Greek, Cyrillic, CJK ideographs, hiragana, katakana. The previous
  // version included Latin Extended-A (0x00C0-0x024F = Vietnamese
  // diacritics) which incorrectly rejected valid prompts whenever the
  // LLM included one character name beside English prose \u2014 "V\u0169 An Bang
  // stands in the rain" was being replaced by the generic fallback.
  if (/[\u0370-\u03FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(s)) {
    return false;
  }
  // Ratio guard: if a majority of words contain non-ASCII Latin letters
  // (Vietnamese, Polish, French, \u2026), the LLM emitted pure non-English
  // prose and we want the fallback. One Vietnamese name next to English
  // text stays well below this threshold.
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  let nonAsciiLatinWordCount = 0;
  for (const w of words) {
    let hasAccentedLatin = false;
    let hasOtherNonAscii = false;
    for (const ch of w) {
      const cp = ch.codePointAt(0) ?? 0;
      // Latin Extended-A (0x00C0-0x024F) holds most basic Latin diacritics,
      // Latin Extended Additional (0x1E00-0x1EFF) holds the Vietnamese
      // tone-mark letters (Ấ Ầ Ậ Ệ Ộ …). The earlier 0x00C0-0x024F-only
      // range silently classified those Vietnamese tones as "other script"
      // and a pure-Vietnamese paragraph slipped through as English.
      if ((cp >= 0x80 && cp <= 0x024F) || (cp >= 0x1E00 && cp <= 0x1EFF)) {
        hasAccentedLatin = true;
      } else if (cp > 0x7F) {
        hasOtherNonAscii = true;
      }
    }
    if (hasAccentedLatin && !hasOtherNonAscii) nonAsciiLatinWordCount++;
  }
  return nonAsciiLatinWordCount / words.length <= 0.5;
}

/** Generic English fallback when the LLM returns a Vietnamese / non-ASCII
 *  prompt (or no prompt at all). Generic enough to apply to ANY novel —
 *  per-genre fallbacks live in genre-detector.ts via composeFallbackPrompt()
 *  when the cover pipeline wants to be more specific. */
const GENERIC_ENGLISH_FALLBACK =
  'A dramatic illustration of the chapter scene. ' +
  'Expressive characters in a meaningful moment, atmospheric setting. ' +
  'No text, no speech bubbles, no watermarks, no borders.';

/** Max chars we send to MiniMax — its /v1/image_generation endpoint rejects
 *  prompts >1500 chars with status_code 2013 ("invalid params"). OpenAI
 *  DALL-E 3 caps at 4000 but we use one budget for both so a single image
 *  provider switch never silently fails. 1450 leaves headroom under 1500.
 *  Mirrors the cover pipeline's MAX_TOTAL (see ai-generate-cover.ts). */
const MAX_PROMPT_TOTAL = 1450;

/** Build the full prompt with style + novel-context adaptation.
 *  Hard-truncates to MAX_PROMPT_TOTAL so MiniMax doesn't 2013.
 *  Exported for tests / debug tooling; production callers should use
 *  generateImage() which wraps this with provider dispatch. */
export function buildPrompt(opts: GenerateImageOptions, style: ImageStyle): string {
  const hint = STYLE_HINTS[style] ?? STYLE_HINTS[DEFAULT_IMAGE_STYLE];
  const monoSuffix = isMonochromeStyle(style) ? `\n\n${MONOCHROME_LOCK}` : '';
  // Per-style generic safety footer. Chibi is intentionally NOT monochrome
  // (it's bright color kawaii), so it doesn't get the IMPORTANT: B&W line.
  const genericFooter = isMonochromeStyle(style)
    ? 'IMPORTANT: Black-and-white illustration. High contrast. White background. No text, no speech bubbles, no watermarks, no signatures, no borders, no frames.'
    : 'IMPORTANT: Illustration, NOT photorealistic. White or pastel gradient background. No text, no speech bubbles, no watermarks, no signatures, no borders, no frames. Single cohesive composition.';
  // First compose without truncation so we know the natural suffix size.
  const full = [
    opts.prompt.trim(),
    '',
    '── VISUAL STYLE ──',
    hint,
    '',
    genericFooter,
    monoSuffix,
  ].join('\n');
  if (full.length <= MAX_PROMPT_TOTAL) return full;
  // Trim the user-supplied scene prompt to fit. Cap it at the budget minus
  // the suffix length we just produced. Cut on a word boundary so the
  // truncated sentence reads naturally and don't end on a half-word.
  const budget = Math.max(200, MAX_PROMPT_TOTAL - (full.length - opts.prompt.trim().length));
  const trimmedScene = opts.prompt.trim().length > budget
    ? opts.prompt.trim().slice(0, budget).replace(/\s+\S*$/, '') + '…'
    : opts.prompt.trim();
  return [
    trimmedScene,
    '',
    '── VISUAL STYLE ──',
    hint,
    '',
    genericFooter,
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
 *  Uses the text-generation AI (cheap) to score visual richness.
 *
 *  Two-stage pattern (same shape as the cover pipeline):
 *    1. Deterministic genre/seed from title + author via the
 *       `genre-detector`. Gives us a per-book motif, shot,
 *       lighting, and palette. Free, fast, stable.
 *    2. The LLM only fills the freeform scene description on
 *       top of that seed. Result: chapter illustrations feel
 *       consistent with the cover and per-book, not generic. */
export async function analyzeChapterForIllustration(
  chapterTitle: string,
  chapterBody: string,
  novelContext: { title?: string; author?: string; language?: string; description?: string | null },
  /** Optional cast with visual anchors. Names are NEVER injected into
   *  the image prompt — only the visual description. */
  cast?: CastMember[],
): Promise<{ shouldIllustrate: boolean; prompt?: string; confidence: number; reason?: string }> {
  const truncated = chapterBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);

  // Stage 1 — deterministic art-direction seed. Imported lazily so
  // we don't pull the genre-detector keyword table into every
  // import that touches image-generator. Failure is non-fatal —
  // we fall through with an empty seed and the LLM still produces
  // something.
  let artBlock = '';
  try {
    const { detectGenre, toArtDirection } = await import('@/lib/covers/genre-detector');
    const detection = detectGenre({
      title: novelContext.title,
      titleVi: novelContext.title,
      description: novelContext.description,
    });
    const art = toArtDirection(detection, novelContext.title, novelContext.author);
    // Per-book anchors: motif / shot / lighting / palette. We pass them
    // as English-only structural hints (NOT to be parroted verbatim)
    // so the LLM writes a scene that aligns with this book's world
    // instead of generic anime/wuxia defaults.
    artBlock = `\n\nART DIRECTION (deterministic seed for THIS book — anchor your prompt on this, but write the scene yourself):
- Genre: ${art.en}
- Subject anchor: ${art.motif}
- Composition: ${art.picked.shot}
- Lighting / atmosphere: ${art.picked.lighting}
- Mood: ${art.mood}
- Palette: ${art.paletteDescription} (accent ${art.accent})`;
  } catch (err) {
    console.warn('[image-gen] genre seeding failed, using bare prompt:', err instanceof Error ? err.message : err);
  }

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

Quy tắc quyết định shouldIllustrate — CHỈ trả true khi chương chứa MỘT cảnh cụ thể, hữu hình mà độc giả sẽ nhớ. Các tiêu chí (cần ≥ 1):
  * Cảnh đối đầu / chiến đấu đầu tiên giữa hai nhân vật chính
  * Lần đầu gặp gỡ giữa hai nhân vật quan trọng (khoảnh khắc "thấy nhau")
  * Phá vỡ cảnh giới / đột phá tu luyện / thức tỉnh năng lực (tu tiên / hệ thống)
  * Biến cố lớn (phản bội, hy sinh, cứu người, mất người thân)
  * Phong cảnh / kiến trúc đặc trưng được miêu tả kỹ (cung điện, bí cảnh, thành phố xa lạ)
  * Kết thúc arc — khoảnh khắc quyết định trước khi chương kết thúc

Trả false khi chương chỉ chứa hội thoại, lộ trình di chuyển, nội tâm suy nghĩ, hay những cảnh không có yếu tố hình ảnh nổi bật. Ưu tiên chất lượng hơn số lượng — tốt hơn bỏ sót một cảnh dở còn hơn vẽ một cảnh nhạt.

Trả lời JSON với schema:
- shouldIllustrate: boolean — theo tiêu chí trên
- confidence: number 0-1 — độ tự tin. Trả 0.85+ chỉ khi chương có cảnh rõ ràng; trả 0.5-0.7 khi cảnh trung bình
- reason: string — giải thích ngắn gọn 1 câu bằng tiếng Việt, nêu cảnh cụ thể nào sẽ được minh họa (hoặc lý do bỏ qua)
- prompt: string — NẾU shouldIllustrate=true, viết prompt TIẾNG ANH (English-only — KHÔNG dấu tiếng Việt) mô tả cảnh, 100-180 từ, cho provider image AI. Bao gồm:
  * Bối cảnh (địa điểm, thời gian, không khí, ánh sáng)
  * Nhân vật chính — khi có CAST VISUAL ANCHORS, dùng NGUYÊN VĂN mô tả ngoại hình (tóc, mắt, da, quần áo, phụ kiện, đặc điểm nhận dạng), KHÔNG paraphrase hay thay synonym
  * Tư thế, biểu cảm, hành động đang diễn ra
  * Khi có ART DIRECTION bên dưới, hãy NEO cảnh theo motif + lighting + palette của thể loại (ví dụ: tu tiên dùng "jade palace, flowing clouds, immortal robes"; kinh dị dùng "deep shadow, oppressive silence"; đô thị dùng "neon cityscape, contemporary interior")
  * Phong cách nghệ thuật phù hợp thể loại
- KHÔNG bao gồm: text/watermark/border, tên riêng nhân vật (chỉ dùng mô tả ngoại hình), chữ trong ảnh` },
      { role: 'user', content: `Tiểu thuyết: ${novelContext.title ?? 'Không rõ'} (${novelContext.author ?? ''})
Ngôn ngữ: ${novelContext.language ?? 'vi'}
Chương: ${chapterTitle}
${castBlock}${artBlock}
Nội dung (trích):
${truncated}

JSON:` },
    ],
    temperature: 0.2,  // low — keeps the visual-description wording stable across runs
    // Bumped to 1200 from 800 — the new (stricter) system prompt asks for
    // 100-180-word English scene descriptions which can push the JSON
    // output past 800 tokens when the model also emits brief reasoning
    // bleed (we send enable_thinking=false but not all backends honour it).
    // 1200 still costs ~50% of a 2K generation budget; well bounded.
    max_tokens: 1200,
    enable_thinking: false,
  });

  // Sanitize the LLM's English prompt. The model is told to write in
  // English but occasionally returns Vietnamese / mixed text — and
  // MiniMax / OpenAI image generators reject non-Latin characters.
  // Fall back to a deterministic English scene description so the
  // chapter always gets a usable prompt.
  const rawPrompt = typeof result.prompt === 'string' ? result.prompt.trim() : '';
  const safePrompt = isLikelyEnglishPrompt(rawPrompt) ? rawPrompt : GENERIC_ENGLISH_FALLBACK;

  return {
    shouldIllustrate: !!result.shouldIllustrate,
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    reason: result.reason,
    prompt: safePrompt,
  };
}
// src/lib/covers/ai-generate-cover.ts
//
// AI-powered book cover generator.
//
// Pipeline:
//   1. Detect the book's Vietnamese-novel genre from title/description
//      via the deterministic `genre-detector` (covers most patterns:
//      tu tiểu thuyết, ngôn tình, cổ trang, đô thị, hệ thống, kinh dị,
//      sci-fi, thanh xuân). This gives us a strong, stable art-
//      direction seed (palette + motif + style).
//   2. Ask the text AI to design the scene using that seed (it owns
//      the freeform description; we own the structural decisions so
//      cover regeneration is stable). Falls back to a per-genre
//      English imagePrompt if the LLM fails — MiniMax/DALL-E require
//      English and we've seen Vietnamese leak through otherwise.
//   3. Generate a background illustration using the image provider
//      (MiniMax / OpenAI / custom).
//   4. Composite the AI art + title/author/series typography with sharp.
//      Result: a real illustrated book cover with elegant, clean text
//      overlay that always renders correctly regardless of font availability.
//
// If the image provider is disabled, the caller should fall back to
// generateBookCover() (pure SVG + sharp).

import sharp from 'sharp';
import { generateImage, isMonochromeStyle, type ImageStyle } from '@/lib/ai/image-generator';
import { chatJSON } from '@/lib/ai';
import { getEffectiveSettings } from '@/lib/db/settings';
import {
  detectGenre,
  toArtDirection,
  GENRE_SPECS,
  pickInitialPlacement,
  type VietnameseGenre,
} from './genre-detector';
import { pickTitlePlacement, type TitlePlacement } from './image-analysis';
import { buildTypography } from './typography';

// The static libvips inside @img/sharp-libvips-* has fontconfig built in but
// ships with no default config; SVG <text> rendering needs it pointed at a
// directory that has the fonts we use. The Dockerfile sets FONTCONFIG_FILE
// before `node` is invoked, but the standalone server.js spawned by Next
// inherits the build-time env only if explicit. This makes the env var
// available per-process without relying on container-level configuration.
if (!process.env.FONTCONFIG_FILE) {
  process.env.FONTCONFIG_FILE = '/app/fonts.conf';
}
if (!process.env.FONTCONFIG_PATH) {
  process.env.FONTCONFIG_PATH = '/app';
}

export interface AICoverOptions {
  title: string;
  author: string;
  language?: string;
  series?: string | null;
  seriesIndex?: number | null;
  description?: string | null;
  /**
   * Hint to the genre detector. Accepts free-text (e.g. "tu tiểu thuyết")
   * which we coerce to our Vietnamese enum, or one of the enum values
   * directly: tu_tieu_thuyet | ngon_tinh | lich_su | do_thi |
   * game_system | kinh_di | khoa_hoc_vien_tuong | thieu_nien.
   * If omitted, we infer from title + description.
   */
  genre?: string | null;
  /** Optional seed for the AI image — if omitted, a deterministic seed
   *  is derived from title|author so re-running cover AI for the same
   *  book produces the same image. Set to a number to override. */
  seed?: number;
}

interface CoverDesign {
  /** The image-generation prompt (English, no text). */
  imagePrompt: string;
  /** A short Vietnamese tagline / subtitle for the cover (optional). */
  tagline: string;
  /** Style hint: ink, watercolor, painting, etc. */
  style: 'ink' | 'watercolor' | 'painting' | 'cinematic' | 'sketch' | 'bw-anime' | 'bw-manga' | 'bw-ink' | 'bw-sketch';
  /** Accent color for the title (hex). */
  accent: string;
  /** Title text color (hex) — light or dark. */
  textColor: string;
  /** Whether the AI background is bright or dark. */
  background: 'dark' | 'light';
}

const DEFAULT_DESIGN: CoverDesign = {
  // Cover is intentionally in FULL COLOR (chapter illustrations stay
  // B&W — different purpose for each: cover is a stand-alone
  // marketing image; illustrations are for reading-flow). The default
  // imagePrompt is dramatic + cinematic; the SVG title typography is
  // overlaid on top in the user's language via Literata.
  imagePrompt: 'A beautiful cinematic book cover illustration, dramatic lighting, atmospheric, professional book cover composition, evocative of the story mood',
  tagline: '',
  style: 'cinematic',
  accent: '#c89b3c',
  textColor: '#ffffff',
  background: 'dark',
};

/** Stable 32-bit seed from title|author — same book → same cover when
 *  re-running without an explicit seed. Avoids surprises when the user
 *  regenerates without changing anything. The salt version is bumped
 *  whenever the prompt / palette / layout formula changes so cached
 *  cover images automatically refresh. */
function coverSeed(title: string, author: string): number {
  // Bump from `cover-v4-bottom-title-style` → `cover-v5-strong-backdrop-stack`
  // when the typography block gained the dedicated backdrop band,
  // stronger weights, and the accent-rule decoration.
  const s = `${title}|${author}|cover-v5-strong-backdrop-stack`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0) || 1;
}

/** Ask the text AI to design a cover (concept + colors + style).
 *  Note: chapter illustrations are B&W (consistency), but the cover stays
 *  in FULL COLOUR — it is a stand-alone marketing image with a different
 *  job. Don't force B&W here, even for novel genres.
 *
 *  Two-stage design:
 *   1. `detectGenre()` classifies the title/description into one of
 *      our Vietnamese-novel buckets (tu tiểu thuyết, ngôn tình, ...).
 *      This is deterministic, fast (no LLM call), and high-recall on
 *      Vietnamese web-novel titles. We use it to seed the LLM with
 *      a concrete art direction (motif + palette + style).
 *   2. The LLM only fills the *freeform* scene description (English
 *      imagePrompt + tagline + accent + textColor). Outputs are
 *      strict-typed; if the LLM returns garbage we fall back to the
 *      per-genre deterministic imagePrompt so the cover still ships.
 */
async function designCoverConcept(opts: AICoverOptions): Promise<CoverDesign> {
  const { title, author, language = 'vi', series, description, genre } = opts;
  const truncatedDesc = (description ?? '').slice(0, 600);

  // Step 1 — deterministic genre seed.
  const detection = detectGenre({
    title,
    titleVi: title,
    description,
    hint: genre,
  });
  // Pass title+author so toArtDirection() can pick per-book variants
  // (motif / shot / lighting / palette). Without these args, every book
  // in the same genre falls back to variant index 0 and produces a
  // near-identical cover. With them, two books in tu_tieu_thuyet get
  // different subjects / framings / lighting / colour tints while
  // still feeling like the same genre world.
  const art = toArtDirection(detection, title, author);

  // Step 2 — ask the LLM to write a freeform scene on top of that seed.
  // We pass a deliberately rich system prompt so the model doesn't have
  // to infer genre / palette / style — it just describes the SCENE.
  // This also keeps the output language stable (English imagePrompt).
  const systemPrompt = `You are a Vietnamese-novel cover art director. Generate the JSON cover concept for the book provided by the user.

Mandatory fields the JSON MUST include:
- imagePrompt (string, English only, 80-180 words) — concrete SCENE description for an image-generation model. NO text in the image. Phrase it as a single vivid paragraph covering: setting/architecture, the central subject, mood/lighting, artistic style (e.g. "cinematic photo", "digital painting", "ink wash with color accents", "oil painting"), and a colour palette. Use English-only words; do NOT include any Vietnamese characters in this field.
- tagline (string, Vietnamese, 2-6 words) — a short evocative subtitle. Empty string "" if not applicable.
- style (enum) — must be one of: ink | watercolor | painting | cinematic | sketch
- accent (string hex) — accent colour for the title. Suggested for this genre: ${art.accent}
- textColor (string hex) — title colour ("#ffffff" for dark backgrounds, "#1a1a2e" for light)
- background (enum "dark" | "light") — already known for this genre to be ${art.bgDark ? '"dark"' : '"light"'}; please use exactly that.

Hard rules:
- Cover is ALWAYS in FULL COLOUR — chapter illustrations inside the book are B&W but the cover is a stand-alone marketing image.
- imagePrompt MUST be English-only. MiniMax/DALL-E image generators reject prompts with non-Latin characters.
- DO NOT include any text, watermark, logo, signature, border, or scroll inside the image.
- DO NOT translate anything to English in any field other than imagePrompt.
- Keep the scene aligned with the genre's motif AND the book's title/author so the visual is recognisable.

Genre art direction for this book:
- Genre: ${art.vi} (${art.en})
- Suggested style: ${art.style}  ← use this unless you have a strong reason not to
- Subject anchor: ${art.motif}      ← THIS BOOK's picked motif (deterministic from title+author)
- Composition: ${art.picked.shot}
- Lighting / atmosphere: ${art.picked.lighting}
- Mood: ${art.mood}
- Palette: ${art.paletteDescription} (accent ${art.accent})
- Variety picks for this book: motif=${art.picked.motifIndex}, shot=${art.picked.shotIndex}, lighting=${art.picked.lightingIndex}, palette=${art.picked.paletteIndex} — these are fixed for THIS book, so your scene must align with them rather than default to the genre's generic first variant`;

  const userMessage = `Sách: "${title}" — ${author}
Ngôn ngữ: ${language}
${series ? `Series: ${series}${opts.seriesIndex ? ` #${opts.seriesIndex}` : ''}` : ''}
${truncatedDesc ? `Mô tả: ${truncatedDesc}` : ''}

JSON concept:`;

  let result: Partial<CoverDesign> = {};
  try {
    result = await chatJSON<Partial<CoverDesign>>({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
      temperature: 0.6,
      max_tokens: 600,
      enable_thinking: false,
      // Bounded — cover design is small (~600 tok output) and there's
      // no scenario where we'd want to wait more than ~45 s for it.
      // Without this cap, an LLM loop (echoing the system prompt back,
      // for example) can run for the full 10-minute default and the
      // user gets a hanging request.
      timeoutMs: 90_000,
    });
  } catch (err) {
    console.warn('[ai-cover] design step failed, using genre fallback:', err instanceof Error ? err.message : err);
  }

  // Sanitise the LLM output: pick the first non-empty valid imagePrompt.
  // The LLM occasionally emits Vietnamese here even though we forbade it;
  // in that case we substitute the per-genre English fallback.
  const llmPrompt = (result.imagePrompt ?? '').trim();
  const finalPrompt = isLikelyEnglishPrompt(llmPrompt)
    ? llmPrompt
    : art.fallbackImagePrompt;

  return {
    imagePrompt: finalPrompt || art.fallbackImagePrompt,
    tagline: (result.tagline ?? '').trim().slice(0, 80),
    // Honour the LLM's style only when it falls in our enum; otherwise
    // pin it to the art direction's recommendation so the cover stays
    // consistent across regenerations.
    style: isCoverStyleEnum(result.style) ? result.style! : art.style,
    accent: result.accent || art.accent,
    textColor: result.textColor || (art.bgDark ? '#ffffff' : '#1a1a2e'),
    background: result.background === 'light' || result.background === 'dark'
      ? result.background
      : (art.bgDark ? 'dark' : 'light'),
  };
}

/** Quick-and-dirty check that the imagePrompt is English-only — if it
 *  contains non-ASCII letters (Vietnamese diacritics, CJK, cyrillic, ...)
 *  we treat it as contaminated and use our per-genre fallback instead.
 *  This is intentionally lenient — accented Latin and basic punctuation
 *  are fine; what we want to ban is the AI emitting entire Vietnamese
 *  paragraphs or the title. */
function isLikelyEnglishPrompt(s: string): boolean {
  if (!s || s.length < 40) return false;
  // Allow common English punctuation/whitespace + Basic Latin letters only.
  // Reject anything where the Vietnamese diacritics range appears.
  return !/[\u00C0-\u024F\u0300-\u036F\u0370-\u03FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(s);
}

function isCoverStyleEnum(v: unknown): v is CoverDesign['style'] {
  return typeof v === 'string' && (GENRE_SPECS as any) && /^(ink|watercolor|painting|cinematic|sketch|bw-anime|bw-manga|bw-ink|bw-sketch)$/.test(v);
}

/** Map our cover-style enum to the image-generator's ImageStyle enum.
 *  Cover is in COLOUR — only explicit bw-* choices coerce monochrome. */
function coverStyleToImageStyle(s: CoverDesign['style']): ImageStyle {
  switch (s) {
    case 'bw-anime':   return 'bw-anime';
    case 'bw-manga':   return 'bw-manga';
    case 'bw-ink':     return 'bw-ink';
    case 'bw-sketch':  return 'bw-sketch';
    case 'watercolor': return 'watercolor';
    case 'painting':   return 'watercolor';
    case 'cinematic':  return 'none';   // provider default — full colour
    case 'ink':        return 'ink';
    case 'sketch':     return 'sketch';
  }
}

/** Compositional directive sent to the image AI so it leaves the
 *  region we'll place the title in free of subject detail. The
 *  exact wording per placement is in `compositionDirectiveFor()`. */
function compositionDirectiveFor(placement: TitlePlacement): string {
  switch (placement) {
    case 'h-bottom':
      return 'Leave the bottom 30% of the frame as soft negative space (sky, fog, gradient, plain background) — the title will overlay there. The main subject occupies the upper 70%.';
    case 'h-top':
      return 'Leave the top 25% of the frame as soft negative space (sky, fog, gradient, plain background) — the title will overlay there. The main subject occupies the lower 75%.';
    case 'v-left':
      return 'Leave the left 28% of the frame as soft negative space (gradient, fog, plain background, or out-of-focus elements) — the title will overlay there vertically. The main subject occupies the right 72%.';
    case 'v-right':
      return 'Leave the right 28% of the frame as soft negative space (gradient, fog, plain background, or out-of-focus elements) — the title will overlay there vertically. The main subject occupies the left 72%.';
  }
}

/** Generate the AI background image at 2:3 aspect (book cover ratio). */
async function generateBackgroundImage(
  design: CoverDesign,
  title: string,
  author: string,
  placement: TitlePlacement,
  genre: VietnameseGenre,
  seed?: number,
): Promise<Buffer> {
  const isMono = isMonochromeStyle(design.style);
  // MiniMax rejects prompts > 1500 chars with 2013 ("invalid params").
  // The LLM-written imagePrompt can run long, so we trim it to leave room
  // for the suffix (style + palette + mood + composition + no-text).
  // 1500 - ~580 chars of fixed suffix ⇒ ~870 char budget for imagePrompt.
  const MAX_TOTAL = 1450;            // leave headroom under the 1500 hard limit
  const SUFFIX_LEN_ESTIMATE = 580;   // measured: style + palette + mood + composition + no-text
  const imagePromptBudget = Math.max(200, MAX_TOTAL - SUFFIX_LEN_ESTIMATE);
  const trimmedImagePrompt = design.imagePrompt.trim().length > imagePromptBudget
    ? design.imagePrompt.trim().slice(0, imagePromptBudget).replace(/\s+\S*$/, '') + '…'
    : design.imagePrompt.trim();

  const compositionDirective = compositionDirectiveFor(placement);

  const promptLines = [
    trimmedImagePrompt,
    '',
    '── COMPOSITION ──',
    compositionDirective,
    '',
    '── VISUAL STYLE ──',
    `Style: ${design.style}. High production value, suitable for a professional book cover.`,
    `Palette: ${isMono
      ? 'STRICTLY monochrome. Black ink, mid-greys, white. No color, no fills, no gradients.'
      : (design.background === 'dark'
          ? 'FULL COLOR. Dark moody tonality, but subjects vividly colored with rich saturated skin tones, colorful costume/clothing, jewel-toned rim lighting. Poster-quality saturation.'
          : 'FULL COLOR. Light, airy, vibrant warm hues: colorful sky, lush foliage, bright costume colors. Poster-quality saturation.')
    }.`,
    `Mood: book titled "${title}" by "${author}" — genre "${genre}".`,
    '',
    'NO text, titles, watermarks, signatures, borders, frames, or readable scrolls. Pure illustration backdrop.',
  ];

  let prompt = promptLines.join('\n');
  // Belt-and-braces: if total still overshoots, hard truncate to MAX_TOTAL.
  if (prompt.length > MAX_TOTAL) prompt = prompt.slice(0, MAX_TOTAL);

  const result = await generateImage({
    prompt,
    size: '1024x1792',   // 2:3 portrait — book cover ratio
    style: coverStyleToImageStyle(design.style),
    seed,
  });

  if (result.b64) {
    return Buffer.from(result.b64, 'base64');
  }
  // Fallback: fetch the URL
  const res = await fetch(result.url);
  return Buffer.from(await res.arrayBuffer());
}

/** Build the final cover: AI background + sharp typography overlay.
 *  Output: PNG buffer at 800x1200 (good for both thumbnails and full-size).
 *
 *  Pipeline (smart placement — see image-analysis.ts):
 *    1. Resize AI background to cover dimensions.
 *    2. Re-score the AI image with pickTitlePlacement() to pick the
 *       emptiest band. May differ from the initial guess we sent to
 *       the image AI (the AI may not perfectly honour the directive).
 *    3. Delegate to typography.buildTypography() for the layered
 *       title + ornaments + backdrop.
 *    4. Composite AI art + SVG overlay.
 *
 *  Typography recipe is chosen by genre (see typography.ts). Layers
 *  used: heavy dark anchor stroke + gold-gradient fill + thin
 *  highlight stroke + glow filter + triple drop-shadow. The combined
 *  effect emulates the engraved/fantasy lettering of the reference
 *  covers in /exmple-books/example-covers using only Literata (the
 *  only font registered in the container).
 */
async function compositeCover(
  backgroundPng: Buffer,
  opts: AICoverOptions,
  design: CoverDesign,
  initialPlacement: TitlePlacement,
  genre: VietnameseGenre,
): Promise<Buffer> {
  const W = 800;
  const H = 1200;  // 2:3 ratio, classic book cover

  // Resize AI background to cover dimensions
  const bg = await sharp(backgroundPng)
    .resize(W, H, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();

  // Re-score the actual AI image — the initial placement was just a
  // hint to the image AI. If the AI ignored it, this falls back to
  // whichever band is genuinely emptiest.
  const scored = await pickTitlePlacement(bg);
  // Stick with the initial guess if the score difference is tiny
  // (preserves the "I told the AI to leave X empty" intent) —
  // otherwise trust the image content.
  const placement = scored.score < 0.4 ? initialPlacement : scored.placement;
  if (placement !== initialPlacement) {
    console.log(`[ai-cover] placement override: initial=${initialPlacement} → actual=${placement} (score=${scored.score.toFixed(2)})`);
  }

  // Delegate the SVG to the typography module.
  const typo = buildTypography(
    placement,
    {
      accent: design.accent,
      background: design.background,
      textColor: design.textColor,
      tagline: design.tagline,
      genre,
    },
    {
      title: opts.title,
      author: opts.author,
      series: opts.series ?? null,
      seriesIndex: opts.seriesIndex ?? null,
      language: opts.language,
    },
  );

  // Composite: AI background + overlay
  return sharp(bg)
    .composite([{ input: Buffer.from(typo.svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// ── Public API ──────────────────────────────────────────────────────────
export interface AIGenerateCoverResult {
  buffer: Buffer;
  width: number;
  height: number;
  design: CoverDesign;
  /** Source of the background: 'ai' for AI-generated, 'fallback' for sharp-only. */
  source: 'ai' | 'fallback';
  /** Time taken in ms. */
  durationMs: number;
  /** Seed used for the image call (so callers can pin / reroll). */
  seed?: number;
  /** Final placement chosen for the title overlay (after re-scoring). */
  placement?: TitlePlacement;
  /** Score 0..1 — higher = the AI art better matched the chosen band. */
  placementScore?: number;
  /** Detected genre (from genre-detector). */
  genre?: VietnameseGenre;
  /** Genre-detection confidence 0..1. */
  genreConfidence?: number;
}

/** Generate a beautiful AI-powered book cover. Falls back to sharp-only
 *  generation if image generation is disabled or the AI call fails. */
export async function generateAIBookCover(opts: AICoverOptions): Promise<AIGenerateCoverResult> {
  const t0 = Date.now();
  const s = await getEffectiveSettings();
  const W = 800, H = 1200;

  // If image generation is disabled, fall back to the original SVG/sharp generator
  if (s.imageProvider === 'none') {
    const { generateBookCover } = await import('./generate-cover');
    const buffer = await generateBookCover(opts);
    return { buffer, width: W, height: H, design: DEFAULT_DESIGN, source: 'fallback', durationMs: Date.now() - t0 };
  }

  // Always detect genre up front — both the design step and the
  // placement picker need it.
  const detection = detectGenre({
    title: opts.title,
    titleVi: opts.title,
    description: opts.description ?? null,
    hint: opts.genre ?? null,
  });
  const genre: VietnameseGenre = detection.genre;

  // Two things can fail independently:
  //   (a) the text-AI design call (chatJSON) — returns empty or 500
  //       when the user has the image-AI key set but not the text-AI key.
  //   (b) the image-AI call (generateImage) — when the user has no image
  //       key at all, or the provider errors out.
  //
  // The user can set just an image key and still want a "real" cover, so
  // we degrade the design step silently (use the genre's deterministic
  // art direction + fallback imagePrompt) instead of bailing to the
  // pure-SVG fallback. The SVG fallback now only kicks in if the
  // IMAGE call itself fails.
  let design: CoverDesign = DEFAULT_DESIGN;
  try {
    design = await designCoverConcept(opts);
  } catch (err) {
    console.warn('[ai-cover] design step failed, using genre fallback:', err instanceof Error ? err.message : err);
    // Same per-book variant picking as the success path — even the
    // fallback imagePrompt must vary by title+author so a failed LLM
    // design step still produces a cover unique to the book.
    const art = toArtDirection(detection, opts.title, opts.author);
    design = {
      ...DEFAULT_DESIGN,
      imagePrompt: art.fallbackImagePrompt,
      style: art.style,
      accent: art.accent,
      textColor: art.bgDark ? '#ffffff' : '#1a1a2e',
      background: art.bgDark ? 'dark' : 'light',
    };
  }

  // Pick a default placement BEFORE we ask the image AI to generate
  // art — this lets us tell it to leave the right region empty.
  const initialPlacement = pickInitialPlacement(opts.title, genre);

  try {
    // Deterministic per-book seed → identical cover when re-running
    // without changes. Caller may override via opts.seed (an explicit
    // "reroll" trigger if we add UI later).
    const seed = opts.seed ?? coverSeed(opts.title, opts.author);
    // 1. Generate AI background with compositional directive for placement.
    const bg = await generateBackgroundImage(design, opts.title, opts.author, initialPlacement, genre, seed);
    // 2. Composite typography — compositeCover re-scores and may override.
    const finalPng = await compositeCover(bg, opts, design, initialPlacement, genre);
    // Re-score so the result echoes the ACTUAL placement used (after the
    // compositeCover override), not just the initial hint.
    const actual = await pickTitlePlacement(
      await sharp(bg).resize(W, H, { fit: 'cover' }).png().toBuffer(),
    );
    return {
      buffer: finalPng, width: W, height: H, design,
      source: 'ai',
      durationMs: Date.now() - t0,
      seed,
      placement: actual.placement,
      placementScore: actual.score,
      genre,
      genreConfidence: detection.confidence,
    };
  } catch (err) {
    console.warn('[ai-cover] AI cover generation failed, falling back to SVG:', err);
    const { generateBookCover } = await import('./generate-cover');
    const buffer = await generateBookCover(opts);
    return { buffer, width: W, height: H, design, source: 'fallback', durationMs: Date.now() - t0 };
  }
}
// src/lib/covers/ai-generate-cover.ts
//
// AI-powered book cover generator.
//
// Pipeline:
//   1. Ask the text AI to design a visual concept for the book
//      (composition, palette, mood, key visual) — uses the existing
//      text-generation route (any provider).
//   2. Generate a beautiful background illustration using the image
//      provider (MiniMax image-01 / OpenAI DALL-E / etc.).
//   3. Composite the AI art + title/author/series typography with sharp.
//      Result: a real illustrated book cover with elegant, clean text
//      overlay that always renders correctly regardless of font availability.
//
// If the image provider is disabled, the caller should fall back to
// generateBookCover() (pure SVG + sharp).

import sharp from 'sharp';
import { generateImage, isMonochromeStyle, type ImageStyle } from '@/lib/ai/image-generator';
import { chatJSON } from '@/lib/ai';
import { getSettings } from '@/lib/db/settings';

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
  genre?: string; // optional hint e.g. "tu tiểu thuyết" / "ngôn tình"
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
  const s = `${title}|${author}|cover-v4-bottom-title-style`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0) || 1;
}

/** Ask the text AI to design a cover (concept + colors + style).
 *  Note: chapter illustrations are B&W (consistency), but the cover stays
 *  in FULL COLOUR — it is a stand-alone marketing image with a different
 *  job. Don't force B&W here, even for novel genres. */
async function designCoverConcept(opts: AICoverOptions): Promise<CoverDesign> {
  const { title, author, language = 'vi', series, description, genre } = opts;
  const truncatedDesc = (description ?? '').slice(0, 600);

  const result = await chatJSON<Partial<CoverDesign>>({
    messages: [
      { role: 'system', content: `Bạn là chuyên gia thiết kế bìa sách. Bạn sẽ được cho tên + tác giả + (tùy chọn) mô tả ngắn của cuốn sách, và phải tạo concept cho bìa.

Lưu ý: bìa sách phải CÓ MÀU (full colour) — chapter illustrations bên trong là B&W nhưng cover là ảnh marketing đứng riêng, không cần đồng nhất với ảnh minh họa.

Trả lời JSON với schema:
- imagePrompt: string (tiếng Anh, 50-150 từ) — mô tả cảnh sẽ vẽ làm nền bìa. KHÔNG có chữ trong prompt. Bao gồm:
  * Bối cảnh (phong cảnh, kiến trúc, không gian)
  * Mood/không khí (dramatic, peaceful, mysterious, epic, ...)
  * Phong cách nghệ thuật ("cinematic photo", "oil painting", "watercolor", "digital painting", "ink wash with color accents", ...)
  * Bảng màu phù hợp thể loại (warm autumn, cool blue, dark fantasy, ...)
  * Tránh text/watermark/logo
- tagline: string — phụ đề ngắn gọn cho bìa (1-6 từ, tiếng Việt, có thể để trống "")
- style: enum (mặc định "cinematic"):
  * ink: tu tiểu thuyết, kiếm hiệp, cổ trang (with subtle color)
  * watercolor: lãng mạn, nhẹ nhàng (color)
  * painting: văn học, chiêm nghiệm (oil painting, color)
  * cinematic: hiện đại, hành động, khoa học viễn tưởng (color photo)
  * sketch: truyện ngắn, tản văn (with light color)
- accent: string (hex color) — màu nhấn (gold, red, jade, ...)
- textColor: string (hex) — màu chữ tiêu đề ("#ffffff" cho nền tối, "#1a1a2e" cho nền sáng)
- background: enum ("dark" | "light") — nền tối hay sáng` },
      { role: 'user', content: `Sách: "${title}" — ${author}
Ngôn ngữ: ${language}
${series ? `Series: ${series}${opts.seriesIndex ? ` #${opts.seriesIndex}` : ''}` : ''}
${genre ? `Thể loại: ${genre}` : ''}
${truncatedDesc ? `Mô tả: ${truncatedDesc}` : ''}

JSON concept:` },
    ],
    temperature: 0.7,
    max_tokens: 800,
    enable_thinking: false,
  });

  return {
    imagePrompt: result.imagePrompt || DEFAULT_DESIGN.imagePrompt,
    tagline: result.tagline ?? '',
    style: (result.style as CoverDesign['style']) ?? DEFAULT_DESIGN.style,
    accent: result.accent || DEFAULT_DESIGN.accent,
    textColor: result.textColor || DEFAULT_DESIGN.textColor,
    background: (result.background as 'dark' | 'light') ?? DEFAULT_DESIGN.background,
  };
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

/** Typography recipe per `CoverDesign['style']` — picks a Literata weight
 *  + italic + spacing that visually coordinates with the AI's chosen
 *  illustration mood. The title sits in the bottom 25–30% of the cover
 *  and the type is the art-direction match for the genre.
 *
 *  We reference the weight-specific Literata TTF filenames directly
 *  (Literata-Bold.ttf, etc.) so fontconfig resolves them precisely.
 *  These TTFs are at /app/public/assets/fonts/ inside the container and
 *  /app/fonts.conf registers that directory.
 */
function coverTitleStyle(style: CoverDesign['style']): {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  letterSpacing: number;
  italic: boolean;
} {
  switch (style) {
    case 'painting':
      // Văn học / chiêm nghiệm — italic + medium weight, tight spacing
      return { fontFamily: 'Literata', fontWeight: 600, fontStyle: 'italic', letterSpacing: 1, italic: true };
    case 'watercolor':
      // Lãng mạn, nhẹ nhàng — light italic, generous letter-spacing
      return { fontFamily: 'Literata-Light', fontWeight: 300, fontStyle: 'italic', letterSpacing: 4, italic: true };
    case 'ink':
      // Tu tiểu thuyết / kiếm hiệp / cổ trang — extra-bold, ancient-seal
      // wide letter-spacing, no italic
      return { fontFamily: 'Literata-ExtraBold', fontWeight: 800, fontStyle: 'normal', letterSpacing: 6, italic: false };
    case 'sketch':
      // Truyện ngắn / tản văn — light, no italic, tight letter-spacing
      return { fontFamily: 'Literata-Light', fontWeight: 400, fontStyle: 'normal', letterSpacing: 0, italic: false };
    case 'bw-anime':
    case 'bw-manga':
    case 'bw-ink':
    case 'bw-sketch':
      // B&W novels — bold sans italic-vibe; relies on heavy drop-shadow
      return { fontFamily: 'Literata-Bold', fontWeight: 700, fontStyle: 'normal', letterSpacing: 2, italic: false };
    case 'cinematic':
    default:
      // Default: poster-grade bold serif, modern, balanced
      return { fontFamily: 'Literata-Bold', fontWeight: 700, fontStyle: 'normal', letterSpacing: 2, italic: false };
  }
}

/** Generate the AI background image at 2:3 aspect (book cover ratio). */
async function generateBackgroundImage(
  design: CoverDesign,
  title: string,
  author: string,
  seed?: number,
): Promise<Buffer> {
  const isMono = isMonochromeStyle(design.style);
  // MiniMax rejects prompts > 1500 chars with 2013 ("invalid params").
  // The LLM-written imagePrompt can run long, so we trim it to leave room
  // for the suffix (style / palette / mood / no-text directives).
  // 1500 - ~470 chars of fixed suffix ⇒ ~1030 char budget for imagePrompt.
  const MAX_TOTAL = 1450;            // leave headroom under the 1500 hard limit
  const SUFFIX_LEN_ESTIMATE = 480;   // measured: style + palette + mood + no-text
  const imagePromptBudget = Math.max(200, MAX_TOTAL - SUFFIX_LEN_ESTIMATE);
  const trimmedImagePrompt = design.imagePrompt.trim().length > imagePromptBudget
    ? design.imagePrompt.trim().slice(0, imagePromptBudget).replace(/\s+\S*$/, '') + '…'
    : design.imagePrompt.trim();

  const promptLines = [
    trimmedImagePrompt,
    '',
    '── VISUAL STYLE ──',
    `Style: ${design.style}. High production value, suitable for a professional book cover.`,
    `Palette: ${isMono
      ? 'STRICTLY monochrome. Black ink, mid-greys, white. No color, no fills, no gradients.'
      : (design.background === 'dark'
          ? 'FULL COLOR. Dark moody tonality, but subjects vividly colored with rich saturated skin tones, colorful costume/clothing, jewel-toned rim lighting. Poster-quality saturation.'
          : 'FULL COLOR. Light, airy, vibrant warm hues: colorful sky, lush foliage, bright costume colors. Poster-quality saturation.')
    }.`,
    `Mood: book titled "${title}" by "${author}".`,
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
 *  Output: PNG buffer at 800x1200 (good for both thumbnails and full-size). */
async function compositeCover(
  backgroundPng: Buffer,
  opts: AICoverOptions,
  design: CoverDesign,
): Promise<Buffer> {
  const W = 800;
  const H = 1200;  // 2:3 ratio, classic book cover

  // Resize AI background to cover dimensions
  const bg = await sharp(backgroundPng)
    .resize(W, H, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();

  // ── Typography layout ─────────────────────────────────────────────
  // Bottom 25-30% typography band. Subject (AI art) fills 0..titleStartY.
  // Width budget: 85% of W since there's no AI subject to the side of
  // the title anymore — a touch more horizontal room than the old
  // centre-positioned layout.
  const titleStyle = coverTitleStyle(design.style);
  const titleFontSize = pickTitleFontSize(opts.title);
  const maxCharsPerLine = Math.max(8, Math.floor((W * 0.85) / (titleFontSize * 0.55)));
  const titleLines = wrapText(opts.title, maxCharsPerLine);
  const titleLineHeight = titleFontSize * 1.18;
  const titleTotalHeight = titleLines.length * titleLineHeight;

  // Reserve room: tagline at H-60, language at H-25, accent divider at
  // authorY+authorHeight+20. Title starts at H*0.66 and grows down.
  const titleStartY = Math.round(H * 0.66);

  const authorFontSize = Math.max(28, Math.min(40, Math.floor(W * 0.05)));
  const authorLines = wrapText(opts.author, 30);
  const authorLineHeight = authorFontSize * 1.25;
  const authorY = titleStartY + titleTotalHeight + 32;

  // Tagline (very bottom)
  const taglineFontSize = 22;
  const taglineY = H - 60;

  // Series badge — pinned to top of the cover (above the AI subject).
  const seriesBadgeHeight = 38;
  const seriesBadgeWidth = opts.series
    ? Math.min(W - 80, Math.max(180, opts.series.length * 16 + 80))
    : 0;
  const seriesBadgeX = (W - seriesBadgeWidth) / 2;
  const seriesBadgeY = 60;

  // Build SVG overlay
  const titleEls = titleLines.map((line, i) => `
    <text x="${W / 2}" y="${titleStartY + i * titleLineHeight + titleFontSize * 0.8}"
      text-anchor="middle"
      font-family="${titleStyle.fontFamily}, 'Noto Serif', 'DejaVu Serif', Georgia, 'Times New Roman', serif"
      font-size="${titleFontSize}"
      font-weight="${titleStyle.fontWeight}"
      ${titleStyle.fontStyle === 'italic' ? 'font-style="italic"' : ''}
      fill="${design.textColor}"
      letter-spacing="${titleStyle.letterSpacing}"
      filter="url(#title-shadow)">
      ${escXml(line)}
    </text>`).join('');

  const authorEls = authorLines.map((line, i) => `
    <text x="${W / 2}" y="${authorY + i * authorLineHeight + authorFontSize * 0.7}"
      text-anchor="middle"
      font-family="Literata, 'Noto Serif', 'DejaVu Serif', Georgia, 'Times New Roman', serif"
      font-size="${authorFontSize}"
      font-weight="400"
      font-style="italic"
      fill="${design.textColor}"
      opacity="0.95"
      filter="url(#meta-shadow)">
      ${escXml(line)}
    </text>`).join('');

  const taglineEl = design.tagline ? `
    <text x="${W / 2}" y="${taglineY + taglineFontSize * 0.7}"
      text-anchor="middle"
      font-family="Literata-Light, 'Noto Serif', 'DejaVu Serif', Georgia, serif"
      font-size="${taglineFontSize}"
      font-weight="300"
      font-style="italic"
      fill="${design.textColor}"
      opacity="0.75"
      letter-spacing="3"
      filter="url(#meta-shadow)">
      ${escXml(design.tagline.toUpperCase())}
    </text>` : '';

  const isMono = isMonochromeStyle(design.style);
  const monoAccent = '#888888';
  const accent = isMono ? monoAccent : design.accent;

  const seriesBadge = opts.series ? `
    <rect x="${seriesBadgeX}" y="${seriesBadgeY}" width="${seriesBadgeWidth}" height="${seriesBadgeHeight}" rx="6"
      fill="${accent}" opacity="${isMono ? '0.10' : '0.18'}" stroke="${accent}" stroke-width="1.5"/>
    <text x="${W / 2}" y="${seriesBadgeY + seriesBadgeHeight / 2 + 5}"
      text-anchor="middle"
      font-family="'Literata', 'Noto Serif', 'DejaVu Serif', Georgia, serif"
      font-size="16"
      font-style="italic"
      fill="${accent}"
      letter-spacing="2">
      ${escXml((opts.series + (opts.seriesIndex ? ` · Tập ${opts.seriesIndex}` : '')).toUpperCase())}
    </text>` : '';

  // Top/bottom gradient overlays for text legibility.
  // (isMono + accent already declared above so they're in scope here.)
  const topFade = isMono ? 'rgba(0,0,0,0.0)' : (design.background === 'dark' ? 'rgba(0,0,0,0.0)' : 'rgba(0,0,0,0.0)');
  const bottomFade = isMono ? 'rgba(0,0,0,0.55)' : (design.background === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.35)');

  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${topFade}"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </linearGradient>
    <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0)"/>
      <stop offset="100%" stop-color="${bottomFade}"/>
    </linearGradient>
    <linearGradient id="centerVignette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.0)"/>
      <stop offset="40%" stop-color="rgba(0,0,0,0.15)"/>
      <stop offset="60%" stop-color="rgba(0,0,0,0.15)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.0)"/>
    </linearGradient>
    <!-- Real drop-shadow filters. librsvg (sharp's renderer) ignores
         the CSS text-shadow SVG attribute, so the old style="text-shadow:…"
         lines were silent no-ops. feDropShadow renders through. -->
    <filter id="title-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity="0.7"/>
      <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000" flood-opacity="0.5"/>
    </filter>
    <filter id="meta-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.6"/>
    </filter>
  </defs>

  <!-- Top fade for series badge area (no-op today, kept for future) -->
  <rect x="0" y="0" width="${W}" height="200" fill="url(#topFade)"/>
  <!-- Bottom fade — extended upward to cover the bottom typography band
       (title + author + tagline). H-360..H of fade gradient gives the
       bottom 30% a clean dark legibility cushion. -->
  <rect x="0" y="${H - 360}" width="${W}" height="360" fill="url(#bottomFade)"/>
  <!-- Center vignette — now underlays the new bottom title band
       (H*0.55..H*0.95) instead of the dead-centre y=200..H-400. -->
  <rect x="0" y="${Math.round(H * 0.55)}" width="${W}" height="${Math.round(H * 0.40)}" fill="url(#centerVignette)"/>

  <!-- Decorative book spine on left -->
  <rect x="0" y="0" width="6" height="${H}" fill="rgba(0,0,0,0.35)"/>
  <rect x="6" y="0" width="1" height="${H}" fill="rgba(255,255,255,0.08)"/>

  ${seriesBadge}

  <!-- Subtle top divider above the AI subject -->
  <line x1="60" y1="140" x2="${W - 60}" y2="140" stroke="${accent}" stroke-width="1" opacity="0.4"/>
  <line x1="60" y1="144" x2="${W - 60}" y2="144" stroke="rgba(255,255,255,0.08)" stroke-width="0.5"/>

  ${titleEls}

  <!-- Divider between title and author -->
  <line x1="${W / 2 - 50}" y1="${authorY - 16}" x2="${W / 2 + 50}" y2="${authorY - 16}" stroke="${accent}" stroke-width="1.5" opacity="0.7"/>

  ${authorEls}

  ${taglineEl}

  <!-- Bottom accent divider — mirror of the top divider; signals the
       lower boundary of the typography band -->
  <line x1="60" y1="${taglineY - 30}" x2="${W - 60}" y2="${taglineY - 30}" stroke="${accent}" stroke-width="1" opacity="0.4"/>
  <line x1="60" y1="${taglineY - 26}" x2="${W - 60}" y2="${taglineY - 26}" stroke="rgba(255,255,255,0.08)" stroke-width="0.5"/>

  <!-- Language tag bottom-right -->
  <text x="${W - 30}" y="${H - 25}" text-anchor="end"
    font-family="'Literata', 'Noto Sans', 'DejaVu Sans', monospace" font-size="11" fill="${design.textColor}" opacity="0.4" letter-spacing="2">
    ${(opts.language ?? 'vi').toUpperCase()}
  </text>
</svg>`;

  // Composite: AI background + overlay
  return sharp(bg)
    .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function pickTitleFontSize(title: string): number {
  // Sized so a 2-line wrap fits inside (W * 0.78) horizontal margin on a
  // 700-weight serif at ~0.55 em width/char. 12-char title → big; 30+
  // chars → small enough that 2 lines render within the safe area.
  if (title.length <= 12) return 88;
  if (title.length <= 18) return 70;
  if (title.length <= 26) return 56;
  if (title.length <= 36) return 46;
  return 40;
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = (line + ' ' + word).trim();
    if (candidate.length > maxCharsPerLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  // Break very long single words
  if (lines.length === 1 && lines[0].length > maxCharsPerLine) {
    const word = lines[0];
    lines.length = 0;
    for (let i = 0; i < word.length; i += maxCharsPerLine) {
      lines.push(word.slice(i, i + maxCharsPerLine));
    }
  }
  return lines;
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
}

/** Generate a beautiful AI-powered book cover. Falls back to sharp-only
 *  generation if image generation is disabled or the AI call fails. */
export async function generateAIBookCover(opts: AICoverOptions): Promise<AIGenerateCoverResult> {
  const t0 = Date.now();
  const s = await getSettings();
  const W = 800, H = 1200;

  // If image generation is disabled, fall back to the original SVG/sharp generator
  if (s.imageProvider === 'none') {
    const { generateBookCover } = await import('./generate-cover');
    const buffer = await generateBookCover(opts);
    return { buffer, width: W, height: H, design: DEFAULT_DESIGN, source: 'fallback', durationMs: Date.now() - t0 };
  }

  // Two things can fail independently:
  //   (a) the text-AI design call (chatJSON) — returns empty or 500
  //       when the user has the image-AI key set but not the text-AI key.
  //   (b) the image-AI call (generateImage) — when the user has no image
  //       key at all, or the provider errors out.
  //
  // The user can set just an image key and still want a "real" cover, so
  // we degrade the design step silently (use a sensible default) instead
  // of bailing to the pure-SVG fallback. The SVG fallback now only kicks
  // in if the IMAGE call itself fails.
  let design: CoverDesign = DEFAULT_DESIGN;
  try {
    design = await designCoverConcept(opts);
  } catch (err) {
    console.warn('[ai-cover] design step failed, using default design + image-AI:', err instanceof Error ? err.message : err);
  }

  try {
    // Deterministic per-book seed → identical cover when re-running
    // without changes. Caller may override via opts.seed (an explicit
    // "reroll" trigger if we add UI later).
    const seed = opts.seed ?? coverSeed(opts.title, opts.author);
    // 1. Generate AI background (works even with default design)
    const bg = await generateBackgroundImage(design, opts.title, opts.author, seed);
    // 2. Composite typography over the background
    const finalPng = await compositeCover(bg, opts, design);
    return { buffer: finalPng, width: W, height: H, design, source: 'ai', durationMs: Date.now() - t0, seed };
  } catch (err) {
    console.warn('[ai-cover] AI cover generation failed, falling back to SVG:', err);
    const { generateBookCover } = await import('./generate-cover');
    const buffer = await generateBookCover(opts);
    return { buffer, width: W, height: H, design, source: 'fallback', durationMs: Date.now() - t0 };
  }
}
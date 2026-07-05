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
import { generateImage } from '@/lib/ai/image-generator';
import { chatJSON } from '@/lib/ai';
import { getSettings } from '@/lib/db/settings';

export interface AICoverOptions {
  title: string;
  author: string;
  language?: string;
  series?: string | null;
  seriesIndex?: number | null;
  description?: string | null;
  genre?: string; // optional hint e.g. "tu tiểu thuyết" / "ngôn tình"
}

interface CoverDesign {
  /** The image-generation prompt (English, no text). */
  imagePrompt: string;
  /** A short Vietnamese tagline / subtitle for the cover (optional). */
  tagline: string;
  /** Style hint: ink, watercolor, painting, etc. */
  style: 'ink' | 'watercolor' | 'painting' | 'cinematic' | 'sketch';
  /** Accent color for the title (hex). */
  accent: string;
  /** Title text color (hex) — light or dark. */
  textColor: string;
  /** Whether the AI background is bright or dark. */
  background: 'dark' | 'light';
}

const DEFAULT_DESIGN: CoverDesign = {
  imagePrompt: 'A beautiful cinematic book cover illustration, dramatic lighting, atmospheric, no text, no watermark, professional book cover composition',
  tagline: '',
  style: 'cinematic',
  accent: '#c89b3c',
  textColor: '#ffffff',
  background: 'dark',
};

/** Ask the text AI to design a cover (concept + colors + style). */
async function designCoverConcept(opts: AICoverOptions): Promise<CoverDesign> {
  const { title, author, language = 'vi', series, description, genre } = opts;
  const truncatedDesc = (description ?? '').slice(0, 600);

  const result = await chatJSON<Partial<CoverDesign>>({
    messages: [
      { role: 'system', content: `Bạn là chuyên gia thiết kế bìa sách. Bạn sẽ được cho tên + tác giả + (tùy chọn) mô tả ngắn của cuốn sách, và phải tạo concept cho bìa.

Trả lời JSON với schema:
- imagePrompt: string (tiếng Anh, 50-150 từ) — mô tả cảnh sẽ vẽ làm nền bìa. KHÔNG có chữ trong prompt. Bao gồm:
  * Bối cảnh (phong cảnh, kiến trúc, không gian)
  * Mood/không khí (dramatic, peaceful, mysterious, epic, ...)
  * Phong cách nghệ thuật ("ink wash", "oil painting", "watercolor", "cinematic photo", ...)
  * Bảng màu (warm autumn, cool blue, dark fantasy, ...)
  * Tránh text/watermark/logo
- tagline: string — phụ đề ngắn gọn cho bìa (1-6 từ, tiếng Việt, có thể để trống "")
- style: enum ("ink" | "watercolor" | "painting" | "cinematic" | "sketch")
  * ink: tu tiểu thuyết, kiếm hiệp, cổ trang
  * watercolor: lãng mạn, nhẹ nhàng
  * painting: văn học, chiêm nghiệm
  * cinematic: hiện đại, hành động, khoa học viễn tưởng
  * sketch: truyện ngắn, tản văn
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

/** Generate the AI background image at 2:3 aspect (book cover ratio). */
async function generateBackgroundImage(design: CoverDesign, title: string, author: string): Promise<Buffer> {
  const prompt = [
    design.imagePrompt.trim(),
    '',
    '── VISUAL STYLE ──',
    `Style: ${design.style}. High production value, suitable for a professional book cover.`,
    `Color palette: ${design.background === 'dark' ? 'dark, moody, dramatic with bright accents' : 'soft, light, atmospheric with subtle textures'}.`,
    'Mood: captures the essence of a book titled "' + title + '" by "' + author + '".',
    '',
    'IMPORTANT: This is a professional book cover background. NO text, NO titles, NO watermarks, NO signatures, NO borders, NO frames, NO characters with readable text/scrolls. The image should be a pure illustration suitable as a backdrop. High resolution, detailed, atmospheric.',
  ].join('\n');

  const result = await generateImage({
    prompt,
    size: '1024x1792',   // 2:3 portrait — book cover ratio
    style: design.style === 'ink' ? 'ink'
         : design.style === 'watercolor' ? 'watercolor'
         : design.style === 'sketch' ? 'sketch'
         : design.style === 'painting' ? 'watercolor'
         : 'none',  // cinematic — provider default
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
  const titleFontSize = pickTitleFontSize(opts.title);
  const titleLines = wrapText(opts.title, Math.floor(W * 0.18 / titleFontSize * 14)); // ~14 chars/line
  const titleLineHeight = titleFontSize * 1.18;
  const titleTotalHeight = titleLines.length * titleLineHeight;
  const titleStartY = (H / 2) - (titleTotalHeight / 2) - 40;

  const authorFontSize = Math.max(28, Math.min(40, Math.floor(W * 0.05)));
  const authorLines = wrapText(opts.author, 30);
  const authorLineHeight = authorFontSize * 1.25;
  const authorY = titleStartY + titleTotalHeight + 80;

  // Tagline
  const taglineFontSize = 22;
  const taglineY = H - 130;

  // Series badge
  const seriesBadgeHeight = 38;
  const seriesBadgeWidth = opts.series
    ? Math.min(W - 80, Math.max(180, opts.series.length * 16 + 80))
    : 0;
  const seriesBadgeX = (W - seriesBadgeWidth) / 2;
  const seriesBadgeY = 80;

  // Build SVG overlay
  const titleEls = titleLines.map((line, i) => `
    <text x="${W / 2}" y="${titleStartY + i * titleLineHeight + titleFontSize * 0.8}"
      text-anchor="middle"
      font-family="Georgia, 'Times New Roman', 'Playfair Display', serif"
      font-size="${titleFontSize}"
      font-weight="700"
      fill="${design.textColor}"
      letter-spacing="1"
      style="text-shadow: 0 4px 12px rgba(0,0,0,0.8), 0 2px 4px rgba(0,0,0,0.6);">
      ${escXml(line)}
    </text>`).join('');

  const authorEls = authorLines.map((line, i) => `
    <text x="${W / 2}" y="${authorY + i * authorLineHeight + authorFontSize * 0.7}"
      text-anchor="middle"
      font-family="Georgia, 'Times New Roman', serif"
      font-size="${authorFontSize}"
      font-weight="400"
      font-style="italic"
      fill="${design.textColor}"
      opacity="0.95"
      style="text-shadow: 0 2px 8px rgba(0,0,0,0.7);">
      ${escXml(line)}
    </text>`).join('');

  const taglineEl = design.tagline ? `
    <text x="${W / 2}" y="${taglineY + taglineFontSize * 0.7}"
      text-anchor="middle"
      font-family="Georgia, serif"
      font-size="${taglineFontSize}"
      font-weight="300"
      font-style="italic"
      fill="${design.textColor}"
      opacity="0.7"
      letter-spacing="3"
      style="text-shadow: 0 1px 4px rgba(0,0,0,0.6);">
      ${escXml(design.tagline.toUpperCase())}
    </text>` : '';

  const seriesBadge = opts.series ? `
    <rect x="${seriesBadgeX}" y="${seriesBadgeY}" width="${seriesBadgeWidth}" height="${seriesBadgeHeight}" rx="6"
      fill="${design.accent}" opacity="0.18" stroke="${design.accent}" stroke-width="1.5"/>
    <text x="${W / 2}" y="${seriesBadgeY + seriesBadgeHeight / 2 + 5}"
      text-anchor="middle"
      font-family="Georgia, serif"
      font-size="16"
      font-style="italic"
      fill="${design.accent}"
      letter-spacing="2">
      ${escXml((opts.series + (opts.seriesIndex ? ` · Tập ${opts.seriesIndex}` : '')).toUpperCase())}
    </text>` : '';

  // Top/bottom gradient overlays for text legibility
  const topFade = design.background === 'dark' ? 'rgba(0,0,0,0.0)' : 'rgba(0,0,0,0.0)';
  const bottomFade = design.background === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.35)';

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
  </defs>

  <!-- Top fade for series badge area -->
  <rect x="0" y="0" width="${W}" height="200" fill="url(#topFade)"/>
  <!-- Bottom fade for author/series info -->
  <rect x="0" y="${H - 200}" width="${W}" height="200" fill="url(#bottomFade)"/>
  <!-- Center vignette for title -->
  <rect x="0" y="200" width="${W}" height="${H - 400}" fill="url(#centerVignette)"/>

  <!-- Decorative book spine on left -->
  <rect x="0" y="0" width="6" height="${H}" fill="rgba(0,0,0,0.35)"/>
  <rect x="6" y="0" width="1" height="${H}" fill="rgba(255,255,255,0.08)"/>

  ${seriesBadge}

  <!-- Subtle top divider -->
  <line x1="60" y1="160" x2="${W - 60}" y2="160" stroke="${design.accent}" stroke-width="1" opacity="0.5"/>
  <line x1="60" y1="164" x2="${W - 60}" y2="164" stroke="rgba(255,255,255,0.1)" stroke-width="0.5"/>

  ${titleEls}

  <!-- Divider between title and author -->
  <line x1="${W / 2 - 50}" y1="${authorY - 28}" x2="${W / 2 + 50}" y2="${authorY - 28}" stroke="${design.accent}" stroke-width="1.5" opacity="0.7"/>

  ${authorEls}

  ${taglineEl}

  <!-- Language tag bottom-right -->
  <text x="${W - 30}" y="${H - 25}" text-anchor="end"
    font-family="monospace" font-size="11" fill="${design.textColor}" opacity="0.4" letter-spacing="2">
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
  if (title.length <= 12) return 92;
  if (title.length <= 18) return 76;
  if (title.length <= 26) return 62;
  if (title.length <= 36) return 50;
  return 44;
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

  try {
    // 1. Design concept
    const design = await designCoverConcept(opts);
    // 2. Generate AI background
    const bg = await generateBackgroundImage(design, opts.title, opts.author);
    // 3. Composite
    const finalPng = await compositeCover(bg, opts, design);
    return { buffer: finalPng, width: W, height: H, design, source: 'ai', durationMs: Date.now() - t0 };
  } catch (err) {
    console.warn('[ai-cover] AI cover generation failed, falling back to SVG:', err);
    const { generateBookCover } = await import('./generate-cover');
    const buffer = await generateBookCover(opts);
    return { buffer, width: W, height: H, design: DEFAULT_DESIGN, source: 'fallback', durationMs: Date.now() - t0 };
  }
}
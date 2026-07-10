// src/lib/covers/generate-cover.ts
// Programmatic book cover generator (sharp + SVG)
// Creates Calibre-style covers: 550x800, gradient bg, title/author overlay
import sharp from 'sharp';

/** Deterministic color from a string */
function hashColor(str: string, offset = 0): [number, number, number] {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  h = (h + offset) >>> 0;
  const hue = (h % 360 + 360) % 360;
  // Convert HSL to RGB (saturation=55%, lightness=35%)
  const s = 0.55, l = 0.35;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; }
  else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgb(c: [number, number, number]) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function hex(c: [number, number, number]) {
  return `#${c[0].toString(16).padStart(2, '0')}${c[1].toString(16).padStart(2, '0')}${c[2].toString(16).padStart(2, '0')}`;
}

/** Split text into lines that fit within maxChars */
function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line.trim());
  return lines;
}

export async function generateBookCover(opts: {
  title: string;
  author: string;
  language?: string;
  series?: string | null;
  seriesIndex?: number | null;
}): Promise<Buffer> {
  const { title, author, language = 'vi', series, seriesIndex } = opts;
  const W = 550, H = 800;

  const c1 = hashColor(title + author, 0);
  const c2 = hashColor(title + author, 60);
  const c3 = hashColor(title + author, 120);
  const accent = hashColor(author + title, 30);

  // Title wrap — bottom 25-30% typography band (matches AI cover layout).
  // The decorative circles fill the middle as the "main subject" and the
  // title overlays the lower third. Same anchor as ai-generate-cover.ts:
  // titleStartY = round(H * 0.66).
  const titleLines = wrapText(title, title.length > 20 ? 18 : 22);
  const titleFontSize = titleLines.length > 3 ? 36 : titleLines.length > 2 ? 42 : 48;
  const titleLineHeight = titleFontSize * 1.2;
  const titleY = Math.round(H * 0.66);

  // Series badge
  const seriesBadge = series
    ? `<rect x="40" y="80" width="${Math.min(series.length * 10 + 40, 470)}" height="32" rx="6" fill="${hex(accent)}33" stroke="${hex(accent)}66" stroke-width="1"/>
       <text x="56" y="101" font-family="Georgia,serif" font-size="15" fill="${hex(accent)}" font-style="italic">
         ${escXml(series)}${seriesIndex ? ` #${seriesIndex}` : ''}
       </text>`
    : '';

  // Build title text elements
  const titleEls = titleLines.map((line, i) => `
    <text x="275" y="${titleY + i * titleLineHeight}"
      font-family="Georgia,'Times New Roman',serif"
      font-size="${titleFontSize}"
      font-weight="bold"
      fill="white"
      text-anchor="middle"
      letter-spacing="0.5"
      filter="url(#shadow)"
    >${escXml(line)}</text>`).join('');

  // Author text
  const authorY = titleY + titleLines.length * titleLineHeight + 30;
  const authorLines = wrapText(author, 28);
  const authorEls = authorLines.map((line, i) => `
    <text x="275" y="${authorY + i * 26}"
      font-family="Georgia,'Times New Roman',serif"
      font-size="22"
      fill="rgba(255,255,255,0.85)"
      text-anchor="middle"
      font-style="italic"
    >${escXml(line)}</text>`).join('');

  // Language tag
  const langTag = language !== 'en'
    ? `<text x="510" y="${H - 25}" font-family="monospace" font-size="11" fill="rgba(255,255,255,0.4)" text-anchor="end">${language.toUpperCase()}</text>`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%" stop-color="${hex(c1)}"/>
      <stop offset="60%" stop-color="${hex(c2)}"/>
      <stop offset="100%" stop-color="${hex(c3)}"/>
    </linearGradient>
    <linearGradient id="overlay" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.1)"/>
      <stop offset="50%" stop-color="rgba(0,0,0,0.4)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.65)"/>
    </linearGradient>
    <filter id="shadow">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgba(0,0,0,0.6)"/>
    </filter>
    <filter id="blur">
      <feGaussianBlur stdDeviation="40"/>
    </filter>
  </defs>

  <!-- Background gradient -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- Decorative circles -->
  <circle cx="${W * 0.8}" cy="${H * 0.2}" r="200" fill="${hex(c1)}" opacity="0.3" filter="url(#blur)"/>
  <circle cx="${W * 0.1}" cy="${H * 0.7}" r="160" fill="${hex(c3)}" opacity="0.25" filter="url(#blur)"/>
  <circle cx="${W * 0.6}" cy="${H * 0.55}" r="120" fill="${hex(accent)}" opacity="0.15" filter="url(#blur)"/>

  <!-- Dark overlay for readability -->
  <rect width="${W}" height="${H}" fill="url(#overlay)"/>

  <!-- Bottom typography legibility cushion — extended upward from
       H-200..H to H-300..H so the title block at H*0.66 sits inside the
       darkened band. (matches ai-generate-cover.ts bottomFade) -->
  <defs>
    <linearGradient id="bottomCushion" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.55)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${H - 300}" width="${W}" height="300" fill="url(#bottomCushion)"/>

  <!-- Top decorative line -->
  <line x1="40" y1="140" x2="${W - 40}" y2="140" stroke="${hex(accent)}" stroke-width="2" opacity="0.6"/>
  <line x1="40" y1="144" x2="${W - 40}" y2="144" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>

  <!-- Bottom decorative line -->
  <line x1="40" y1="${H - 100}" x2="${W - 40}" y2="${H - 100}" stroke="${hex(accent)}" stroke-width="2" opacity="0.6"/>
  <line x1="40" y1="${H - 96}" x2="${W - 40}" y2="${H - 96}" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>

  <!-- Corner dots -->
  <circle cx="40" cy="140" r="4" fill="${hex(accent)}" opacity="0.8"/>
  <circle cx="${W - 40}" cy="140" r="4" fill="${hex(accent)}" opacity="0.8"/>
  <circle cx="40" cy="${H - 100}" r="4" fill="${hex(accent)}" opacity="0.8"/>
  <circle cx="${W - 40}" cy="${H - 100}" r="4" fill="${hex(accent)}" opacity="0.8"/>

  <!-- Series badge -->
  ${seriesBadge}

  <!-- Title -->
  ${titleEls}

  <!-- Divider after title -->
  <line x1="${W / 2 - 40}" y1="${authorY - 14}" x2="${W / 2 + 40}" y2="${authorY - 14}" stroke="${hex(accent)}" stroke-width="1.5" opacity="0.7"/>

  <!-- Author -->
  ${authorEls}

  <!-- Language -->
  ${langTag}

  <!-- Subtle book spine effect on left -->
  <rect x="0" y="0" width="8" height="${H}" fill="rgba(0,0,0,0.25)"/>
  <rect x="8" y="0" width="1" height="${H}" fill="rgba(255,255,255,0.08)"/>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// src/lib/covers/typography.ts
//
// SVG typography builder for the AI book-cover pipeline.
//
// Replaces the inline SVG construction that used to live in
// compositeCover() at ai-generate-cover.ts:386-559. Responsibilities:
//
//   1. Compute the title block geometry for the chosen placement
//      (h-bottom | h-top | v-left | v-right).
//   2. Emit a layered title: dark anchor stroke + gold-gradient fill
//      + thin highlight stroke + drop-shadow filter — fakes the
//      calligraphic / engraved look from the reference covers in
//      /exmple-books/example-covers using only Literata (the only
//      font available in the container).
//   3. Emit author + tagline + series badge sized to the layout.
//   4. Emit the backdrop gradient (oriented per placement) so the
//      title always reads against the AI art.
//   5. Emit per-genre decorative ornaments — corner brackets, frame,
//      rules, diamond — drawn from SVG primitives so librsvg renders
//      them reliably.
//
// All exported symbols are pure functions; no I/O, no sharp calls.
// The caller (compositeCover) wraps the result in sharp().composite().

import type { TitlePlacement } from './image-analysis';

// ── Inputs from the existing pipeline ─────────────────────────────────────

export interface TypographyDesign {
  /** Per-genre art direction; we use the accent color + bgDark flag. */
  accent: string;
  /** 'dark' → AI art is dark/moody; 'light' → AI art is light/airy. */
  background: 'dark' | 'light';
  /** Title text color hint from the LLM (often white for dark art). */
  textColor: string;
  /** Optional Vietnamese subtitle for the cover bottom (current). */
  tagline: string;
  /** Genre enum used to pick the per-genre typography recipe. */
  genre: import('./genre-detector').VietnameseGenre;
}

export interface TypographyOpts {
  title: string;
  author: string;
  series?: string | null;
  seriesIndex?: number | null;
  language?: string;
}

export interface TypographyResult {
  /** Complete SVG fragment to overlay on the cover PNG. */
  svg: string;
  /** Width / height of the SVG (always the cover's W x H). */
  width: number;
  height: number;
  /** For logging: which recipe + which ornament set was used. */
  diag: {
    placement: TitlePlacement;
    recipe: string;
    ornament: string;
    /** Post-reflow title font size (may be smaller than the layout default
     *  if the title was shrunk to avoid overlapping the author). */
    titleFontSize: number;
    /** Number of wrapped lines after reflow. */
    titleLines: number;
  };
}

// ── Cover geometry (matches ai-generate-cover.ts) ──────────────────────────

const W = 800;
const H = 1200;

// ── Per-genre typography recipe ────────────────────────────────────────────

type OrnamentKind = 'minimal' | 'rules' | 'frame' | 'flourish';

interface GenreRecipe {
  fontWeight: 400 | 600 | 700 | 800 | 900;
  italic: boolean;
  letterSpacing: number;
  /** Gold / silver / genre-accent gradient name (resolved below). */
  fill: 'gold' | 'silver' | 'cyan' | 'crimson' | 'white' | 'genre';
  /** Stroke color for the dark anchor layer. */
  stroke: string;
  /** Stroke width (px) for the dark anchor layer. */
  strokeWidth: number;
  /** Per-char jitter (±deg) for hand-drawn feel. 0 = no jitter. */
  charJitter: number;
  /** Soft glow under the title. null = no glow. */
  glow: { color: string; size: number } | null;
  /** Decorative ornament set around the title block. */
  ornament: OrnamentKind;
}

const RECIPES: Record<string, GenreRecipe> = {
  tu_tieu_thuyet: {
    fontWeight: 900, italic: false, letterSpacing: 8,
    fill: 'gold', stroke: '#0a0a0a', strokeWidth: 3,
    charJitter: 0,
    glow: { color: '#ffd76a', size: 8 },
    ornament: 'flourish',
  },
  lich_su: {
    fontWeight: 800, italic: false, letterSpacing: 4,
    fill: 'gold', stroke: '#0a0a0a', strokeWidth: 3,
    charJitter: 0,
    glow: null,
    ornament: 'frame',
  },
  ngon_tinh: {
    fontWeight: 600, italic: true, letterSpacing: 3,
    fill: 'white', stroke: '#0a0a0a', strokeWidth: 1.5,
    charJitter: 0,
    glow: { color: '#ffd9b3', size: 12 },
    ornament: 'frame',
  },
  do_thi: {
    fontWeight: 800, italic: false, letterSpacing: 2,
    fill: 'white', stroke: '#0a0a0a', strokeWidth: 2,
    charJitter: 0,
    glow: { color: '#7dd3fc', size: 6 },
    ornament: 'minimal',
  },
  game_system: {
    fontWeight: 800, italic: false, letterSpacing: 4,
    fill: 'cyan', stroke: '#0a0a0a', strokeWidth: 3,
    charJitter: 0,
    glow: { color: '#c4b5fd', size: 10 },
    ornament: 'rules',
  },
  kinh_di: {
    fontWeight: 600, italic: false, letterSpacing: 6,
    fill: 'crimson', stroke: '#0a0a0a', strokeWidth: 4,
    charJitter: 2,
    glow: { color: '#ef4444', size: 6 },
    ornament: 'minimal',
  },
  khoa_hoc_vien_tuong: {
    fontWeight: 800, italic: false, letterSpacing: 4,
    fill: 'cyan', stroke: '#0a0a0a', strokeWidth: 2,
    charJitter: 0,
    glow: { color: '#67e8f9', size: 8 },
    ornament: 'rules',
  },
  thieu_nien: {
    fontWeight: 600, italic: true, letterSpacing: 2,
    fill: 'white', stroke: '#0a0a0a', strokeWidth: 1.5,
    charJitter: 0,
    glow: { color: '#f9a8d4', size: 10 },
    ornament: 'frame',
  },
  unknown: {
    fontWeight: 800, italic: false, letterSpacing: 3,
    fill: 'gold', stroke: '#0a0a0a', strokeWidth: 2.5,
    charJitter: 0,
    glow: null,
    ornament: 'minimal',
  },
};

// ── Layout per placement ──────────────────────────────────────────────────

interface TitleLayout {
  /** Where the typography block starts (px, top-left). */
  blockX: number;
  blockY: number;
  /** Width / height of the typography block. */
  blockW: number;
  blockH: number;
  /** Horizontal title width budget. */
  titleMaxW: number;
  /** Title font size for the longest fitting line. */
  titleFontSize: number;
  /** Title text-anchor: 'middle' | 'start' | 'end'. */
  textAnchor: 'middle' | 'start' | 'end';
  /** Anchor x for the title (depends on placement + text-anchor). */
  titleX: number;
  /** Backdrop gradient orientation. */
  backdropRect: { x: number; y: number; w: number; h: number };
  /** Per-placement backdrop gradient endpoints (0..1 relative). */
  gradientEndpoints: { x1: number; y1: number; x2: number; y2: number };
  /** Line-height multiplier for stacked title lines. Vertical placements
   *  (narrow columns → more wrapped lines) need more breathing room than
   *  horizontal placements (wide band, fewer lines). */
  lineHeightMultiplier: number;
}

function pickTitleFontSize(title: string, maxWidthPx: number): number {
  // Heuristic: at 800-weight serif, ~0.55 em width/char.
  const target = maxWidthPx / 0.55;
  const targetByLen = title.length <= 12 ? 108
    : title.length <= 18 ? 84
    : title.length <= 26 ? 68
    : title.length <= 36 ? 56
    : 52;
  return Math.min(targetByLen, target);
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
  if (lines.length === 1 && lines[0].length > maxCharsPerLine) {
    const word = lines[0];
    lines.length = 0;
    for (let i = 0; i < word.length; i += maxCharsPerLine) {
      lines.push(word.slice(i, i + maxCharsPerLine));
    }
  }
  return lines;
}

function layoutFor(placement: TitlePlacement, title: string): TitleLayout {
  switch (placement) {
    case 'h-bottom': {
      // Title block: bottom 35% of the cover, full width minus margins.
      const blockX = 0;
      const blockY = Math.round(H * 0.60);
      const blockW = W;
      const blockH = Math.round(H * 0.40);
      const titleMaxW = W * 0.86;
      const titleFontSize = pickTitleFontSize(title, titleMaxW);
      return {
        blockX, blockY, blockW, blockH,
        titleMaxW, titleFontSize,
        textAnchor: 'middle', titleX: W / 2,
        backdropRect: { x: 0, y: Math.round(H * 0.55), w: W, h: Math.round(H * 0.45) },
        gradientEndpoints: { x1: 0, y1: 0, x2: 0, y2: 1 },
        // Horizontal layouts stay tight — the band is wide, fewer lines,
        // and big tight blocks read as poster-bold rather than airy.
        lineHeightMultiplier: 1.08,
      };
    }
    case 'h-top': {
      const blockX = 0;
      const blockY = 0;
      const blockW = W;
      const blockH = Math.round(H * 0.30);
      const titleMaxW = W * 0.86;
      const titleFontSize = pickTitleFontSize(title, titleMaxW);
      return {
        blockX, blockY, blockW, blockH,
        titleMaxW, titleFontSize,
        textAnchor: 'middle', titleX: W / 2,
        backdropRect: { x: 0, y: 0, w: W, h: Math.round(H * 0.30) },
        gradientEndpoints: { x1: 0, y1: 1, x2: 0, y2: 0 },
        lineHeightMultiplier: 1.08,
      };
    }
    case 'v-left': {
      // Title in a 30% column on the left, vertically centered.
      const blockW = Math.round(W * 0.32);
      const blockH = Math.round(H * 0.70);
      const blockX = 0;
      const blockY = Math.round((H - blockH) / 2);
      const titleMaxW = blockW * 0.78;
      const titleFontSize = pickTitleFontSize(title, titleMaxW);
      return {
        blockX, blockY, blockW, blockH,
        titleMaxW, titleFontSize,
        textAnchor: 'start', titleX: blockX + (blockW - titleMaxW) / 2,
        backdropRect: { x: 0, y: blockY, w: blockW, h: blockH },
        gradientEndpoints: { x1: 1, y1: 0, x2: 0, y2: 0 },
        // Vertical columns wrap to many short lines — wider row spacing
        // reads as engraved-stone rather than cramped. 1.45 = ~45% extra
        // breathing room between glyph rows.
        lineHeightMultiplier: 1.45,
      };
    }
    case 'v-right': {
      const blockW = Math.round(W * 0.32);
      const blockH = Math.round(H * 0.70);
      const blockX = W - blockW;
      const blockY = Math.round((H - blockH) / 2);
      const titleMaxW = blockW * 0.78;
      const titleFontSize = pickTitleFontSize(title, titleMaxW);
      return {
        blockX, blockY, blockW, blockH,
        titleMaxW, titleFontSize,
        textAnchor: 'end', titleX: blockX + blockW - (blockW - titleMaxW) / 2,
        backdropRect: { x: blockX, y: blockY, w: blockW, h: blockH },
        gradientEndpoints: { x1: 0, y1: 0, x2: 1, y2: 0 },
        lineHeightMultiplier: 1.45,
      };
    }
  }
}

// ── Gradient + filter defs ────────────────────────────────────────────────

function gradientFor(fill: GenreRecipe['fill'], accent: string): string {
  // Returns the gradient id used by the title text fill.
  switch (fill) {
    case 'gold':     return 'url(#gold-gradient)';
    case 'silver':   return 'url(#silver-gradient)';
    case 'cyan':     return 'url(#cyan-gradient)';
    case 'crimson':  return 'url(#crimson-gradient)';
    case 'white':    return '#ffffff';
    case 'genre':    return accent;
  }
}

function gradientDefBlock(accent: string, recipe: GenreRecipe): string {
  const defs: string[] = [];

  // Title body gradient — varies per fill kind.
  if (recipe.fill === 'gold') {
    defs.push(`
    <linearGradient id="gold-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#fff3c4"/>
      <stop offset="35%"  stop-color="#ffd76a"/>
      <stop offset="65%"  stop-color="#c89b3c"/>
      <stop offset="100%" stop-color="#7a5a1f"/>
    </linearGradient>`);
    defs.push(`
    <linearGradient id="gold-highlight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>`);
  } else if (recipe.fill === 'silver') {
    defs.push(`
    <linearGradient id="silver-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#ffffff"/>
      <stop offset="50%"  stop-color="#cbd5e1"/>
      <stop offset="100%" stop-color="#475569"/>
    </linearGradient>`);
  } else if (recipe.fill === 'cyan') {
    defs.push(`
    <linearGradient id="cyan-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#e0f7ff"/>
      <stop offset="40%"  stop-color="#67e8f9"/>
      <stop offset="100%" stop-color="#0e7490"/>
    </linearGradient>`);
    defs.push(`
    <linearGradient id="cyan-highlight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>`);
  } else if (recipe.fill === 'crimson') {
    defs.push(`
    <linearGradient id="crimson-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#fecaca"/>
      <stop offset="40%"  stop-color="#dc2626"/>
      <stop offset="100%" stop-color="#7f1d1d"/>
    </linearGradient>`);
  } else if (recipe.fill === 'genre') {
    defs.push(`
    <linearGradient id="genre-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="50%"  stop-color="${accent}"/>
      <stop offset="100%" stop-color="#0a0a0a" stop-opacity="0.9"/>
    </linearGradient>`);
  }

  // Soft glow filter (used when recipe.glow is set).
  if (recipe.glow) {
    // Combined filter: triple-stack drop-shadow (carved depth) PLUS
    // coloured glow. SVG only allows ONE filter per element, so we
    // merge both effects into a single filter chain via feMerge and
    // chain the drop-shadows by feeding the previous result forward.
    defs.push(`
    <filter id="title-glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${recipe.glow.size}" result="blur"/>
      <feFlood flood-color="${recipe.glow.color}" flood-opacity="0.7"/>
      <feComposite in2="blur" operator="in" result="glow"/>
      <feDropShadow in="glow" dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.85" result="sh1"/>
      <feDropShadow in="sh1"   dx="0" dy="2" stdDeviation="3"  flood-color="#000" flood-opacity="0.6"  result="sh2"/>
      <feDropShadow in="sh2"   dx="0" dy="-1" stdDeviation="1" flood-color="#fff" flood-opacity="0.18" result="sh3"/>
      <feMerge>
        <feMergeNode in="sh3"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>`);
  } else {
    // No glow: just the triple-stack drop-shadow for carved depth
    // (matches Example 02/08/14 style without the colored halo).
    defs.push(`
    <filter id="title-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.85"/>
      <feDropShadow dx="0" dy="2" stdDeviation="3"  flood-color="#000" flood-opacity="0.6"/>
      <feDropShadow dx="0" dy="-1" stdDeviation="1" flood-color="#fff" flood-opacity="0.18"/>
    </filter>`);
  }

  defs.push(`
    <filter id="meta-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.7"/>
    </filter>`);

  return defs.join('\n');
}

// ── Title text layers (per line) ──────────────────────────────────────────

/** Y position where the baseline of the FIRST author line lands. The text
 *  layer build below just renders each line at y + i*lineHeight + ascender. */
interface ReflowResult {
  fontSize: number;
  lines: string[];
  lineHeight: number;
  /** Bottom edge of the title's last line (incl. descender + glow slack). */
  titleBottomY: number;
  /** Baseline Y of the FIRST author line. */
  authorY: number;
  /** Baseline Y of the (single-line) tagline. */
  taglineY: number;
}

/** Tighten the title's font size so its bottom edge clears the author.
 *  Symptom (pre-fix): on long novels that wrap to 4-5 lines, the title
 *  bottom crashed into the author baseline and the SVG rendered them
 *  on the same Y, producing "title overlaps with author" visible from
 *  the cover preview. Author Y was hardcoded to `blockY+blockH-110` and
 *  never adjusted for how tall the title actually got.
 *
 *  Strategy: shrink titleFontSize in 8px steps (down to 36) until
 *  `titleBottomY + safety margin ≤ safeAuthorBaselineY`. If shrinking
 *  below 36 still doesn't fit (extremely long title), truncate the last
 *  wrapped line with an ellipsis so we never burst the band. */
function reflowTitleForPlacement(
  layout: TitleLayout,
  recipe: GenreRecipe,
  title: string,
): ReflowResult {
  const blockStartY = layout.blockY + (recipe.ornament === 'flourish' ? 40 : 24);
  // Tagline TOP at blockY+blockH-56. Author must finish ABOVE tagline with
  // a 14px gap. Author baseline Y must therefore satisfy
  //   authorY_baseline + 28*0.3  ≤  blockY+blockH-56-14
  //   authorY_baseline           ≤  blockY+blockH-78.4
  const safeAuthorBaselineY = layout.blockY + layout.blockH - 80;
  // And author MUST start below title (18px gap):
  //   authorY_baseline  ≥  titleBottomY + 18 + 28*0.7
  // So titleBottomY must satisfy:
  //   titleBottomY  ≤  safeAuthorBaselineY - 37.6 - 12  (extra 12 buffer)
  const safeTitleBottomY = safeAuthorBaselineY - 50;

  const initialFontSize = layout.titleFontSize;
  let fontSize = initialFontSize;
  let lines: string[] = [];
  let lineHeight = 0;
  let titleBottomY = blockStartY;

  for (let attempt = 0; attempt < 6; attempt++) {
    lineHeight = fontSize * (layout.lineHeightMultiplier ?? 1.08);
    const maxChars = Math.max(4, Math.floor(layout.titleMaxW / (fontSize * 0.55)));
    lines = wrapText(title, maxChars);
    // Glow filter stdDeviation can extend the visual envelope 12-15 px
    // below the descender line. Bake that slack into titleBottomY so
    // the glow doesn't bleed onto the author text.
    const glowSlack = recipe.glow ? Math.max(14, recipe.glow.size + 6) : 6;
    const N = lines.length;
    // Last baseline = blockStartY + (N-1)*lineHeight + fontSize*0.8.
    // Bottom = last baseline + fontSize*0.2 (descender) + glowSlack.
    titleBottomY =
      blockStartY +
      Math.max(0, N - 1) * lineHeight +
      fontSize * 0.8 +
      fontSize * 0.2 +
      glowSlack;

    if (titleBottomY <= safeTitleBottomY) break;

    const next = Math.max(36, fontSize - 8);
    if (next >= fontSize) break;          // already at min, can't shrink further
    fontSize = next;
  }

  // Last-resort: if even at min fontSize we overflow, truncate the last
  // wrapped line with "…" until it fits. Better a truncated title than
  // an overlap.
  if (titleBottomY > safeTitleBottomY && lines.length > 1) {
    const recomputeBottom = () =>
      blockStartY +
      Math.max(0, lines.length - 1) * lineHeight +
      fontSize * 0.8 +
      fontSize * 0.2 +
      (recipe.glow ? Math.max(14, recipe.glow.size + 6) : 6);
    while (lines.length > 1 && titleBottomY > safeTitleBottomY) {
      const last = lines.pop()!;
      const trimmed = last.length > 4 ? last.slice(0, last.length - 2).trimEnd() + '…' : '…';
      lines.push(trimmed);
      titleBottomY = recomputeBottom();
      if (titleBottomY <= safeTitleBottomY) break;
    }
  }

  const authorY = titleBottomY + 18 + 28 * 0.7;
  const taglineY = layout.blockY + layout.blockH - 56 + 18 * 0.7;

  // Recompute lineHeight with the FINAL fontSize so caller gets a
  // consistent pair (fontSize / lineHeight).
  lineHeight = fontSize * (layout.lineHeightMultiplier ?? 1.08);

  return { fontSize, lines, lineHeight, titleBottomY, authorY, taglineY };
}

function buildTitleLines(
  layout: TitleLayout,
  recipe: GenreRecipe,
  titleLines: string[],
  titleFontSize: number,
  lineHeight: number,
): string {
  // titleFontSize + lineHeight come from reflowTitleForPlacement() so
  // they may be smaller than `layout.titleFontSize` if the title was
  // shrunk to clear the author baseline.
  const { titleMaxW, textAnchor, titleX } = layout;
  const blockStartY = layout.blockY + (recipe.ornament === 'flourish' ? 40 : 24);
  const fill = gradientFor(recipe.fill, '#c89b3c');
  // SVG only allows ONE filter per element. The `title-glow` filter
  // (defined when glow is set) bundles both the colored halo AND the
  // triple drop-shadow chain; otherwise we use the plain shadow filter.
  const filterAttr = recipe.glow
    ? ' filter="url(#title-glow)"'
    : ' filter="url(#title-shadow)"';
  const stroke = recipe.stroke;

  return titleLines.map((line, i) => {
    const y = blockStartY + i * lineHeight + titleFontSize * 0.8;
    // Per-char jitter for kinh_di / hand-drawn feel. We only jitter
    // when explicitly requested (recipe.charJitter > 0).
    const jitter = recipe.charJitter;
    if (jitter > 0) {
      // Emit one <text> per char with a tiny rotation. Each char's
      // rotation is deterministic from its index so it stays stable.
      const chars = Array.from(line);
      const charWidth = titleFontSize * 0.55;
      const totalWidth = charWidth * chars.length;
      let xCursor = textAnchor === 'middle'
        ? titleX - totalWidth / 2
        : textAnchor === 'end'
          ? titleX - totalWidth
          : titleX;
      return chars.map((ch, ci) => {
        const angle = ((ci * 17 + i * 11) % 7 - 3) * jitter / 3;
        const cx = xCursor + charWidth / 2;
        const cy = y - titleFontSize * 0.3;
        const chEsc = escXml(ch);
        xCursor += charWidth;
        // Anchor layer
        const anchor = `<text x="${cx}" y="${y}" text-anchor="middle"
          font-family="${recipe.italic ? 'Literata-Italic' : 'Literata-Black'}, 'Noto Serif', Georgia, serif"
          font-size="${titleFontSize}" font-weight="${recipe.fontWeight}"
          font-style="${recipe.italic ? 'italic' : 'normal'}"
          fill="${stroke}" stroke="${stroke}" stroke-width="${recipe.strokeWidth + 1}"
          stroke-linejoin="round" letter-spacing="${recipe.letterSpacing}"
          transform="rotate(${angle} ${cx} ${cy})"${filterAttr}>${chEsc}</text>`;
        // Fill layer
        const fillLayer = `<text x="${cx}" y="${y}" text-anchor="middle"
          font-family="${recipe.italic ? 'Literata-Italic' : 'Literata-Black'}, 'Noto Serif', Georgia, serif"
          font-size="${titleFontSize}" font-weight="${recipe.fontWeight}"
          font-style="${recipe.italic ? 'italic' : 'normal'}"
          fill="${fill}" stroke="${fill}" stroke-width="0.5"
          letter-spacing="${recipe.letterSpacing}"
          transform="rotate(${angle} ${cx} ${cy})">${chEsc}</text>`;
        return anchor + fillLayer;
      }).join('');
    }
    // Standard stacked layer for non-jittered lines.
    const safeLine = escXml(line);
    const family = recipe.italic ? 'Literata-Italic' : 'Literata-Black';
    // Layer 1 — heavy dark anchor (stroke + fill same dark color)
    const anchor = `<text x="${titleX}" y="${y}" text-anchor="${textAnchor}"
      font-family="${family}, 'Noto Serif', Georgia, serif"
      font-size="${titleFontSize}" font-weight="${recipe.fontWeight}"
      font-style="${recipe.italic ? 'italic' : 'normal'}"
      fill="${stroke}" stroke="${stroke}" stroke-width="${recipe.strokeWidth}"
      stroke-linejoin="round" letter-spacing="${recipe.letterSpacing}"
      ${filterAttr}>${safeLine}</text>`;
    // Layer 2 — bright gradient fill (visible body)
    const body = `<text x="${titleX}" y="${y}" text-anchor="${textAnchor}"
      font-family="${family}, 'Noto Serif', Georgia, serif"
      font-size="${titleFontSize}" font-weight="${recipe.fontWeight}"
      font-style="${recipe.italic ? 'italic' : 'normal'}"
      fill="${fill}" letter-spacing="${recipe.letterSpacing}">${safeLine}</text>`;
    // Layer 3 — thin highlight (engraved sheen on upper portion only).
    // Use a clipPath of upper 50% of the line for the highlight stroke.
    const highlightClipId = `hl-clip-${i}`;
    const highlightClip = `<clipPath id="${highlightClipId}">
      <rect x="0" y="${y - titleFontSize * 0.9}" width="${W}" height="${titleFontSize * 0.45}"/>
    </clipPath>`;
    const highlight = `<text x="${titleX}" y="${y}" text-anchor="${textAnchor}"
      font-family="${family}, 'Noto Serif', Georgia, serif"
      font-size="${titleFontSize}" font-weight="${recipe.fontWeight}"
      font-style="${recipe.italic ? 'italic' : 'normal'}"
      fill="none" stroke="url(#gold-highlight)" stroke-width="1.2"
      letter-spacing="${recipe.letterSpacing}"
      clip-path="url(#${highlightClipId})">${safeLine}</text>`;
    return anchor + body + highlight + highlightClip;
  }).join('\n  ');
}

// ── Author / tagline / series badge ───────────────────────────────────────

function buildAuthor(
  layout: TitleLayout,
  author: string,
  recipe: GenreRecipe,
  textColor: string,
  /** Baseline Y of the FIRST author line. Caller passes a value that
   *  clears the title's reflowed bottom edge so the two never overlap. */
  yBaseline: number,
): string {
  const fontSize = 28;
  const lineHeight = fontSize * 1.2;
  const lines = wrapText(author, 28);
  return lines.map((line, i) => `
  <text x="${layout.titleX}" y="${yBaseline + i * lineHeight + fontSize * 0.7}"
    text-anchor="${layout.textAnchor}"
    font-family="Literata-Italic, 'Noto Serif', Georgia, serif"
    font-size="${fontSize}" font-weight="400" font-style="italic"
    fill="${textColor}" opacity="0.95"
    filter="url(#meta-shadow)">${escXml(line)}</text>`).join('');
}

function buildTagline(
  layout: TitleLayout,
  tagline: string,
  textColor: string,
  /** Baseline Y of the single-line tagline. Caller (buildTypography)
   *  keeps this anchored near `blockY+blockH-56` regardless of how tall
   *  the title grew — tagline sits at the BOTTOM of the typography
   *  block, with the author slot stacked above it. */
  yBaseline: number,
): string {
  if (!tagline) return '';
  const fontSize = 18;
  return `
  <text x="${layout.titleX}" y="${yBaseline}"
    text-anchor="${layout.textAnchor}"
    font-family="Literata-Light, 'Noto Serif', Georgia, serif"
    font-size="${fontSize}" font-weight="300" font-style="italic"
    fill="${textColor}" opacity="0.75" letter-spacing="3"
    filter="url(#meta-shadow)">${escXml(tagline.toUpperCase())}</text>`;
}

function buildSeriesBadge(
  series: string | null | undefined,
  seriesIndex: number | null | undefined,
  accent: string,
): string {
  if (!series) return '';
  const label = (series + (seriesIndex ? ` · Tập ${seriesIndex}` : '')).toUpperCase();
  const badgeW = Math.min(W - 80, Math.max(180, label.length * 11 + 60));
  const badgeH = 32;
  const badgeX = (W - badgeW) / 2;
  const badgeY = 56;
  return `
  <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="4"
    fill="${accent}" opacity="0.18" stroke="${accent}" stroke-width="1.5"/>
  <text x="${W / 2}" y="${badgeY + badgeH / 2 + 4}"
    text-anchor="middle"
    font-family="Literata, 'Noto Serif', Georgia, serif"
    font-size="14" font-style="italic"
    fill="${accent}" letter-spacing="2">${escXml(label)}</text>`;
}

// ── Decorative ornaments ──────────────────────────────────────────────────

function buildOrnament(
  recipe: GenreRecipe,
  layout: TitleLayout,
  accent: string,
): string {
  const { blockX, blockY, blockW, blockH } = layout;
  switch (recipe.ornament) {
    case 'minimal':
      // Two thin horizontal rules bracketing the title block.
      return `
  <line x1="${blockX + 60}" y1="${blockY + 12}" x2="${blockX + blockW - 60}" y2="${blockY + 12}"
    stroke="${accent}" stroke-width="1" opacity="0.5"/>
  <line x1="${blockX + 60}" y1="${blockY + blockH - 12}" x2="${blockX + blockW - 60}" y2="${blockY + blockH - 12}"
    stroke="${accent}" stroke-width="1" opacity="0.5"/>`;
    case 'rules':
      // Center diamond between title and author — ancient-novel cue.
      const cx = blockX + blockW / 2;
      const cy = blockY + blockH - 140;
      const diamond = `<path d="M ${cx} ${cy - 8} L ${cx + 12} ${cy} L ${cx} ${cy + 8} L ${cx - 12} ${cy} Z"
        fill="${accent}" opacity="0.85"/>
        <path d="M ${cx} ${cy - 4} L ${cx + 6} ${cy} L ${cx} ${cy + 4} L ${cx - 6} ${cy} Z"
        fill="#ffffff" opacity="0.4"/>`;
      const tripleRules = `
  <line x1="${blockX + 80}" y1="${blockY + 14}" x2="${blockX + blockW - 80}" y2="${blockY + 14}"
    stroke="${accent}" stroke-width="2" opacity="0.85"/>
  <line x1="${blockX + 80}" y1="${blockY + 18}" x2="${blockX + blockW - 80}" y2="${blockY + 18}"
    stroke="${accent}" stroke-width="0.7" opacity="0.5"/>
  <line x1="${blockX + 80}" y1="${blockY + blockH - 18}" x2="${blockX + blockW - 80}" y2="${blockY + blockH - 18}"
    stroke="${accent}" stroke-width="2" opacity="0.85"/>`;
      return tripleRules + diamond;
    case 'frame':
      // Thin stroked rect around the typography block, inset 12px.
      return `
  <rect x="${blockX + 12}" y="${blockY + 12}" width="${blockW - 24}" height="${blockH - 24}"
    fill="none" stroke="${accent}" stroke-width="1" opacity="0.55"/>
  <rect x="${blockX + 14}" y="${blockY + 14}" width="${blockW - 28}" height="${blockH - 28}"
    fill="none" stroke="#ffffff" stroke-width="0.5" opacity="0.25"/>`;
    case 'flourish': {
      // Corner brackets at all 4 corners of the typography block —
      // emulates the engraved frame look of Examples 02/08/14.
      const corners = [
        [blockX + 24,                blockY + 24],
        [blockX + blockW - 24,       blockY + 24],
        [blockX + 24,                blockY + blockH - 24],
        [blockX + blockW - 24,       blockY + blockH - 24],
      ];
      const len = 28;
      return corners.map(([x, y], idx) => {
        // dx, dy for the two legs of the L bracket per corner.
        const sx = idx % 2 === 0 ? 1 : -1;
        const sy = idx < 2 ? 1 : -1;
        return `
  <path d="M ${x} ${y - sy * len} L ${x} ${y} L ${x + sx * len} ${y}"
    fill="none" stroke="${accent}" stroke-width="2.5" opacity="0.85"
    stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M ${x} ${y - sy * len} L ${x} ${y} L ${x + sx * len} ${y}"
    fill="none" stroke="#ffffff" stroke-width="0.6" opacity="0.45"
    stroke-linecap="round" stroke-linejoin="round"/>`;
      }).join('');
    }
  }
}

// ── Backdrop gradient rect ────────────────────────────────────────────────

function buildBackdrop(
  layout: TitleLayout,
  background: 'dark' | 'light',
): string {
  const isDark = background === 'dark';
  const color = isDark ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.55)';
  const opacity = isDark ? 1.0 : 1.0;
  // The gradient endpoint coords live in objectBoundingBox (default).
  const { x1, y1, x2, y2 } = layout.gradientEndpoints;
  const gid = `backdrop-${x1}-${y1}-${x2}-${y2}`;
  return `
  <defs>
    <linearGradient id="${gid}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
      <stop offset="0%"   stop-color="${color}" stop-opacity="0"/>
      <stop offset="35%"  stop-color="${color}" stop-opacity="${opacity * 0.55}"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="${opacity}"/>
    </linearGradient>
  </defs>
  <rect x="${layout.backdropRect.x}" y="${layout.backdropRect.y}"
    width="${layout.backdropRect.w}" height="${layout.backdropRect.h}"
    fill="url(#${gid})"/>`;
}

// ── Spine + language tag (cover-consistent across placements) ─────────────

function buildFrameElements(opts: TypographyOpts, accent: string, textColor: string): string {
  return `
  <!-- Decorative book spine on left -->
  <rect x="0" y="0" width="6" height="${H}" fill="rgba(0,0,0,0.35)"/>
  <rect x="6" y="0" width="1" height="${H}" fill="rgba(255,255,255,0.08)"/>
  <!-- Subtle top divider above the AI subject -->
  <line x1="60" y1="140" x2="${W - 60}" y2="140" stroke="${accent}" stroke-width="1" opacity="0.45"/>
  <line x1="60" y1="144" x2="${W - 60}" y2="144" stroke="rgba(255,255,255,0.08)" stroke-width="0.5"/>
  <!-- Language tag bottom-right -->
  <text x="${W - 30}" y="${H - 25}" text-anchor="end"
    font-family="Literata, 'Noto Sans', monospace" font-size="11"
    fill="${textColor}" opacity="0.45" letter-spacing="2">
    ${(opts.language ?? 'vi').toUpperCase()}
  </text>`;
}

// ── Public entry point ────────────────────────────────────────────────────

export function buildTypography(
  placement: TitlePlacement,
  design: TypographyDesign,
  opts: TypographyOpts,
): TypographyResult {
  const recipe = RECIPES[design.genre] ?? RECIPES.unknown;
  const layout = layoutFor(placement, opts.title);
  // Reflow: shrink titleFontSize and rewrap so the title's bottom edge
  // (incl. glow filter slack) clears the author baseline. Without this
  // step, long titles that wrap to 4-5 lines crash into the author
  // baseline and the SVG renders them overlapping.
  const reflow = reflowTitleForPlacement(layout, recipe, opts.title);
  const { fontSize: titleFontSize, lines: titleLines, lineHeight: titleLineHeight,
          authorY, taglineY } = reflow;

  const titleSvg = buildTitleLines(layout, recipe, titleLines, titleFontSize, titleLineHeight);
  const authorSvg = buildAuthor(layout, opts.author, recipe, design.textColor, authorY);
  const taglineSvg = buildTagline(layout, design.tagline, design.textColor, taglineY);
  const seriesSvg = buildSeriesBadge(opts.series, opts.seriesIndex, design.accent);
  const ornamentSvg = buildOrnament(recipe, layout, design.accent);
  const backdropSvg = buildBackdrop(layout, design.background);
  const frameSvg = buildFrameElements(opts, design.accent, design.textColor);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    ${gradientDefBlock(design.accent, recipe)}
  </defs>
  ${backdropSvg}
  ${frameSvg}
  ${seriesSvg}
  ${ornamentSvg}
  ${titleSvg}
  ${authorSvg}
  ${taglineSvg}
</svg>`;

  return {
    svg,
    width: W,
    height: H,
    diag: {
      placement,
      recipe: design.genre,
      ornament: recipe.ornament,
      titleFontSize,
      titleLines: titleLines.length,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

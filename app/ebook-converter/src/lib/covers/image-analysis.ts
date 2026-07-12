// src/lib/covers/image-analysis.ts
//
// Tiny image-content analyser for AI-generated cover backdrops.
// Used by `compositeCover()` in ai-generate-cover.ts to decide WHERE
// on the cover the title should be placed so the main subject is not
// covered.
//
// We downsample the AI image to a 40x60 grayscale grid (~5 ms),
// score each of 4 candidate bands (h-bottom, h-top, v-left, v-right)
// by "emptiness" (low variance + low edge density = a flat region
// free of subject detail) and return the top scorer.
//
// Why this is safe:
//   - Operates on the AI image AFTER `sharp().resize(W, H, fit:'cover')`
//     runs in compositeCover, so geometry matches the final cover.
//   - Pure read — never modifies the buffer; can be called anywhere
//     in the pipeline.
//   - No new dependencies; uses sharp which is already imported.

import sharp from 'sharp';

export type TitlePlacement = 'h-bottom' | 'h-top' | 'v-left' | 'v-right';

export interface PlacementScore {
  placement: TitlePlacement;
  /** 0..1 — higher = emptier / better for the title. */
  score: number;
  /** Diagnostic stats for logging. */
  diag: { meanLum: number; variance: number; edgeDensity: number };
}

/** Sampling grid — 40 cols x 60 rows keeps the 2:3 cover aspect and
 *  fits in ~2.4 KB of raw bytes for fast scanning. Resolution is
 *  deliberately coarse: we want regional emptiness, not pixel detail. */
const GRID_W = 40;
const GRID_H = 60;

/** Candidate bands on the 40x60 grid.
 *
 *  h-bottom: bottom 40% (rows 36..60)
 *  h-top:    top 30% (rows 0..18)
 *  v-left:   left 30%, vertically centered (cols 0..12, rows 6..54)
 *  v-right:  right 30%, vertically centered (cols 28..40, rows 6..54)
 *
 *  Centering the vertical bands gives the AI subject more room
 *  above/below; title flows down the side of the cover.
 */
const BANDS: Record<TitlePlacement, { x0: number; y0: number; x1: number; y1: number }> = {
  'h-bottom': { x0: 0, y0: 36, x1: GRID_W, y1: GRID_H },
  'h-top':    { x0: 0, y0: 0,  x1: GRID_W, y1: 18 },
  'v-left':   { x0: 0, y0: 6,  x1: 12,     y1: 54 },
  'v-right':  { x0: 28, y0: 6, x1: GRID_W, y1: 54 },
};

/** Soft bias toward h-bottom so the existing aesthetic is preserved
 *  when no band is meaningfully emptier. The 0.04 nudge is small
 *  enough that a clearly empty top/left/right still wins. */
const DEFAULT_BIAS: Record<TitlePlacement, number> = {
  'h-bottom': 0.04,
  'h-top':    0.00,
  'v-left':   0.00,
  'v-right':  0.00,
};

/** Pick the emptiest band of an AI-generated cover backdrop.
 *  Returns the band + a 0..1 score (higher = better) + diagnostic
 *  numbers for logging.
 *
 *  The score combines:
 *    - 1 − variance / 4096  (smoothness: low variance = flat region)
 *    - 1 − edgeDensity * 4  (no edges = no subject detail)
 *  Plus the small DEFAULT_BIAS toward h-bottom.
 */
export async function pickTitlePlacement(bgBuffer: Buffer): Promise<PlacementScore> {
  // Downsample to small grayscale grid. resize ignores aspect (we set
  // exact width/height) because the input is already the cover-ratio
  // buffer at this point in the pipeline.
  const { data, info } = await sharp(bgBuffer)
    .greyscale()
    .resize(GRID_W, GRID_H, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Sanity: confirm we got 1 channel (greyscale) at the expected size.
  if (info.width !== GRID_W || info.height !== GRID_H || info.channels !== 1) {
    // Shouldn't happen — sharp guarantees the output. Fall through with
    // the lowest score so the caller picks h-bottom by default.
    return {
      placement: 'h-bottom',
      score: 0,
      diag: { meanLum: 0, variance: 0, edgeDensity: 0 },
    };
  }

  const scores: PlacementScore[] = (Object.keys(BANDS) as TitlePlacement[]).map((placement) => {
    const band = BANDS[placement];
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let y = band.y0; y < band.y1; y++) {
      for (let x = band.x0; x < band.x1; x++) {
        const v = data[y * GRID_W + x];
        sum += v;
        sumSq += v * v;
        count++;
      }
    }

    const meanLum = sum / count;
    const variance = sumSq / count - meanLum * meanLum;

    // Edge density: count cells where at least one 4-neighbour differs
    // by >24 (rough gradient/edge proxy). Clamp at 1.
    let edgeCount = 0;
    let edgeTotal = 0;
    for (let y = band.y0; y < band.y1; y++) {
      for (let x = band.x0; x < band.x1; x++) {
        const v = data[y * GRID_W + x];
        let maxDiff = 0;
        if (x + 1 < band.x1) maxDiff = Math.max(maxDiff, Math.abs(v - data[y * GRID_W + x + 1]));
        if (y + 1 < band.y1) maxDiff = Math.max(maxDiff, Math.abs(v - data[(y + 1) * GRID_W + x]));
        edgeTotal++;
        if (maxDiff > 24) edgeCount++;
      }
    }
    const edgeDensity = edgeCount / Math.max(1, edgeTotal);

    // Combine: prefer flat (low variance) and edge-free.
    // Variance of a uniform 0..255 range is at most ~16384; dividing by
    // 4096 caps the contribution sensibly. Edge density is 0..1.
    const consistency = Math.max(0, 1 - variance / 4096);
    const edgeScore = Math.max(0, 1 - edgeDensity * 4);
    const score = Math.max(0, Math.min(1, consistency * 0.6 + edgeScore * 0.4 + DEFAULT_BIAS[placement]));

    return { placement, score, diag: { meanLum, variance, edgeDensity } };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores[0];
}

/** Cheap heuristic used BEFORE we have the AI image — picks a default
 *  placement so the imagePrompt can ask the AI to leave that area empty.
 *  Mirrored in genre-detector.ts as `pickInitialPlacement`. */
export function pickInitialPlacementByTitle(title: string): TitlePlacement {
  // Vietnamese reads horizontally, so vertical-side bands are
  // reserved for long titles that don't fit comfortably at the bottom.
  if (title.length > 28) return 'v-right';
  if (title.length > 22) return 'v-left';
  return 'h-bottom';
}

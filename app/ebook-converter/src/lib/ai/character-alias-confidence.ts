// src/lib/ai/character-alias-confidence.ts
//
// Phase 4.4 of docs/NEXT_UP_PLAN.md — converts the Python character
// detector's fold signals into a per-alias confidence score that drives
// the "needs review" badge in CharacterMergeSplitPanel.
//
// The score is on a 0..1 scale where:
//   - 1.0  = user-edited or backfilled from legacy JSON (always trusted)
//   - 0.95 = exact-match / accent-normalized fold
//   - 0.85 = substring fold (one name is a prefix of the other)
//   - 0.75 = Levenshtein fold (typo / diacritic difference)
//   - 0.6  = LLM-only fold (no string match, picked up by the LLM)
//   - 0.0  = explicitly rejected by the user (PATCH /aliases/[aliasId])
//
// On top of the fold-method base, two modifiers apply:
//   1. Sample-lines bonus: +0.05 per sample line the detector cited for
//      the alias, capped at +0.2. More evidence = higher confidence.
//   2. Alias crowding decay: ×0.85 per alias beyond the third on the same
//      character. A character with 5+ aliases typically means the detector
//      was over-eager, so each individual alias is less trustworthy.
//
// All callers should go through `computeAliasConfidence()` — never write a
// raw number into the DB. The function clamps to [0, 1] and rounds to 2dp
// so consumers don't have to worry about float dust.

export type FoldMethod =
  | 'exact'        // equal strings after trim+lower
  | 'normalized'   // equal after accent-strip (Linh == Linh, Lộc == Loc)
  | 'substring'    // one is a prefix/suffix of the other (e.g. "Linh" in "Linh Hồng")
  | 'levenshtein'  // small edit distance (≤ 2 on strings ≤ 8 chars)
  | 'llm';         // no string match; the LLM picked it up by context

export interface DetectorSignals {
  /** How many aliases this character has after folding. >3 = over-eager. */
  aliasCount: number;
  /** Which fold method produced this alias. Drives the base score. */
  foldMethod: FoldMethod;
  /** Number of sample_lines the detector cited for this alias. */
  sampleLinesCount: number;
  /** Distinct chapters the alias appears in. Optional — defaults to 1. */
  chapterSpread?: number;
}

const FOLD_BASE: Record<FoldMethod, number> = {
  exact: 0.95,
  normalized: 0.95,
  substring: 0.85,
  levenshtein: 0.75,
  llm: 0.6,
};

const MAX_BONUS = 0.2;
const BONUS_PER_LINE = 0.05;
const DECAY_PER_EXTRA = 0.85;
const DECAY_START = 3; // decay kicks in at alias #4

/**
 * Compute a per-alias confidence score given the detector signals.
 *
 * Returns a number in [0, 1], rounded to 2 decimal places.
 */
export function computeAliasConfidence(
  primaryName: string,
  alias: string,
  signals: DetectorSignals,
): number {
  // Guard rails — bad inputs get the safest score.
  if (!primaryName || !alias) return 0;
  // A character should never alias to its own canonical name — if the
  // detector folded the name into itself (shouldn't happen, but cheap to
  // check) treat it as a fully-trusted tie so it always shows up at the
  // top of the list. Self-alias bypasses both sample-lines bonus and
  // crowding decay since "this character has many aliases" doesn't
  // diminish the fact that the canonical name is unambiguous.
  const isSelfAlias = primaryName.trim().toLowerCase() === alias.trim().toLowerCase();
  if (isSelfAlias) return 1.0;
  const base = FOLD_BASE[signals.foldMethod] ?? 0.5;

  // Sample-lines bonus, capped at MAX_BONUS.
  const bonus = Math.min(
    MAX_BONUS,
    Math.max(0, signals.sampleLinesCount) * BONUS_PER_LINE,
  );

  // Crowding decay — kick in when aliasCount > DECAY_START.
  let decay = 1.0;
  if (signals.aliasCount > DECAY_START) {
    const extra = signals.aliasCount - DECAY_START;
    decay = Math.pow(DECAY_PER_EXTRA, extra);
  }

  const raw = (base + bonus) * decay;
  const clamped = Math.max(0, Math.min(1, raw));
  // Round to 2dp — DB stores REAL, no need for more precision.
  return Math.round(clamped * 100) / 100;
}

/**
 * Lower threshold for "needs review" — aliases below this score get the
 * red/amber badge in the UI.
 *
 * 0.6 = anything below the LLM-only baseline. That means: if the detector
 * couldn't even find a string match and only the LLM caught it, the user
 * should look at it.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Higher threshold for "probably fine" — aliases above this get the green
 * badge. Anything between 0.6 and 0.8 is the "amber zone" (substring/lev).
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/** Classify an alias score into a UI tier for the badge color. */
export type AliasTier = 'high' | 'medium' | 'low';

export function classifyAliasScore(score: number): AliasTier {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) return 'high';
  if (score >= LOW_CONFIDENCE_THRESHOLD) return 'medium';
  return 'low';
}

// src/lib/vi-text-qa.ts
//
// Vietnamese text utilities used by the AI-enhancement and character-detection
// paths. Mirrors the helpers in `app/tts-service/vi_g2p.py` so the Next.js
// stack and the Python worker stay consistent.
//
// Two concerns:
//   1. Diacritic- and tone-insensitive name matching — collapses OCR / LLM
//      spelling variants ("Tuấn Ngọc" === "Tuan Ngoc" === "TUẤN  NGỌC").
//   2. Minimal-pair QA — detects Vietnamese contrasts that LLMs and OCR tend
//      to collapse (t/th, tr/ch, s/x, gi/d, e-/e). Surfaced as warnings on
//      AI-enhanced text before TTS consumes it.
//
// Pure TypeScript — no native deps, safe to import in client and server code.

export type MinimalPairFinding = {
  type: "minimal_pair";
  pair: [string, string];
  hint: string;
  why: string;
};

// ── Diacritic + tone stripping ──────────────────────────────────────────────

/**
 * Aggressive ASCII fold: strips every combining mark (Unicode Mn) so
 * Vietnamese precomposed letters (à, ế, ơ, ư…) collapse to their base
 * Latin letter, then replaces đ/Đ explicitly. Returns NFC-normalized text.
 */
export function stripVietnamese(s: string): string {
  if (!s) return "";
  // NFKD breaks precomposed Vietnamese letters into <base> + <combiner(s)>.
  // We then drop all combining marks — tones, circumflexes, breves, horns,
  // dots — and only the base letters survive. đ/Đ have no ASCII base so
  // they fall through unchanged and get explicit-mapped below.
  const decomposed = s.normalize("NFKD");
  let out = "";
  for (const ch of decomposed) {
    // Mn = Mark, Nonspacing — exactly what we want to drop
    if (ch.normalize("NFKD").length === 1 && ch !== ch.toLowerCase()) {
      // keep as-is (handles odd cases)
      out += ch;
      continue;
    }
    // Use code-point category check via intl.Segmenter? Simpler: rely on
    // a regex matching common combining ranges.
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
      (cp >= 0x1ab0 && cp <= 0x1aff) || // Combining Diacritical Marks Extended
      (cp >= 0x1dc0 && cp <= 0x1dff) || // Combining Diacritical Marks Supplement
      (cp >= 0x20d0 && cp <= 0x20ff) || // Combining Diacritical Marks for Symbols
      (cp >= 0xfe20 && cp <= 0xfe2f)    // Combining Half Marks
    ) {
      continue; // drop combining mark
    }
    out += ch;
  }
  out = out.replace(/đ/g, "d").replace(/Đ/g, "D");
  return out.normalize("NFC");
}

/** Lowercase, punctuation-stripped, single-spaced ASCII form. */
export function nameCanonical(name: string): string {
  return stripVietnamese(name)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** NFC-normalized lowercase, whitespace collapsed (keeps diacritics). */
export function normalizeVietnamese(text: string): string {
  if (!text) return "";
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Cheap Vietnamese detector — same range check as the Python side. */
export function hasVietnamese(text: string): boolean {
  if (!text) return false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x00c0 && cp <= 0x024f) || (cp >= 0x1e00 && cp <= 0x1eff)) {
      return true;
    }
  }
  return false;
}

/** True if two strings refer to the same entity under diacritic + tone folding. */
export function g2pMatch(a: string, b: string): boolean {
  const ca = nameCanonical(a);
  const cb = nameCanonical(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  // Allow whitespace/hyphen differences
  const ca2 = ca.replace(/[\s\-]+/g, "");
  const cb2 = cb.replace(/[\s\-]+/g, "");
  return ca2.length >= 2 && ca2 === cb2;
}

// ── Character dedup (mirror of _merge_duplicate_characters in Python) ────────

export type CharacterRecord = {
  name: string;
  aliases?: string[];
  gender?: string;
  age?: string;
  tone?: string;
  role?: string;
  lines_estimate?: number;
  sample_lines?: string[];
};

/**
 * Collapse near-duplicate character entries that differ only by diacritics /
 * case / spacing (common when OCR degrades EPUBs or the LLM re-spells names).
 *
 * Keeps the entry with the most diacritics, then largest lines_estimate,
 * then longest name. Folds every other name into `aliases`.
 */
export function mergeDuplicateCharacters(
  characters: CharacterRecord[],
): CharacterRecord[] {
  if (!characters.length) return characters;

  // Union-find by canonical-form equality + g2p_match equivalence.
  const parent = characters.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  const byCanonical = new Map<string, number>();
  characters.forEach((c, idx) => {
    const canon = nameCanonical(c.name ?? "");
    if (!canon) return;
    const existing = byCanonical.get(canon);
    if (existing !== undefined) union(idx, existing);
    else byCanonical.set(canon, idx);
  });

  // Cross-canonical g2p equivalence (handles trims / spacing shifts)
  const keys = Array.from(byCanonical.keys());
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (g2pMatch(keys[i], keys[j])) {
        union(byCanonical.get(keys[i])!, byCanonical.get(keys[j])!);
      }
    }
  }

  // Group members
  const clusters = new Map<number, number[]>();
  characters.forEach((_, idx) => {
    const r = find(idx);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(idx);
  });

  const merged: CharacterRecord[] = [];
  for (const [, members] of clusters) {
    const hasDiacritics = (n: string) => hasVietnamese(n);
    const score = (c: CharacterRecord): [number, number, number] => [
      hasDiacritics(c.name ?? "") ? 1 : 0,
      Number(c.lines_estimate ?? 0),
      (c.name ?? "").length,
    ];
    const gt = (a: [number, number, number], b: [number, number, number]) =>
      a[0] !== b[0] ? a[0] > b[0]
      : a[1] !== b[1] ? a[1] > b[1]
      : a[2] > b[2];
    const primary = members
      .map((m) => characters[m])
      .reduce((best, cur) => (gt(score(cur), score(best)) ? cur : best));

    const aliases: string[] = [];
    for (const m of members) {
      const otherName = characters[m].name ?? "";
      if (otherName && otherName !== primary.name && !aliases.includes(otherName)) {
        aliases.push(otherName);
      }
      for (const a of characters[m].aliases ?? []) {
        if (a && a !== primary.name && !aliases.includes(a)) {
          aliases.push(a);
        }
      }
    }

    const sampleLines: string[] = [];
    const seenLines = new Set<string>();
    outer: for (const m of members) {
      for (const s of characters[m].sample_lines ?? []) {
        if (s && !seenLines.has(s)) {
          seenLines.add(s);
          sampleLines.push(s);
          if (sampleLines.length >= 2) break outer;
        }
      }
    }

    const maxLines = members.reduce(
      (mx, m) => Math.max(mx, Number(characters[m].lines_estimate ?? 0)),
      0,
    );

    merged.push({
      ...primary,
      aliases: aliases.slice(0, 8),
      lines_estimate: maxLines,
      sample_lines: sampleLines,
    });
  }
  return merged;
}

// ── Minimal-pair QA ─────────────────────────────────────────────────────────

const MINIMAL_PAIR_HINTS: Array<[readonly [string, string], string]> = [
  [["tường", "thường"], "t vs th — both can sound similar in casual speech"],
  [["trước", "chước"], "tr vs ch — easy to swap by mistake"],
  [["số", "xố"], "s vs x — collapsed in southern Vietnamese"],
  [["giải", "dải"], "gi vs d — collapsed in central Vietnamese"],
  [["cách", "kếch"], "e- vs e vowel — distinct front vs mid vowel"],
];

/**
 * Detect minimal-pair co-occurrence in Vietnamese text — a strong signal
 * the AI (or OCR) has collapsed or substituted one form for another.
 *
 * Returns one finding per pair where both forms appear. Cheap, regex-based,
 * no model needed.
 */
export function auditMinimalPairs(text: string): MinimalPairFinding[] {
  if (!text) return [];
  const low = text.toLowerCase();
  const findings: MinimalPairFinding[] = [];
  for (const [pair, hint] of MINIMAL_PAIR_HINTS) {
    const [a, b] = pair;
    if (low.includes(a) && low.includes(b)) {
      findings.push({
        type: "minimal_pair",
        pair: [a, b],
        hint,
        why: "both forms appear in the text — verify the intended contrast",
      });
    }
  }
  return findings;
}

// ── Convenience aggregate ───────────────────────────────────────────────────

export type QaReport = {
  minimalPairs: MinimalPairFinding[];
  warnings: string[];
};

/**
 * One-shot text QA pass. Use after AI-enhancement to flag suspect chapters
 * before they reach TTS.
 */
export function qaVietnamese(text: string): QaReport {
  const minimalPairs = auditMinimalPairs(text);
  const warnings: string[] = [];
  if (minimalPairs.length > 0) {
    warnings.push(
      `${minimalPairs.length} Vietnamese minimal-pair contrast${minimalPairs.length === 1 ? "" : "s"} detected — verify the intended form`,
    );
  }
  return { minimalPairs, warnings };
}
// src/lib/voice-plan.ts
//
// Per-chapter, per-sentence voice-assignment planning for the Voice Assign
// Editor.
//
// The reader's read-aloud engine works at the paragraph level and auto-switches
// voice when a paragraph is attributed to a character. That is too coarse: a
// single paragraph can mix narration with a quote, and the user often wants to
// correct which voice reads which sentence. This module:
//
//   1. Splits a chapter's HTML into sentences (reusing the reader's paragraph
//      slicer, then breaking each paragraph into sentences on Vietnamese
//      sentence boundaries).
//   2. Reuses the existing attribution engine to suggest a character for each
//      sentence (a sentence that contains a quote attributed to a character is
//      suggested as that character; everything else is narration).
//   3. Produces a serialisable plan that the editor persists and the read-aloud
//      engine can consult. Sentences with no voice assigned fall back to the
//      narration (default) voice.
//
import {
  attributeByConversation,
  attributeByRegex,
  sliceParagraphs,
  type CharacterLite,
  type ParagraphRange,
} from '@/lib/attribution';

export type SentenceSource = 'narration' | 'character' | 'manual';

export interface VoicePlanSentence {
  /** Stable 0-based index within the chapter (reading order). */
  i: number;
  /** The sentence text (cleaned, single line). */
  text: string;
  /** Character id this sentence is assigned to, or null for narration. */
  charId: string | null;
  /** Voice id to use; null = use the narration (default) voice. */
  voiceId: string | null;
  /** How the charId was decided. `manual` means the user overrode it. */
  source: SentenceSource;
  /** 0-based paragraph index this sentence belongs to (for visual grouping). */
  para: number;
  /** Attribution confidence in [0,1]. Present only when the sentence was
   *  attributed to a character by the AI/regex engine. Low values (<0.6) are
   *  surfaced in the UI as "uncertain" so the user can review them. */
  confidence?: number;
  /** True when the engine assigned a character but with low confidence. The
   *  UI highlights these sentences for manual review. */
  uncertain?: boolean;
}

export interface VoicePlan {
  bookId: string;
  chapterIndex: number;
  sentences: VoicePlanSentence[];
  sourceMtime: number;
}

/** Split a single cleaned paragraph string into sentences.
 *  Hard terminators: . ! ? — these always end a sentence.
 *  The ellipsis (… / ...) is a SOFT terminator: it ends a sentence only when it
 *  is NOT immediately followed by a closing quote. Inside dialogue a speaker
 *  often trails off with "…" and the quote continues, so splitting there would
 *  break a single line of speech across two "sentences" and look wrong in the
 *  editor. We keep the ellipsis attached to the current sentence and let the
 *  following closing quote (or hard terminator) close it instead.
 *  Very short fragments (e.g. a lone "Ừ") are kept as their own sentence so
 *  dialogue one-liners stay editable. */
export function splitParagraphIntoSentences(text: string): string[] {
  const out: string[] = [];
  // A "soft" ellipsis run: … possibly repeated, optionally followed by a
  // straight or curly closing quote that belongs to the SAME sentence.
  const re = /[^.!?]+(?:[.!?]+(?:["”'’»])?|…+(?!["”'’»]))/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
    lastIndex = m.index + m[0].length;
  }
  // Anything left after the last hard terminator (no terminator at all, or a
  // trailing ellipsis that we deliberately did not split on) becomes its own
  // sentence.
  const rest = text.slice(lastIndex).trim();
  if (rest) out.push(rest);
  if (out.length === 0 && text.trim()) out.push(text.trim());
  return out;
}

/** Split chapter HTML into sentences, preserving reading order. */
export function splitChapterIntoSentences(html: string): string[] {
  const paragraphs: ParagraphRange[] = sliceParagraphs(html);
  const sentences: string[] = [];
  for (const p of paragraphs) {
    for (const s of splitParagraphIntoSentences(p.text)) {
      sentences.push(s);
    }
  }
  return sentences;
}

/** Find the first quote span in a sentence (used to decide if a sentence is
 *  dialogue). Mirrors the lightweight quote detection in attribution.ts.
 *
 *  NOTE 2026-09-02: the previous version required both an opener AND a
 *  closer in the same sentence. That missed dialogue that the splitter
 *  chopped mid-quote on a long ellipsis ("…......"), which is common in
 *  web-novel typography — the quote opener lands on sentence N, the
 *  closer on sentence N+1 (or it's missing entirely due to EPUB error).
 *  Now we also count a sentence as quoted if it STARTS with a quote
 *  opener; the matching close is assumed to follow somewhere downstream
 *  or be silently missing (the user reviews every suggestion anyway). */
function sentenceHasQuote(text: string): boolean {
  if (/["“”'‘'「『]/.test(text.charAt(0))) return true;
  return /["“”'‘'「『][\s\S]*?["”’」』]/.test(text);
}

/**
 * Build a suggested voice plan for a chapter.
 *
 * @param html            Raw chapter HTML.
 * @param chapterIndex    0-based chapter index.
 * @param knownNames     Character display names (as known to the attribution
 *                       engine) — used to attribute quotes.
 * @param nameToCharId   Map from a character's display name (lowercased) to its
 *                       id, so a suggested speaker can be linked to a character.
 * @param sourceMtime    mtime of the chapter HTML file (for cache invalidation).
 */
export function buildSuggestedVoicePlan(params: {
  bookId: string;
  html: string;
  chapterIndex: number;
  knownNames: string[];
  nameToCharId: Record<string, string>;
  /** Character metadata for the conversation pass (name/aliases/gender). */
  characters?: CharacterLite[];
  sourceMtime: number;
}): VoicePlan {
  const { bookId, html, chapterIndex, knownNames, nameToCharId, characters = [], sourceMtime } = params;
  const paragraphs = sliceParagraphs(html);

  // Paragraph-level attribution (regex + conversation pass) reuses the exact
  // engine the reader uses, so suggestions match what read-aloud would do.
  const regexMap = attributeByRegex(paragraphs, knownNames);
  const convMap = attributeByConversation({
    paragraphs,
    characters,
    regexOut: regexMap,
    genre: null,
  });

  // Contextual fallback for unattributed quoted paragraphs. The conversation
  // engine misses several common Vietnamese patterns:
  //   • Self-talk introduced by "tự lẩm bẩm" / "thầm nghĩ" / "thần sắc
  //     bình thản" — the speaker is named in the FOLLOWING narration
  //     paragraph (forward).
  //   • Multi-paragraph monologues where only the first turn gets a regex
  //     hit and the next 2-3 quoted paragraphs continue the same voice
  //     (propagation).
  //   • "A: quotes. / B's actions. / B: quotes." — name mention appears in
  //     narration on either side (bidirectional).
  //
  // The suggestion layer is allowed to be a bit looser than read-aloud
  // attribution because every sentence here is REVIEWED by the user before
  // commit. We tag each fallback hit with confidence 0.55 (uncertain) so
  // the UI shows the "có thể cần xem lại" badge.
  const contextualMap: Record<number, { speaker: string; confidence: number }> = {};
  let lastQuotedSpeaker: string | null = null;
  let lastQuotedConfidence: number | null = null;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const cur = paragraphs[pi];
    const curAttr = convMap[cur.index] ?? regexMap[cur.index] ?? contextualMap[cur.index];
    if (curAttr?.speaker) {
      // Track whichever attribution is available (strong OR contextual)
      // so consecutive same-speaker monologue lines inherit it.
      if (sentenceHasQuote(cur.text)) {
        lastQuotedSpeaker = curAttr.speaker;
        lastQuotedConfidence = curAttr.confidence ?? 0.55;
      }
      continue;
    }
    if (!sentenceHasQuote(cur.text)) continue;

    // 1. Propagation: if the immediately previous quoted paragraph was a
    //    monologue (strong or contextual), keep that speaker — but only
    //    when there is no intervening non-quoted narration paragraph
    //    that names a different character (in which case the speaker
    //    genuinely changed and propagation should NOT kick in).
    if (lastQuotedSpeaker) {
      // Look at the gap paragraphs (pi-1, pi-2, …) to see whether any of
      // them is a non-quoted narration paragraph that names a *different*
      // character. If so, the speaker flipped and we break propagation.
      let speakerFlipped = false;
      for (let look = 1; look < pi; look++) {
        const prev = paragraphs[pi - look];
        if (sentenceHasQuote(prev.text)) break; // stop at the previous quote
        const txt = prev.text;
        const mentionedHere = new Set<string>();
        for (const c of characters) {
          const names = [c.name, ...(c.aliases ?? [])];
          for (const n of names) {
            if (n && txt.includes(n)) mentionedHere.add(c.name);
          }
        }
        if (mentionedHere.size === 1) {
          const [only] = [...mentionedHere];
          if (only !== lastQuotedSpeaker) {
            speakerFlipped = true;
            break;
          }
        }
      }
      if (!speakerFlipped) {
        contextualMap[cur.index] = {
          speaker: lastQuotedSpeaker,
          confidence: lastQuotedConfidence ?? 0.55,
        };
        continue;
      }
    }

    // 2. Bidirectional nearby-mention lookup. Find the closest paragraph
    //    (in either direction) that mentions exactly one character.
    let chosen: string | null = null;
    let chosenConfidence = 0.55;
    let bestDist = Infinity;
    for (const dir of [-1, 1]) {
      for (let look = 1; look <= 3; look++) {
        const nextIdx = pi + dir * look;
        if (nextIdx < 0 || nextIdx >= paragraphs.length) break;
        const neighbour = paragraphs[nextIdx];
        const txt = neighbour.text;
        const mentionedHere = new Set<string>();
        for (const c of characters) {
          const names = [c.name, ...(c.aliases ?? [])];
          for (const n of names) {
            if (n && txt.includes(n)) mentionedHere.add(c.name);
          }
        }
        if (mentionedHere.size === 1) {
          const [only] = [...mentionedHere];
          if (look < bestDist) {
            bestDist = look;
            chosen = only;
            // Slightly higher confidence for closer matches; cap at 0.6 so
            // the UI still shows the uncertain badge.
            chosenConfidence = 0.55 + (3 - look) * 0.02;
          }
          break; // take the first hit in this direction
        }
        if (mentionedHere.size > 1) break; // ambiguous, skip
      }
      if (chosen) break;
    }
    if (chosen) {
      contextualMap[cur.index] = { speaker: chosen, confidence: chosenConfidence };
      lastQuotedSpeaker = chosen;
      lastQuotedConfidence = chosenConfidence;
    }
  }

  const sentences: VoicePlanSentence[] = [];
  let i = 0;
  let quoteOpenAcrossParagraphs = false;
  for (const p of paragraphs) {
    const paraAttr = convMap[p.index] ?? regexMap[p.index] ?? contextualMap[p.index];
    const speakerName = paraAttr?.speaker ?? null;
    const charId = speakerName ? nameToCharId[speakerName.toLowerCase()] ?? null : null;

    const paraSentences = splitParagraphIntoSentences(p.text);
    const paraConfidence = paraAttr?.confidence;
    // Track open-quote state across sentences inside the paragraph AND
    // across paragraph boundaries. The sentence splitter chops on `......`
    // which lands in the middle of multi-sentence quotes, and a paragraph
    // break can also split a single quote. Both cases need continuation
    // tracking so the second piece still counts as dialogue.
    let quoteOpenAcrossSentences = quoteOpenAcrossParagraphs;
    let paragraphOpenBalance = 0;

    for (let si = 0; si < paraSentences.length; si++) {
      const s = paraSentences[si];
      let isDialogue = sentenceHasQuote(s);
      if (!isDialogue && quoteOpenAcrossSentences) isDialogue = true;
      const suggestedCharId = charId && isDialogue ? charId : null;
      const uncertain = !!suggestedCharId && typeof paraConfidence === 'number' && paraConfidence < 0.6;
      // Build the sentence object without the optional fields, then add
      // them only when meaningful — the round-trip test expects omission
      // for narration sentences (preserves prior contract for callers that
      // pass plain `{ i, text, charId, voiceId, source, para }` and read
      // back the same shape).
      const sentence: VoicePlanSentence = {
        i: i++,
        text: s,
        charId: suggestedCharId,
        voiceId: null, // default: narration voice until the user assigns one
        source: suggestedCharId ? 'character' : 'narration',
        para: p.index,
      };
      if (suggestedCharId) {
        sentence.confidence = paraConfidence;
        sentence.uncertain = uncertain;
      }
      sentences.push(sentence);
      // Update the cross-sentence quote state. We use curly / CJK quotes
      // only because the straight ASCII " is ambiguous (opener-or-closer).
      const sOpeners = (s.match(/[“‘'「『]/g) ?? []).length;
      const sClosers = (s.match(/[”’」』]/g) ?? []).length;
      paragraphOpenBalance += sOpeners - sClosers;
      quoteOpenAcrossSentences = paragraphOpenBalance > 0;
    }
    // Carry the running balance to the next paragraph.
    quoteOpenAcrossParagraphs = paragraphOpenBalance > 0;
  }

  return { bookId, chapterIndex, sentences, sourceMtime };
}

/** Serialise a plan to the JSON stored in ChapterVoicePlan.sentences. */
export function serializePlan(plan: VoicePlan): string {
  return JSON.stringify(
    plan.sentences.map((s) => {
      const out: Record<string, unknown> = {
        i: s.i,
        text: s.text,
        charId: s.charId,
        voiceId: s.voiceId,
        source: s.source,
        para: s.para,
      };
      // Only include optional fields when meaningful. Older stored rows
      // (or in-memory callers that built a sentence without these fields)
      // round-trip cleanly through `JSON.stringify`/`parse` this way
      // because `undefined` values are dropped automatically.
      if (s.confidence !== undefined) out.confidence = s.confidence;
      if (s.uncertain !== undefined) out.uncertain = s.uncertain;
      return out;
    }),
  );
}

/** Parse the stored JSON back into a plan. */
export function deserializePlan(
  bookId: string,
  chapterIndex: number,
  json: string,
  sourceMtime: number,
): VoicePlan {
  const raw = JSON.parse(json) as Array<{
    i: number;
    text: string;
    charId: string | null;
    voiceId: string | null;
    source: SentenceSource;
    para?: number;
    confidence?: number;
    uncertain?: boolean;
  }>;
  return {
    bookId,
    chapterIndex,
    sourceMtime,
    sentences: raw.map((s) => {
      const out: VoicePlanSentence = {
        i: s.i,
        text: s.text,
        charId: s.charId,
        voiceId: s.voiceId,
        source: s.source,
        para: typeof s.para === 'number' ? s.para : 0,
      };
      if (typeof s.confidence === 'number') out.confidence = s.confidence;
      if (typeof s.uncertain === 'boolean') out.uncertain = s.uncertain;
      return out;
    }),
  };
}

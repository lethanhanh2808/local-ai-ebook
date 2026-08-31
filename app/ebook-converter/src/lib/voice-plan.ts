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
}

export interface VoicePlan {
  bookId: string;
  chapterIndex: number;
  sentences: VoicePlanSentence[];
  sourceMtime: number;
}

/** Split a single cleaned paragraph string into sentences.
 *  Vietnamese sentence terminators: . ! ? … and closing quotes. We keep the
 *  terminator attached to the sentence. Very short fragments (e.g. a lone "Ừ")
 *  are kept as their own sentence so dialogue one-liners stay editable. */
export function splitParagraphIntoSentences(text: string): string[] {
  const out: string[] = [];
  // Match a run of text up to and including a sentence terminator. We allow
  // trailing closing quotes/parens to be captured with the sentence.
  const re = /[^.!?…]+[.!?…]?(?:["”'’»])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
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
 *  dialogue). Mirrors the lightweight quote detection in attribution.ts. */
function sentenceHasQuote(text: string): boolean {
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

  const sentences: VoicePlanSentence[] = [];
  let i = 0;
  for (const p of paragraphs) {
    const paraAttr = convMap[p.index] ?? regexMap[p.index];
    const speakerName = paraAttr?.speaker ?? null;
    const charId = speakerName ? nameToCharId[speakerName.toLowerCase()] ?? null : null;

    const paraSentences = splitParagraphIntoSentences(p.text);
    for (const s of paraSentences) {
      // A sentence is suggested as a character only when the paragraph was
      // attributed to a known character AND the sentence actually contains a
      // quote (dialogue). Narration that merely mentions a character must not
      // trigger that character's voice.
      const isDialogue = sentenceHasQuote(s);
      const suggestedCharId = charId && isDialogue ? charId : null;
      sentences.push({
        i: i++,
        text: s,
        charId: suggestedCharId,
        voiceId: null, // default: narration voice until the user assigns one
        source: suggestedCharId ? 'character' : 'narration',
        para: p.index,
      });
    }
  }

  return { bookId, chapterIndex, sentences, sourceMtime };
}

/** Serialise a plan to the JSON stored in ChapterVoicePlan.sentences. */
export function serializePlan(plan: VoicePlan): string {
  return JSON.stringify(
    plan.sentences.map((s) => ({
      i: s.i,
      text: s.text,
      charId: s.charId,
      voiceId: s.voiceId,
      source: s.source,
      para: s.para,
    })),
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
  }>;
  return {
    bookId,
    chapterIndex,
    sourceMtime,
    sentences: raw.map((s) => ({
      i: s.i,
      text: s.text,
      charId: s.charId,
      voiceId: s.voiceId,
      source: s.source,
      para: typeof s.para === 'number' ? s.para : 0,
    })),
  };
}

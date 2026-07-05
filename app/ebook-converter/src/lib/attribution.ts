// src/lib/attribution.ts
//
// Shared Vietnamese speaker-attribution engine.
//
// The old parser/regex/LLM layers are still available and are now treated as
// evidence by a stateful conversation pass. That pass walks a whole chapter in
// order and keeps scene memory, active participants, dialogue turns, pronoun
// role hints, and a small event timeline.
//
//   1. VnCoreNLP parser (Tier 3b) — dependency parse → (subject, verb) per
//      sentence. Resolves paragraphs like "Anh đánh nhẹ cô" where the speaker
//      is a bare pronoun used as sub-of-verb.
//   2. Regex fallback — the existing 2-pass engine (name + speech verb
//      attribution window). Used when the parser is unreachable OR when the
//      parse has no subject.
//   3. LLM fallback (Tier 3a) — oMLX / MiniMax for zero-anaphora paragraphs
//      where the speaker is dropped entirely ("Còn nói nữa!"). Only used
//      when invoked from the /attribute/analyze route; the cheap /attribute
//      GET route skips this layer.
//
// Public API:
//   - callParser(text)              → POST VnCoreNLP service
//   - sliceParagraphs(html)         → HTML → paragraph ranges
//   - attributeByParse(...)         → parser walker (paragraphs → map)
//   - attributeByRegex(...)         → regex walker (paragraphs → map)
//   - attributeByLLM(...)           → oMLX walker (paragraphs → map)
//   - attributeByConversation(...)  → stateful weighted evidence fusion
//   - mergeAttribution(p, r, l)     → combine the three maps
//   - buildGenderByChar(chars)      → pronoun→gender map
//   - Types and constants
//
import { chatJSON } from '@/lib/ai';
import { nameCanonical, g2pMatch } from '@/lib/vi-text-qa';
import type {
  AttributionEvidence,
  ChapterAttributionMap,
  ConversationStateSnapshot,
  ParagraphAttribution,
} from '@/lib/db/chapter-attribution';

// Re-export for callers that want to construct attribution rows without
// importing from the DB layer.
export type { ChapterAttributionMap, ParagraphAttribution };

// ── Config ──────────────────────────────────────────────────────────────
export const PARSER_URL = process.env.VNCORENLP_URL ?? 'http://vncorenlp:5030';
export const ATTRIBUTION_VERSION = 'conversation-v1+vncorenlp-1.2';
export const ATTRIBUTION_VERSION_LLM = 'conversation-v1+vncorenlp-1.2+llm';
const PARSER_TIMEOUT_MS = 25000;       // per-call wall clock
const PARSER_CONNECT_TIMEOUT_MS = 2000; // fail fast when container is down

/** Max number of unresolved paragraphs we send to the LLM per chapter.
 *  Beyond this, even the LLM can't reliably resolve long stretches of
 *  zero-anaphora — better to let them default to the narrator voice than
 *  to burn minutes on speculative inference. */
export const LLM_MAX_PARAGRAPHS = 80;
/** Number of paragraphs per LLM request. Small enough to fit the prompt
 *  comfortably in the context window; large enough to amortize overhead. */
export const LLM_BATCH_SIZE = 4;
/** Concurrent LLM batches in flight. Keep low so we don't overwhelm oMLX. */
export const LLM_CONCURRENCY = 2;

// ── Vietnamese pronoun → gender (mirror of VOICE_GENDER in EbookReader.tsx) ─
const FEMALE_PRONOUNS = /\b(?:cô|chị|bà|em gái|con gái|nàng|nữ)\b/iu;
const MALE_PRONOUNS = /\b(?:anh|ông|chú|bác|em trai|con trai|chàng|nam)\b/iu;
const FEMALE_PRONOUN_TEXT = '(?:cô|chị|bà|em gái|con gái|nàng|nữ)';
const MALE_PRONOUN_TEXT = '(?:anh|ông|chú|bác|em trai|con trai|chàng|nam)';
const FEMALE_PRONOUN_WORDS = new Set(['cô', 'chị', 'bà', 'em gái', 'con gái', 'nàng', 'nữ']);
const MALE_PRONOUN_WORDS = new Set(['anh', 'ông', 'chú', 'bác', 'em trai', 'con trai', 'chàng', 'nam']);

const SPEECH_VERBS = new Set([
  'nói', 'hỏi', 'đáp', 'kêu', 'thì_thầm', 'quát', 'hét', 'lẩm_bẩm',
  'nói_nhỏ', 'cười_nói', 'trả_lời', 'gọi', 'thét', 'lên_tiếng',
  'quát_tháo', 'cất_tiếng', 'mở_miệng', 'cất_giọng', 'la_lên',
  'hỏi_han', 'gào', 'kêu_gào', 'tiếp_lời', 'nói_tiếp', 'nói_khẽ',
  'khẽ_nói', 'hỏi_lại', 'hỏi_thăm', 'bảo', 'đọc', 'kể', 'xướng',
  'hát', 'hỏi_rằng', 'nói_rằng', 'nói_với', 'nói_thầm', 'phát_biểu',
  'giải_thích', 'giảng_giải', 'xung_phong', 'reo_lên', 'hét_lên',
]);

/** POS tags that name a speaker: nouns, proper nouns, pronouns. */
const SUBJECT_OK_POS = new Set(['N', 'Np', 'V', 'R', 'A']);

/** Quote regex (mirror of EbookReader). Must match U+201C/U+201D curly quotes
 *  — Vietnamese EPUBs use these, not ASCII straight. */
const QUOTE_OPEN_RE  = /["“”'‘'「『]/;
const QUOTE_CLOSE_RE = /["“”'‘'」』]/;

interface QuoteSpan { start: number; end: number; }
function findQuoteSpans(text: string): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (!QUOTE_OPEN_RE.test(text[i])) { i++; continue; }
    const start = i;
    i++;
    while (i < text.length && !QUOTE_CLOSE_RE.test(text[i])) i++;
    if (i >= text.length) break;
    spans.push({ start, end: i + 1 });
    i++;
  }
  return spans;
}

export interface ParsedToken {
  index: number;
  form: string;
  posTag?: string | null;
  nerLabel?: string | null;
  head?: number | null;
  depLabel?: string | null;
}
export interface ParsedSentence { tokens: ParsedToken[]; }

/** POST { text } to the VnCoreNLP service. Returns the sentences array on
 *  success; null when the service is unreachable. Never throws. */
export async function callParser(
  text: string,
): Promise<{ sentences: ParsedSentence[]; cached: boolean; elapsedMs: number } | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PARSER_TIMEOUT_MS);
  try {
    const r = await fetch(`${PARSER_URL}/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, annotators: ['wseg', 'pos', 'parse'] }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json() as { sentences?: ParsedSentence[]; cached?: boolean; elapsed_ms?: number };
    return {
      sentences: Array.isArray(data.sentences) ? data.sentences : [],
      cached: !!data.cached,
      elapsedMs: data.elapsed_ms ?? 0,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Find the subject of `verbForm` in a single sentence. Returns the matching
 *  token form, or null. We accept any token whose depLabel is 'sub' AND whose
 *  head points at verbForm. If multiple subjects exist, prefer Np > N > A > R. */
function findSubjectFor(sent: ParsedSentence, verbForm: string): ParsedToken | null {
  const verbIdx = sent.tokens.findIndex((t) => t.form === verbForm && SUBJECT_OK_POS.has(t.posTag ?? ''));
  if (verbIdx < 0) return null;
  const verbToken = sent.tokens[verbIdx];
  let best: ParsedToken | null = null;
  let bestScore = -1;
  for (const tok of sent.tokens) {
    if (!tok.depLabel) continue;
    if (tok.head !== verbToken.index) continue;
    const dl = tok.depLabel.toLowerCase();
    if (dl !== 'sub' && dl !== 'nsubj' && dl !== 'nsubj:pass') continue;
    let score = 0;
    switch (tok.posTag) {
      case 'Np': score = 4; break;        // proper noun → strongest
      case 'N':  score = 3; break;        // common noun
      case 'A':  score = 2; break;        // adjective used as head
      case 'R':  score = 1; break;        // pronoun
      default:   score = 0;
    }
    if (score > bestScore) { best = tok; bestScore = score; }
  }
  return best;
}

/** Find the ROOT verb of a sentence — VnCoreNLP uses head=0 for the root. */
function findRootVerb(sent: ParsedSentence): ParsedToken | null {
  for (const tok of sent.tokens) {
    if (tok.head === 0 && tok.posTag === 'V' && tok.depLabel === 'root') return tok;
  }
  // Fallback: head=0 V with any depLabel
  for (const tok of sent.tokens) {
    if (tok.head === 0 && tok.posTag === 'V') return tok;
  }
  return null;
}

/** True if this form looks like a known speech verb (nói / hỏi / kêu / …). */
function isSpeechVerb(form: string): boolean {
  return SPEECH_VERBS.has(form.toLowerCase().replace(/\s+/g, '_'));
}

/** True if `form` is a Vietnamese personal pronoun (Cô / Anh / Em / …). */
function pronounGender(form: string): 'female' | 'male' | null {
  const normalized = form.toLowerCase().trim();
  if (FEMALE_PRONOUN_WORDS.has(normalized)) return 'female';
  if (MALE_PRONOUN_WORDS.has(normalized)) return 'male';
  if (new RegExp(`(?:^|[^\\p{L}])${FEMALE_PRONOUN_TEXT}(?=$|[^\\p{L}])`, 'iu').test(normalized)) return 'female';
  if (new RegExp(`(?:^|[^\\p{L}])${MALE_PRONOUN_TEXT}(?=$|[^\\p{L}])`, 'iu').test(normalized)) return 'male';
  return null;
}

// ── Character map helpers ───────────────────────────────────────────────
export interface CharacterLite {
  name: string;
  aliases: string[];
  gender: string | null;
}
export function buildGenderByChar(
  chars: CharacterLite[],
): Record<string, 'female' | 'male' | 'unknown'> {
  const out: Record<string, 'female' | 'male' | 'unknown'> = {};
  for (const c of chars) {
    const g: 'female' | 'male' | 'unknown' =
      c.gender === 'female' || c.gender === 'male' ? c.gender : 'unknown';
    out[c.name.toLowerCase()] = g;
    for (const a of c.aliases) out[a.toLowerCase()] = g;
  }
  return out;
}

/** Try to map a parsed subject token to a known character (case-insensitive,
 *  alias-aware, diacritic-tolerant). Returns the canonical name when found,
 *  null otherwise. */
export function resolveSubjectToName(
  subjectForm: string,
  knownNames: string[],
  genderByChar: Record<string, 'female' | 'male' | 'unknown'>,
): { name: string; gender: 'female' | 'male' | 'unknown' } | null {
  const norm = subjectForm.toLowerCase().trim();
  if (!norm) return null;
  // 1. Exact match (case-insensitive)
  for (const n of knownNames) if (n.toLowerCase() === norm) {
    return { name: n, gender: genderByChar[n.toLowerCase()] ?? 'unknown' };
  }
  // 2. Prefix match — token is the leading word of a multi-word name
  for (const n of knownNames) if (n.toLowerCase().startsWith(norm) && norm.length >= 2) {
    return { name: n, gender: genderByChar[n.toLowerCase()] ?? 'unknown' };
  }
  // 3. Diacritic-tolerant (g2p) match — last resort for OCR-degraded names
  for (const n of knownNames) {
    if (g2pMatch(n, subjectForm)) {
      return { name: n, gender: genderByChar[n.toLowerCase()] ?? 'unknown' };
    }
  }
  return null;
}

// ── Parser-driven attribution per paragraph ──────────────────────────────
export interface ParagraphRange {
  index: number;
  start: number;
  end: number;
  text: string;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function cleanHtmlText(text: string): string {
  return decodeHtmlEntities(text)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rangesFromTexts(texts: string[]): ParagraphRange[] {
  const out: ParagraphRange[] = [];
  let cursor = 0;
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    out.push({
      index: out.length,
      start: cursor,
      end: cursor + trimmed.length,
      text: trimmed,
    });
    cursor += trimmed.length + 1;
  }
  return out;
}

export function sliceParagraphs(html: string): ParagraphRange[] {
  // Match the reader's getChapterParagraphs() first: visible block elements
  // become the paragraph indices used by detectSpeaker().
  const blockTexts: string[] = [];
  const blockRe = /<(p|h[1-6]|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    const text = cleanHtmlText(block[2]);
    if (text) blockTexts.push(text);
  }
  if (blockTexts.length > 0) return rangesFromTexts(blockTexts);

  const stripped = cleanHtmlText(html);
  if (!stripped) return [];

  const lineTexts = stripped.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lineTexts.length > 1) return rangesFromTexts(lineTexts);

  const sentenceTexts: string[] = [];
  const re = /[^.!?…"”]+[.!?…”"]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const text = m[0].trim();
    if (text) sentenceTexts.push(text);
  }
  return rangesFromTexts(sentenceTexts.length > 0 ? sentenceTexts : [stripped]);
}

/** Reconstruct each sentence's surface text and locate it in the joined
 *  paragraph string. Returns a map sentence_index → paragraph_index. When a
 *  sentence can't be located (e.g. the parser's segmentation disagrees with
 *  ours) we fall back to the sentence immediately preceding the gap. */
function mapSentencesToParagraphs(
  paragraphs: ParagraphRange[],
  sentences: ParsedSentence[],
): number[] {
  const joined = paragraphs.map((p) => p.text).join(' ');
  const paraOfSent: number[] = [];
  let cursor = 0;
  let lastPara = 0;
  for (const sent of sentences) {
    const surface = sent.tokens.map((t) => t.form).join(' ').trim();
    if (!surface) { paraOfSent.push(lastPara); continue; }
    // Find from the current cursor; allow some whitespace tolerance.
    const found = joined.indexOf(surface, cursor);
    let paraIdx: number;
    if (found >= 0) {
      cursor = found + surface.length;
      // Binary-search the paragraph whose [start, end) window contains `found`.
      let lo = 0, hi = paragraphs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (paragraphs[mid].end < found) lo = mid + 1;
        else hi = mid;
      }
      paraIdx = paragraphs[lo] && found >= paragraphs[lo].start ? lo : lastPara;
      lastPara = paraIdx;
    } else {
      paraIdx = lastPara;
    }
    paraOfSent.push(paraIdx);
  }
  return paraOfSent;
}

/** Score the parser output per paragraph. Returns an attribution map for the
 *  paragraphs the parser could resolve. */
export function attributeByParse(
  paragraphs: ParagraphRange[],
  sentences: ParsedSentence[],
  knownNames: string[],
  genderByChar: Record<string, 'female' | 'male' | 'unknown'>,
): ChapterAttributionMap {
  const paraOfSent = mapSentencesToParagraphs(paragraphs, sentences);

  const out: ChapterAttributionMap = {};
  sentences.forEach((sent, sIdx) => {
    const paragraphIdx = paraOfSent[sIdx];
    if (paragraphIdx === undefined) return;
    const verb = findRootVerb(sent);
    if (!verb) return;
    const subject = findSubjectFor(sent, verb.form);
    if (!subject) return;
    // Only resolve when the verb is a speech verb OR the subject is a known
    // pronoun (because "Anh đánh nhẹ cô" still attributes the quote to Anh
    // when the quote follows). We give parser-level confidence 0.85 for
    // speech verbs and 0.7 for pronoun-as-subject.
    let confidence = 0;
    if (isSpeechVerb(verb.form)) confidence = 0.85;
    else if (pronounGender(subject.form)) confidence = 0.7;
    else return;

    const mapped = resolveSubjectToName(subject.form, knownNames, genderByChar);
    if (mapped) {
      out[paragraphIdx] = {
        speaker: mapped.name,
        confidence,
        source: 'parser',
      };
    } else {
      // Subject is a bare pronoun (Cô/Anh) — store the pronoun's gender
      // so the regex layer can fill in the canonical name from history.
      const g = pronounGender(subject.form);
      if (g) {
        out[paragraphIdx] = {
          speaker: null,
          confidence: confidence * 0.5,  // partial credit
          source: 'parser',
        };
      }
    }
  });
  return out;
}

// ── Regex fallback (subset of EbookReader's 6-pass engine) ───────────────
/** Find the closest name + speech-verb match in the BEFORE window of a quote.
 *  Mirror of findSpeakerForQuote() from EbookReader.tsx — kept simple here
 *  because the parser handles the hard cases. */
function regexFindSpeaker(
  paragraphText: string,
  qStart: number, qEnd: number,
  knownNames: string[],
  prevQuoteEnd: number,
): string | null {
  const NO_QUOTE = `[^"“”'「」『』]{0,70}`;
  const namesAlt = [...knownNames].sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!namesAlt) return null;
  const beforeStart = prevQuoteEnd > 0 ? prevQuoteEnd : Math.max(0, qStart - 80);
  const before = paragraphText.slice(beforeStart, qStart);
  // Pattern A: name + speech-verb directly before the quote
  const reSpeech = new RegExp(
    `(?:^|[^\\p{L}])(${namesAlt})(${NO_QUOTE}?)(?:nói|hỏi|đáp|kêu|gọi|thét|la|reo|cất tiếng|mở miệng|tiếp lời|nói rằng|khẽ nói|nói khẽ|hỏi rằng|nói với|quát|hét)`,
    'iu',
  );
  const mA = reSpeech.exec(before);
  if (mA) return mA[1];
  // Pattern B: dash attribution after the quote — "..." — Name
  const after = paragraphText.slice(qEnd, Math.min(paragraphText.length, qEnd + 40));
  const reDash = new RegExp(`^\\s*[—–\\-]?\\s*(${namesAlt})\\b`, 'iu');
  const mB = reDash.exec(after);
  if (mB) return mB[1];
  return null;
}

export function attributeByRegex(
  paragraphs: ParagraphRange[],
  knownNames: string[],
): ChapterAttributionMap {
  const out: ChapterAttributionMap = {};
  for (const p of paragraphs) {
    const quotes = findQuoteSpans(p.text);
    if (quotes.length === 0) continue;
    for (let i = quotes.length - 1; i >= 0; i--) {
      const q = quotes[i];
      const prevEnd = i - 1 >= 0 ? quotes[i - 1].end : 0;
      const speaker = regexFindSpeaker(p.text, q.start, q.end, knownNames, prevEnd);
      if (speaker) {
        out[p.index] = { speaker, confidence: 0.55, source: 'regex' };
        break;
      }
    }
  }
  return out;
}

// ── LLM fallback (Tier 3a) ──────────────────────────────────────────────

export interface LLMAttributionInput {
  paragraphs: ParagraphRange[];
  unresolvedIndices: number[];   // paragraph indices the prior layers missed
  knownNames: string[];
  characterContext: {
    name: string;
    aliases: string[];
    gender: string | null;
  }[];
  /** Already-resolved attribution from the parser + regex layers. Used to
   *  populate `prevSpeaker` context for each LLM batch. */
  parserOut: ChapterAttributionMap;
  regexOut: ChapterAttributionMap;
}

/** Result of one batched LLM call. Entries have already been validated
 *  against `knownNames` via g2pMatch — invalid entries are dropped. */
export interface LLMAttributionResult {
  /** paragraphIdx → attribution row */
  map: ChapterAttributionMap;
  /** Paragraphs the LLM was asked about but didn't return anything for. */
  unresolved: number[];
  /** True when the call failed entirely (timeout / invalid JSON / provider
   *  error). Caller should mark the whole batch as default. */
  failed: boolean;
}

interface LLMResponseRow {
  paragraphIdx: number;
  speaker?: string | null;
  confidence?: number;
}

/** Build the Vietnamese prompt for one batch. Embeds the speech-verb list
 *  and attribution rules adapted from the Python `_call_omlx_segmenter`
 *  prompt in `app/tts-service/audiobook_generator.py:1015-1047`.
 *
 *  The user message carries:
 *    - the character roster (name + gender + aliases)
 *    - the unresolved paragraphs in this batch, plus a window of ±1 paragraph
 *      context so the LLM can see who just spoke.
 *  The system message asks for a strict JSON array, no preamble.
 */
function buildLLMPrompt(
  batch: ParagraphRange[],
  contextByIdx: Map<number, { prevSpeaker: string | null; nextText: string | null }>,
  characterContext: LLMAttributionInput['characterContext'],
): { system: string; user: string } {
  const system =
    `/nothink\nBạn chuyên gia văn học Việt Nam. Xác định người nói cho mỗi đoạn hội thoại. ` +
    `Trả lời CHỈ bằng JSON array, không giải thích, không markdown.`;

  const charLines = characterContext.map((c) => {
    const gender = c.gender === 'female' ? 'nữ' : c.gender === 'male' ? 'nam' : '?';
    const aliases = c.aliases.length > 0 ? `, biệt danh: ${c.aliases.join(', ')}` : '';
    return `- ${c.name} (${gender}${aliases})`;
  });
  const userLines: string[] = [];
  userLines.push('Nhân vật:');
  userLines.push(charLines.join('\n'));
  userLines.push('');
  userLines.push('Đoạn văn (idx | text | speaker trước | xem trước đoạn sau):');
  for (const p of batch) {
    const ctx = contextByIdx.get(p.index) ?? { prevSpeaker: null, nextText: null };
    const prev = ctx.prevSpeaker ?? '—';
    const next = ctx.nextText ? ` | ${ctx.nextText.slice(0, 80)}` : '';
    const text = p.text.length > 240 ? p.text.slice(0, 240).trimEnd() + '…' : p.text;
    userLines.push(`${p.index} | ${text} | ${prev}${next}`);
  }
  userLines.push('');
  userLines.push('Quy tắc:');
  userLines.push('- Động từ nói/hỏi/đáp/kêu/thì thầm/quát/hét/lẩm bẩm/trả lời/gọi/thét/lên tiếng/cất tiếng/mở miệng/la/gào/tiếp lời/nói tiếp/khẽ nói/hỏi lại → người nói là CHỦ NGỮ.');
  userLines.push('- Tên ở vị trí tân ngữ (sau "nhìn/gọi/trả lời") KHÔNG phải người nói.');
  userLines.push('- Sau dấu chấm, tên mới hoặc đại từ mới (cô/anh/chị/em) thường là chủ ngữ mới.');
  userLines.push('- Đại từ cô/anh/chị/em/bà/ông → tra theo giới tính + speaker gần nhất.');
  userLines.push('- Nếu không chắc chắn → speaker = null.');
  userLines.push('');
  userLines.push('Trả về JSON: [{"paragraphIdx": 12, "speaker": "Y Đằng Ưu Nhi", "confidence": 0.85}, ...]');
  userLines.push('speaker phải nằm trong danh sách nhân vật (kể cả khác dấu).');
  userLines.push('confidence trong khoảng [0, 1].');
  const user = userLines.join('\n');
  return { system, user };
}

/** Validate that a parsed response row refers to a paragraph in the current
 *  batch and that the speaker matches one of `knownNames` (diacritic-tolerant
 *  via g2pMatch). Returns the canonical (or null) speaker on success; null on
 *  failure. */
function validateLLMRow(
  row: LLMResponseRow,
  batch: ParagraphRange[],
  knownNames: string[],
): ParagraphAttribution | null {
  if (typeof row.paragraphIdx !== 'number') return null;
  if (!batch.some((p) => p.index === row.paragraphIdx)) return null;
  const conf = typeof row.confidence === 'number'
    ? Math.max(0, Math.min(1, row.confidence))
    : 0.7;
  // Speaker may be: an exact known name (canonicalized), an alias that
  // g2pMatches one of the known names, an empty string (no speaker), or
  // null / undefined (LLM didn't try).
  let speaker: string | null;
  if (row.speaker == null || row.speaker === '') {
    speaker = null;
  } else {
    const trimmed = row.speaker.trim();
    if (!trimmed) {
      speaker = null;
    } else {
      const exact = knownNames.find((n) => n.toLowerCase() === trimmed.toLowerCase());
      if (exact) {
        speaker = exact;
      } else {
        const fuzzy = knownNames.find((n) => g2pMatch(n, trimmed));
        speaker = fuzzy ?? null;
        // Drop confidence when the LLM produced a name not in the roster —
        // the fuzzy match is our guess, not theirs.
        if (speaker && !exact) speaker = speaker; // keep fuzzy match
      }
    }
  }
  return {
    speaker,
    confidence: speaker ? Math.max(0.5, conf) : 0,  // minimum 0.5 for resolved
    source: 'llm',
  };
}

/** Run the LLM attribution across all unresolved paragraphs.
 *
 *  - Truncates to LLM_MAX_PARAGRAPHS (we don't burn tokens on hopeless runs).
 *  - Batches of LLM_BATCH_SIZE paragraphs.
 *  - Concurrency LLM_CONCURRENCY batches in flight.
 *  - Returns a ChapterAttributionMap of the resolved entries. Entries that
 *    couldn't be resolved fall through to the default voice (caller decides).
 *
 *  Per-batch failure (timeout / bad JSON / schema mismatch) marks the whole
 *  batch as failed → `failedBatches` lets the caller surface a warning. The
 *  function NEVER throws — callers can treat the result as best-effort.
 */
export async function attributeByLLM(
  input: LLMAttributionInput,
): Promise<{ map: ChapterAttributionMap; failedBatches: number; requested: number }> {
  const { paragraphs, unresolvedIndices, knownNames, characterContext } = input;
  if (unresolvedIndices.length === 0 || knownNames.length === 0) {
    return { map: {}, failedBatches: 0, requested: 0 };
  }

  // Truncate to a sane upper bound so a giant chapter doesn't burn 10 minutes
  // on speculative LLM calls. We trust the parser + regex for the rest.
  const toResolve = unresolvedIndices.slice(0, LLM_MAX_PARAGRAPHS);
  const paraByIdx = new Map(paragraphs.map((p) => [p.index, p]));
  const batches: ParagraphRange[][] = [];
  for (let i = 0; i < toResolve.length; i += LLM_BATCH_SIZE) {
    const slice = toResolve.slice(i, i + LLM_BATCH_SIZE)
      .map((idx) => paraByIdx.get(idx))
      .filter((p): p is ParagraphRange => !!p);
    if (slice.length > 0) batches.push(slice);
  }
  if (batches.length === 0) return { map: {}, failedBatches: 0, requested: 0 };

  // Build context window per paragraph: the previous paragraph's text (so
  // the LLM can see "who just spoke" via the merged attribution map),
  // plus a peek at the next paragraph's text.
  const mergedSoFar: ChapterAttributionMap = { ...input.parserOut, ...input.regexOut };
  const contextByIdx = new Map<number, { prevSpeaker: string | null; nextText: string | null }>();
  for (const idx of toResolve) {
    const prevIdx = idx - 1;
    const nextIdx = idx + 1;
    const prev = paraByIdx.get(prevIdx);
    const next = paraByIdx.get(nextIdx);
    const prevResolved = mergedSoFar[prevIdx]?.speaker ?? null;
    contextByIdx.set(idx, {
      prevSpeaker: prev ? prevResolved : null,
      nextText: next ? next.text.slice(0, 80) : null,
    });
  }

  // Run batches with a small concurrency cap.
  const out: ChapterAttributionMap = {};
  let cursor = 0;
  let failedBatches = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const myIdx = cursor++;
      const batch = batches[myIdx];
      // Refresh prevSpeaker context from results already produced by earlier
      // LLM batches so cross-batch pronoun resolution works.
      for (const p of batch) {
        const ctx = contextByIdx.get(p.index);
        if (ctx && ctx.prevSpeaker === null) {
          const prevIdx = p.index - 1;
          const prevResolved = out[prevIdx]?.speaker
            ?? mergedSoFar[prevIdx]?.speaker
            ?? null;
          contextByIdx.set(p.index, { ...ctx, prevSpeaker: prevResolved });
        }
      }
      const { system, user } = buildLLMPrompt(batch, contextByIdx, characterContext);
      try {
        const parsed = await chatJSON<LLMResponseRow[]>({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.1,
          max_tokens: 1024,
          enable_thinking: false,
          timeoutMs: 90_000,
        });
        if (!Array.isArray(parsed)) {
          failedBatches++;
          continue;
        }
        for (const row of parsed) {
          const rowOut = validateLLMRow(row, batch, knownNames);
          if (rowOut && rowOut.speaker) {
            out[row.paragraphIdx] = rowOut;
          }
        }
      } catch {
        // Bad JSON, timeout, provider error — mark this batch as failed.
        // Don't poison other batches.
        failedBatches++;
      }
    }
  };
  const workers = Array.from({ length: Math.min(LLM_CONCURRENCY, batches.length) }, () => worker());
  await Promise.all(workers);
  return { map: out, failedBatches, requested: toResolve.length };
}

// ── Stateful conversation fusion ────────────────────────────────────────

type CharacterGender = 'female' | 'male' | 'unknown';

interface CharacterProfile {
  name: string;
  aliases: string[];
  gender: CharacterGender;
}

interface Mention {
  name: string;
  start: number;
  end: number;
  objectLike: boolean;
}

interface ActiveCharacter {
  score: number;
  lastMentionParagraph: number;
  spokenCount: number;
}

interface DialogueTurn {
  paragraphIndex: number;
  speaker: string;
}

interface ConversationState {
  sceneId: number;
  activeCharacters: Map<string, ActiveCharacter>;
  currentSpeaker: string | null;
  previousSpeaker: string | null;
  currentFocusCharacter: string | null;
  lastActionCharacter: string | null;
  lastSubject: string | null;
  lastObject: string | null;
  lastRecipient: string | null;
  lastMentionedCharacters: string[];
  dialogueHistory: DialogueTurn[];
  paragraphsSinceDialogue: number;
}

interface ConversationContext {
  profiles: CharacterProfile[];
  aliasToCanonical: Map<string, string>;
  profileByName: Map<string, CharacterProfile>;
  nameRegex: RegExp | null;
}

interface ScoreBucket {
  score: number;
  evidence: AttributionEvidence[];
  explicitWeight: number;
  dominantExplicitSource?: 'parser' | 'regex' | 'llm';
  dominantExplicitWeight: number;
}

export interface ConversationAttributionInput {
  paragraphs: ParagraphRange[];
  characters: CharacterLite[];
  parserOut?: ChapterAttributionMap;
  regexOut?: ChapterAttributionMap;
  llmOut?: ChapterAttributionMap;
}

const TEXT_SPEECH_VERBS =
  '(?:nói|hỏi|đáp|kêu|thì thầm|quát|hét|lẩm bẩm|nói nhỏ|cười nói|trả lời|gọi|thét|lên tiếng|cất tiếng|mở miệng|la lên|gào|tiếp lời|nói tiếp|khẽ nói|nói khẽ|hỏi lại|bảo|kể|reo lên|hét lên|thủ thỉ)';
const TEXT_ACTION_VERBS =
  '(?:gọi|hét|kêu|nói|hỏi|đáp|trả lời|thét|la|reo|than|hừ|hắng giọng|cười|mỉm cười|nhếch mép|quay đầu|ngoái lại|gật|lắc|vẫy|cất tiếng|mở miệng|tiếp lời|nói tiếp|khẽ nói|nói khẽ|thì thầm|thủ thỉ|quát|gào|nhìn|liếc|thở dài|thở ra|ngước|cúi|bước|đứng|ngồi|đi tới|tiến tới)';
const OBJECT_OR_RECIPIENT_RE =
  /\s(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp|trả|đưa|đối với|về phía|phía sau|bên cạnh|trước mặt)\s/iu;
const RECIPIENT_RE = /\s(?:với|cho|nói với|hỏi|đáp|trả lời|gọi)\s/iu;
const SCENE_TRANSITION_RE =
  /(?:^|\s)(?:hôm sau|ngày hôm sau|sáng hôm sau|đêm đó|lúc này|trong khi đó|một lúc lâu sau|vài ngày sau|một lát sau|sau đó|ở một nơi khác|bên ngoài|trong phòng|trên đường)(?:\s|[,.:;!?…]|$)/iu;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildConversationContext(chars: CharacterLite[]): ConversationContext {
  const profiles: CharacterProfile[] = chars.map((c) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    gender: c.gender === 'female' || c.gender === 'male' ? c.gender : 'unknown',
  }));
  const aliasToCanonical = new Map<string, string>();
  const profileByName = new Map<string, CharacterProfile>();
  const aliases: string[] = [];
  for (const profile of profiles) {
    profileByName.set(profile.name, profile);
    for (const alias of [profile.name, ...profile.aliases]) {
      const key = alias.toLowerCase().trim();
      if (!key) continue;
      aliasToCanonical.set(key, profile.name);
      aliases.push(alias);
    }
  }
  const uniqueAliases = [...new Set(aliases)].sort((a, b) => b.length - a.length);
  const nameRegex = uniqueAliases.length > 0
    ? new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${uniqueAliases.map(escapeRe).join('|')})(?=$|[^\\p{L}\\p{N}_])`, 'giu')
    : null;
  return { profiles, aliasToCanonical, profileByName, nameRegex };
}

function normalizeSpeakerName(speaker: string | null | undefined, ctx: ConversationContext): string | null {
  if (!speaker) return null;
  const exact = ctx.aliasToCanonical.get(speaker.toLowerCase().trim());
  if (exact) return exact;
  const fuzzy = ctx.profiles.find((p) => g2pMatch(p.name, speaker));
  return fuzzy?.name ?? null;
}

function scanMentions(text: string, ctx: ConversationContext): Mention[] {
  if (!ctx.nameRegex) return [];
  const mentions: Mention[] = [];
  ctx.nameRegex.lastIndex = 0;
  for (const m of text.matchAll(ctx.nameRegex)) {
    const raw = m[1];
    const name = ctx.aliasToCanonical.get(raw.toLowerCase());
    if (!name) continue;
    const start = (m.index ?? 0) + m[0].length - raw.length;
    const end = start + raw.length;
    const before = text.slice(Math.max(0, start - 22), start);
    mentions.push({
      name,
      start,
      end,
      objectLike: OBJECT_OR_RECIPIENT_RE.test(before),
    });
  }
  return mentions;
}

function latestUniqueMentions(mentions: Mention[], limit = 4): string[] {
  const out: string[] = [];
  for (let i = mentions.length - 1; i >= 0 && out.length < limit; i--) {
    const name = mentions[i].name;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function createConversationState(): ConversationState {
  return {
    sceneId: 0,
    activeCharacters: new Map(),
    currentSpeaker: null,
    previousSpeaker: null,
    currentFocusCharacter: null,
    lastActionCharacter: null,
    lastSubject: null,
    lastObject: null,
    lastRecipient: null,
    lastMentionedCharacters: [],
    dialogueHistory: [],
    paragraphsSinceDialogue: 0,
  };
}

function resetScene(state: ConversationState): void {
  state.sceneId += 1;
  state.activeCharacters.clear();
  state.currentSpeaker = null;
  state.previousSpeaker = null;
  state.currentFocusCharacter = null;
  state.lastActionCharacter = null;
  state.lastSubject = null;
  state.lastObject = null;
  state.lastRecipient = null;
  state.lastMentionedCharacters = [];
  state.dialogueHistory = [];
  state.paragraphsSinceDialogue = 0;
}

function decayActiveCharacters(state: ConversationState): void {
  for (const [name, active] of state.activeCharacters) {
    active.score *= 0.88;
    if (active.score < 0.12) state.activeCharacters.delete(name);
  }
}

function touchActive(
  state: ConversationState,
  name: string,
  paragraphIndex: number,
  amount: number,
): void {
  const existing = state.activeCharacters.get(name) ?? {
    score: 0,
    lastMentionParagraph: paragraphIndex,
    spokenCount: 0,
  };
  existing.score = Math.min(1.8, existing.score + amount);
  existing.lastMentionParagraph = paragraphIndex;
  state.activeCharacters.set(name, existing);
}

function shouldStartNewScene(
  paragraph: ParagraphRange,
  hasQuote: boolean,
  state: ConversationState,
): boolean {
  if (paragraph.index === 0) return false;
  if (hasQuote) return false;
  const text = paragraph.text.trim();
  if (state.paragraphsSinceDialogue >= 4 && text.length > 650) return true;
  if (text.length > 950) return true;
  return SCENE_TRANSITION_RE.test(text);
}

function detectTimelineRoles(
  text: string,
  mentions: Mention[],
): {
  subject: string | null;
  object: string | null;
  recipient: string | null;
  actor: string | null;
} {
  let subject: string | null = null;
  let object: string | null = null;
  let recipient: string | null = null;
  let actor: string | null = null;
  const actionRe = new RegExp(`^.{0,80}(?:${TEXT_SPEECH_VERBS}|${TEXT_ACTION_VERBS})`, 'iu');
  for (const mention of mentions) {
    const tail = text.slice(mention.end, Math.min(text.length, mention.end + 100));
    const before = text.slice(Math.max(0, mention.start - 24), mention.start);
    if (mention.objectLike) {
      object = mention.name;
      if (RECIPIENT_RE.test(before)) recipient = mention.name;
      continue;
    }
    subject = mention.name;
    if (actionRe.test(tail)) actor = mention.name;
  }
  return { subject, object, recipient, actor };
}

function snapshotState(state: ConversationState): ConversationStateSnapshot {
  const activeCharacters = [...state.activeCharacters.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 6)
    .map(([name]) => name);
  return {
    sceneId: state.sceneId,
    activeCharacters,
    currentSpeaker: state.currentSpeaker,
    previousSpeaker: state.previousSpeaker,
    currentFocusCharacter: state.currentFocusCharacter,
    lastActionCharacter: state.lastActionCharacter,
    lastMentionedCharacters: state.lastMentionedCharacters,
    dialogueHistory: state.dialogueHistory.slice(-6),
  };
}

function addScore(
  scores: Map<string, ScoreBucket>,
  speaker: string,
  weight: number,
  evidence: AttributionEvidence,
): void {
  const bucket = scores.get(speaker) ?? {
    score: 0,
    evidence: [],
    explicitWeight: 0,
    dominantExplicitWeight: 0,
  };
  bucket.score += weight;
  bucket.evidence.push({ ...evidence, speaker, weight });
  if (evidence.source === 'parser' || evidence.source === 'regex' || evidence.source === 'llm') {
    bucket.explicitWeight += weight;
    if (weight > bucket.dominantExplicitWeight) {
      bucket.dominantExplicitWeight = weight;
      bucket.dominantExplicitSource = evidence.source;
    }
  }
  scores.set(speaker, bucket);
}

function resolvePronounFromState(
  text: string,
  state: ConversationState,
  ctx: ConversationContext,
): { speaker: string; weight: number; detail: string } | null {
  const pronounRe = new RegExp(
    `(?:^|(?<=[,。.!?:；。、…—\\-–"'“”]))\\s*`
    + `(${FEMALE_PRONOUN_TEXT}|${MALE_PRONOUN_TEXT})`
    + `(?:\\s+[^,。.!?"'“”「」『』]{0,70})?`
    + `(?:${TEXT_SPEECH_VERBS}|${TEXT_ACTION_VERBS})`,
    'iu',
  );
  const m = pronounRe.exec(text);
  if (!m) return null;
  const pronounText = m[1] ?? m[0];
  const gender = pronounGender(pronounText);
  if (!gender) return null;
  const candidates = [...state.activeCharacters.entries()]
    .filter(([name]) => ctx.profileByName.get(name)?.gender === gender)
    .map(([name, active]) => {
      let score = active.score;
      if (state.lastSubject === name) score += 0.45;
      if (state.lastActionCharacter === name) score += 0.4;
      if (state.currentSpeaker === name) score += 0.25;
      if (state.currentFocusCharacter === name) score += 0.2;
      return { name, score };
    })
    .sort((a, b) => b.score - a.score);
  if (candidates.length === 0) return null;
  const best = candidates[0];
  const unique = candidates.length === 1;
  return {
    speaker: best.name,
    weight: unique ? 0.48 : 0.38,
    detail: unique
      ? `pronoun "${pronounText}" resolves to the only active ${gender} character`
      : `pronoun "${pronounText}" resolves by active scene roles`,
  };
}

function quotedContentLength(text: string, quotes: QuoteSpan[]): number {
  return quotes.reduce((sum, q) => sum + Math.max(0, q.end - q.start - 2), 0);
}

function sourceForBucket(bucket: ScoreBucket): ParagraphAttribution['source'] {
  if (
    bucket.dominantExplicitSource
    && bucket.score - bucket.dominantExplicitWeight < 0.18
  ) {
    return bucket.dominantExplicitSource;
  }
  return 'conversation';
}

function updateStateAfterParagraph(
  state: ConversationState,
  paragraph: ParagraphRange,
  mentions: Mention[],
  roles: ReturnType<typeof detectTimelineRoles>,
  speaker: string | null,
): void {
  for (const mention of mentions) {
    touchActive(state, mention.name, paragraph.index, mention.objectLike ? 0.16 : 0.28);
  }
  state.lastMentionedCharacters = latestUniqueMentions(mentions);
  state.currentFocusCharacter = roles.subject ?? state.lastMentionedCharacters[0] ?? state.currentFocusCharacter;
  state.lastSubject = roles.subject ?? state.lastSubject;
  state.lastObject = roles.object ?? state.lastObject;
  state.lastRecipient = roles.recipient ?? state.lastRecipient;
  state.lastActionCharacter = roles.actor ?? state.lastActionCharacter;

  if (speaker) {
    touchActive(state, speaker, paragraph.index, 0.75);
    const active = state.activeCharacters.get(speaker);
    if (active) active.spokenCount += 1;
    state.previousSpeaker = state.currentSpeaker;
    state.currentSpeaker = speaker;
    state.currentFocusCharacter = speaker;
    state.dialogueHistory.push({ paragraphIndex: paragraph.index, speaker });
    state.dialogueHistory = state.dialogueHistory.slice(-10);
    state.paragraphsSinceDialogue = 0;
  } else {
    state.paragraphsSinceDialogue += 1;
  }
}

export function attributeByConversation(
  input: ConversationAttributionInput,
): ChapterAttributionMap {
  const {
    paragraphs,
    characters,
    parserOut = {},
    regexOut = {},
    llmOut = {},
  } = input;
  const ctx = buildConversationContext(characters);
  if (ctx.profiles.length === 0) return mergeAttribution(parserOut, regexOut, llmOut);

  const state = createConversationState();
  const out: ChapterAttributionMap = {};

  for (const paragraph of paragraphs) {
    decayActiveCharacters(state);
    const quotes = findQuoteSpans(paragraph.text);
    const hasQuote = quotes.length > 0;
    if (shouldStartNewScene(paragraph, hasQuote, state)) resetScene(state);

    const mentions = scanMentions(paragraph.text, ctx);
    const roles = detectTimelineRoles(paragraph.text, mentions);

    if (!hasQuote) {
      updateStateAfterParagraph(state, paragraph, mentions, roles, null);
      continue;
    }

    const scores = new Map<string, ScoreBucket>();
    const parserEntry = parserOut[paragraph.index];
    const regexEntry = regexOut[paragraph.index];
    const llmEntry = llmOut[paragraph.index];

    const parserSpeaker = normalizeSpeakerName(parserEntry?.speaker, ctx);
    if (parserSpeaker) {
      const weight = parserEntry!.confidence >= 0.75 ? 0.72 : 0.5;
      addScore(scores, parserSpeaker, weight, {
        source: 'parser',
        weight,
        detail: `VnCoreNLP subject/verb parse (${Math.round(parserEntry!.confidence * 100)}%)`,
      });
    }
    const regexSpeaker = normalizeSpeakerName(regexEntry?.speaker, ctx);
    if (regexSpeaker) {
      const weight = Math.max(0.45, Math.min(0.58, regexEntry!.confidence || 0.55));
      addScore(scores, regexSpeaker, weight, {
        source: 'regex',
        weight,
        detail: 'nearby speech-verb/name pattern',
      });
    }
    const llmSpeaker = normalizeSpeakerName(llmEntry?.speaker, ctx);
    if (llmSpeaker) {
      const weight = Math.max(0.5, Math.min(0.68, (llmEntry!.confidence || 0.7) * 0.75));
      addScore(scores, llmSpeaker, weight, {
        source: 'llm',
        weight,
        detail: `LLM attribution fallback (${Math.round((llmEntry!.confidence || 0.7) * 100)}%)`,
      });
    }

    for (const [name, active] of state.activeCharacters) {
      const weight = Math.min(0.16, 0.04 + active.score * 0.06);
      addScore(scores, name, weight, {
        source: 'presence',
        weight,
        detail: 'character is active in current scene',
      });
    }

    for (const name of latestUniqueMentions(mentions, 3)) {
      addScore(scores, name, 0.08, {
        source: 'presence',
        weight: 0.08,
        detail: 'character is mentioned in the dialogue paragraph',
      });
    }

    const pronoun = resolvePronounFromState(paragraph.text, state, ctx);
    if (pronoun) {
      addScore(scores, pronoun.speaker, pronoun.weight, {
        source: 'pronoun',
        weight: pronoun.weight,
        detail: pronoun.detail,
      });
    }

    if (roles.actor) {
      addScore(scores, roles.actor, 0.36, {
        source: 'timeline',
        weight: 0.36,
        detail: 'last named actor before/around the quote',
      });
    } else if (state.lastActionCharacter) {
      addScore(scores, state.lastActionCharacter, 0.12, {
        source: 'timeline',
        weight: 0.12,
        detail: 'last actor carried over from event timeline',
      });
    }

    const explicitSpeaker = !!(parserSpeaker || regexSpeaker || llmSpeaker);
    const quoteChars = quotedContentLength(paragraph.text, quotes);
    const narrationChars = Math.max(0, paragraph.text.length - quoteChars);
    const startsWithQuote = QUOTE_OPEN_RE.test(paragraph.text.trim()[0] ?? '');
    const shortTurn = quoteChars > 0 && quoteChars <= 120;
    const implicitTurn = !explicitSpeaker && (startsWithQuote || shortTurn || narrationChars < 80);

    if (implicitTurn && state.currentSpeaker) {
      const activeNames = [...state.activeCharacters.keys()];
      const otherActive = activeNames.filter((name) => name !== state.currentSpeaker);
      if (activeNames.length === 2 && otherActive.length === 1) {
        const other = otherActive[0];
        const previousPrevious = state.dialogueHistory.at(-2)?.speaker ?? null;
        addScore(scores, other, previousPrevious === other ? 0.5 : 0.45, {
          source: 'history',
          weight: previousPrevious === other ? 0.5 : 0.45,
          detail: 'dialogue turn likely alternates between two active speakers',
        });
        addScore(scores, state.currentSpeaker, 0.08, {
          source: 'history',
          weight: 0.08,
          detail: 'possible continuation by previous speaker',
        });
      } else {
        addScore(scores, state.currentSpeaker, 0.38, {
          source: 'history',
          weight: 0.38,
          detail: 'unattributed quote continues previous speaker',
        });
      }
    }

    if (state.currentFocusCharacter) {
      addScore(scores, state.currentFocusCharacter, 0.1, {
        source: 'scene',
        weight: 0.1,
        detail: 'current focus character in scene memory',
      });
    }

    let bestName: string | null = null;
    let bestBucket: ScoreBucket | null = null;
    for (const [name, bucket] of scores) {
      if (!bestBucket || bucket.score > bestBucket.score) {
        bestName = name;
        bestBucket = bucket;
      }
    }

    if (bestName && bestBucket && bestBucket.score >= 0.42) {
      const source = sourceForBucket(bestBucket);
      const evidence = bestBucket.evidence
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8);
      out[paragraph.index] = {
        speaker: bestName,
        confidence: clamp01(bestBucket.score),
        source,
        reason: evidence.map((e) => e.detail).slice(0, 3).join('; '),
        evidence,
        sceneId: state.sceneId,
        state: snapshotState(state),
      };
      updateStateAfterParagraph(state, paragraph, mentions, roles, bestName);
    } else {
      if (parserEntry && !parserSpeaker) {
        out[paragraph.index] = {
          speaker: null,
          confidence: 0.2,
          source: 'parser',
          reason: 'parser saw a possible subject but could not map it to a known character',
          evidence: [{
            source: 'parser',
            speaker: null,
            weight: 0.2,
            detail: 'unresolved parser partial',
          }],
          sceneId: state.sceneId,
          state: snapshotState(state),
        };
      }
      updateStateAfterParagraph(state, paragraph, mentions, roles, null);
    }
  }

  return out;
}

// ── Merge parser + regex + LLM outputs ──────────────────────────────────
export function mergeAttribution(
  parserOut: ChapterAttributionMap,
  regexOut: ChapterAttributionMap,
  llmOut: ChapterAttributionMap = {},
): ChapterAttributionMap {
  const merged: ChapterAttributionMap = {};
  // Collect all keys from all three layers.
  const keys = new Set([
    ...Object.keys(parserOut),
    ...Object.keys(regexOut),
    ...Object.keys(llmOut),
  ].map(Number));
  for (const k of keys) {
    const p = parserOut[k];
    const r = regexOut[k];
    const l = llmOut[k];
    if (p && p.speaker && p.confidence >= 0.75) {
      merged[k] = p;
    } else if (r) {
      // Regex partial or resolved (confidence 0.55) — surface as-is. This
      // mirrors the original behavior so the GET route's cache shape stays
      // identical for paragraphs the regex could resolve.
      merged[k] = r;
    } else if (l && l.speaker) {
      merged[k] = l;
    } else if (p) {
      // Parser flagged but couldn't resolve to a name → preserve the
      // partial-confidence signal so the panel can still show "parser
      // tried this paragraph" without surfacing it as a resolved row.
      merged[k] = { speaker: null, confidence: 0.2, source: 'parser' };
    }
  }
  return merged;
}

// ── Stats helper ─────────────────────────────────────────────────────────
export function computeStats(
  paragraphs: ParagraphRange[],
  attribution: ChapterAttributionMap,
): {
  parserHits: number;
  regexHits: number;
  llmHits: number;
  conversationHits: number;
  defaults: number;
  totalParagraphs: number;
} {
  let parserHits = 0, regexHits = 0, llmHits = 0, conversationHits = 0;
  for (const v of Object.values(attribution)) {
    if (v.speaker && v.source === 'parser') parserHits++;
    else if (v.speaker && v.source === 'regex') regexHits++;
    else if (v.speaker && v.source === 'llm') llmHits++;
    else if (v.speaker && v.source === 'conversation') conversationHits++;
  }
  const resolved = parserHits + regexHits + llmHits + conversationHits;
  const defaults = paragraphs.length - resolved;
  return {
    parserHits,
    regexHits,
    llmHits,
    conversationHits,
    defaults,
    totalParagraphs: paragraphs.length,
  };
}

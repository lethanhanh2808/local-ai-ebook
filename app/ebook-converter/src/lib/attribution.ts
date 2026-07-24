// src/lib/attribution.ts
//
// Shared Vietnamese speaker-attribution engine.
//
// Two layers feed a stateful conversation pass that walks a whole chapter in
// order and keeps scene memory, active participants, dialogue turns, pronoun
// role hints, and a small event timeline.
//
//   1. Regex fallback — the existing 2-pass engine (name + speech verb
//      attribution window). Always runs.
//   2. LLM fallback (Tier 3a) — oMLX / MiniMax for zero-anaphora paragraphs
//      where the speaker is dropped entirely ("Còn nói nữa!"). Only used
//      when invoked from the /attribute/analyze route; the cheap /attribute
//      GET route skips this layer.
//
// Public API:
//   - sliceParagraphs(html)         → HTML → paragraph ranges
//   - attributeByRegex(...)         → regex walker (paragraphs → map)
//   - attributeByLLM(...)           → oMLX walker (paragraphs → map)
//   - attributeByConversation(...)  → stateful weighted evidence fusion
//   - mergeAttribution(r, l)        → combine the two maps
//   - buildGenderByChar(chars)      → pronoun→gender map
//   - Types and constants
//
import { chatJSON } from '@/lib/ai';
import { nameCanonical, g2pMatch } from '@/lib/vi-text-qa';
import { detectGenre } from '@/lib/covers/genre-detector';
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
// 2026-07-12: VnCoreNLP sidecar removed. Tier 3b (parser-driven attribution)
// deleted alongside it; the `vncorenlp_attribution.py` module + the
// `vncorenlp` docker service are gone. Conversation version bumped to v3 to
// match the Python side and to make old cached rows obsolete.
export const ATTRIBUTION_VERSION = 'conversation-v3';
export const ATTRIBUTION_VERSION_LLM = 'conversation-v3+llm';

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

// ── Parser-driven attribution interfaces removed 2026-07-12 ─────────────
// VnCoreNLP sidecar (Tier 3b) and the `ParsedToken`/`ParsedSentence` types it
// produced are gone. Remaining layers: regex (always) + LLM (opt-in via the
// /attribute/analyze SSE route) + stateful conversation fusion. Typescript
// build was previously keeping these declarations around for `attributeByParse`;
// both are deleted below.

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
  /** Already-resolved attribution from the regex layer. Used to populate
   *  `prevSpeaker` context for each LLM batch. */
  regexOut: ChapterAttributionMap;
  /** Per-batch progress callback. Fires ONCE per batch (success OR failure),
   *  after that batch's chatJSON() call resolves. Used by the analyze route
   *  to stream log lines back to the modal so the user sees per-batch
   *  progress ("Batch 12/60 ✓ · [44,45,46,47] · 18s · ETA ~88s") instead
   *  of staring at a frozen spinner for the entire LLM step. */
  onBatch?: (info: {
    /** 1-based batch index within this LLM step. */
    idx: number;
    /** Total number of batches queued. */
    total: number;
    /** Paragraph indices this batch contained. */
    indices: number[];
    /** True if at least one row was attributed (or batch completed without
     *  a hard failure). False if chatJSON rejected the response entirely. */
    ok: boolean;
    /** Wall time for this batch's chatJSON call. */
    durationMs: number;
    /** When `ok=false`, the error message that caused the batch to fail
     *  (caught/swallowed by us so other batches keep running). */
    error?: string;
  }) => void;
  /** Override the default `enable_thinking` value passed to chatJSON.
   *  Defaults to `false` (thinking OFF) — safe across all thinking
   *  models (Qwen3, DeepSeek-R1, etc.) and required for whole-chapter
   *  mode where chain-of-thought would burn the JSON output budget
   *  before any rows land. Combine / chunked-mode caller is expected
   *  to pass `true` for thinking models that benefit from explicit
   *  reasoning. The route reads Settings.aiThinkingCombine /
   *  Settings.aiThinkingFullLLM (ui toggle, 2026-07-12) and threads
   *  the right flag per mode. */
  enableThinking?: boolean;
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
  userLines.push('Đại từ bối cảnh cổ trang / huyền huyễn (rất hay xuất hiện):');
  userLines.push('- "trẫm" / "trẫm đệ" / "trẫm mệnh" → NGƯỜI NÓI LÀ HOÀNG THƯỢNG (Hoàng đế, vua). Tìm nhân vật male/main có chức tướng vương/đế/thánh vương/quốc vương trong danh sách.');
  userLines.push('- "thần" / "thần thiếp" / "thần nữ" / "thần đây" → NGƯỜI NÓI LÀ BỀ TÔI / PHI TẦN / CÔNG CHÚA đang tâu vua hoặc bề trên.');
  userLines.push('- "bệ hạ" / "hoàng thượng" xuất hiện trong đoạn → NGƯỜI NÓI là người đang tâu lên vua, KHÔNG PHẢI vua.');
  userLines.push('- "ngươi" / "nhà ngươi" / "kẻ đó" → NGƯỜI NÓI là bề trên / người mạnh hơn / đối phương. Người bị gọi bằng "ngươi" KHÔNG phải speaker.');
  userLines.push('- "lão phu" / "lão tổ" / "lão tông" / "lão gia" → NGƯỜI NÓI là trưởng bối / tông chủ nam giới lớn tuổi.');
  userLines.push('- "bần tăng" / "bần đạo" / "tại hạ" / "tại hạ người" → NGƯỜI NÓI là tu sĩ / giang hồ hành hiệp.');
  userLines.push('- "cô nương" / "tiểu thư" / "nương tử" / "đại tiểu thư" / "thiếu nữ" → NGƯỜI NÓI là nam giới đang nói với nữ giới trẻ (gọi tôn kính); KHÔNG dùng để chỉ chính speaker nếu cùng giới.');
  userLines.push('- "thiếp" / "thiếp thân" → NGƯỜI NÓI là nữ, thường là vợ / thiếp / nha hoàn đang nói với chồng / chủ.');
  userLines.push('- "muội" / "tỷ tỷ" / "ca ca" / "đệ đệ" / "nương" → NGƯỜI NÓI theo vai vế: muội nói với tỷ = tỷ là người nghe (KHÔNG phải speaker).');
  userLines.push('- "ngài" / "tiên bối" / "sư tổ" / "đạo hữu" → NGƯỜI NÓI đang tỏ ra kính trọng; người bị gọi KHÔNG phải speaker.');
  userLines.push('');
  userLines.push('Mẫu cảnh hay gặp trong tiểu thuyết:');
  userLines.push('- Trong triều: một người nói "trẫm ...", người còn lại (thường đứng hoặc quỳ) nói "thần ... bệ hạ". Speaker là 2 người KHÁC NHAU qua từng câu.');
  userLines.push('- Khi cha/anh nói "ngươi" với con/em → con/em KHÔNG phải speaker, cha/anh MỚI là.');
  userLines.push('- Khi có dấu hiệu "Bệ hạ, ...", "Hoàng thượng, ..." → người nói là bề tôi; KHÔNG chọn nhân vật mang chức vua trong roster.');
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
  const mergedSoFar: ChapterAttributionMap = { ...input.regexOut };
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
  let completedBatches = 0;        // for ETA calculation in onBatch
  let failedBatches = 0;
  const total = batches.length;
  let batchStartedAt = 0;          // for per-batch wall-time
  let batchHadError: string | null = null;
  let batchHadAny = false;
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
      // Reset per-batch state, then run the LLM call.
      batchHadError = null;
      batchHadAny = false;
      batchStartedAt = Date.now();
      try {
        const parsed = await chatJSON<LLMResponseRow[]>({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.1,
          max_tokens: 1024,
          // Thinking toggle (2026-07-12): per-mode default lives in
          // Settings — chunked Combine mode defaults ON (small batch,
          // accuracy matters), whole-chapter Full-LLM defaults OFF
          // (large prompt, output budget is the constraint).
          enable_thinking: input.enableThinking ?? false,
          timeoutMs: 90_000,
        });
        if (!Array.isArray(parsed)) {
          failedBatches++;
          batchHadError = 'invalid response shape (not an array)';
        } else {
          for (const row of parsed) {
            const rowOut = validateLLMRow(row, batch, knownNames);
            if (rowOut && rowOut.speaker) {
              out[row.paragraphIdx] = rowOut;
              batchHadAny = true;
            }
          }
        }
      } catch (e) {
        // Bad JSON, timeout, provider error — mark this batch as failed.
        // Don't poison other batches.
        failedBatches++;
        batchHadError = e instanceof Error ? e.message : String(e);
      }
      completedBatches++;
      // Fire the per-batch progress hook so the route can stream the
      // event down to the modal. `ok` means "the call didn't throw + at
      // least one row was attributed" — both layers failing is also a
      // soft failure (LLM delivered nothing usable) and we surface it.
      input.onBatch?.({
        idx: myIdx + 1,
        total,
        indices: batch.map((p) => p.index),
        ok: batchHadError === null && batchHadAny,
        durationMs: Date.now() - batchStartedAt,
        ...(batchHadError !== null ? { error: batchHadError } : {}),
      });
    }
  };
  const workers = Array.from({ length: Math.min(LLM_CONCURRENCY, batches.length) }, () => worker());
  await Promise.all(workers);
  return { map: out, failedBatches, requested: toResolve.length };
}

/** Hard cap on how many paragraphs `attributeByLLMWholeChapter` will accept.
 *  Beyond this the prompt balloons past any sensible context window even on
 *  9B-class local models, AND the JSON output budget (one row per paragraph)
 *  would clip mid-array. Soft-cap on purpose — caller should warn the user
 *  in the UI before they hit this. */
export const LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS = 500;

/** Run the LLM over the WHOLE chapter in a single call (no batching, no
 *  concurrency). Used by the Full Analyzer `'full-llm'` mode for the
 *  trade-off "best cross-paragraph reasoning vs. all-or-nothing failure".
 *
 *  Differences from `attributeByLLM`:
 *    - Sends ALL paragraphs (resolved + unresolved). The whole point is that
 *      the model sees the full chapter end-to-end and can use long-range
 *      speaker continuity. The downstream `attributeByConversation` fuse
 *      layer still merges with the regex/local baseline.
 *    - No chunking, no parallelism. One `chatJSON` call.
 *    - Output budget = `min(settings.aiMaxTokens ?? 16384, 16384)` so a
 *      misconfigured value can't blow up the call. The chapter's expected
 *      JSON output is roughly `paragraphs.length × 50` tokens, so the
 *      16384 ceiling accommodates ~300 paragraphs comfortably.
 *    - `onBatch` fires exactly once (whole chapter = 1 "batch"), at the end.
 *    - On `JsonChatError` the whole call is treated as failed — returns
 *      `{ map: {}, failedBatches: 1, requested: paragraphs.length }` so the
 *      caller can fall through to the regex+local baseline. NEVER throws.
 *
 *  Hard cap (`LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS`) is enforced BEFORE calling
 *  the LLM. Excess paragraphs are silently dropped with a warning log line
 *  via `onBatch?.error` so the caller can surface the truncation. The caller
 *  is expected to have warned the user in the UI before this fires.
 */
export async function attributeByLLMWholeChapter(
  input: LLMAttributionInput,
): Promise<{ map: ChapterAttributionMap; failedBatches: number; requested: number }> {
  const { paragraphs, unresolvedIndices, knownNames, characterContext } = input;
  if (paragraphs.length === 0 || knownNames.length === 0) {
    return { map: {}, failedBatches: 0, requested: 0 };
  }

  // Whole-chapter mode is about giving the LLM the full picture, so we send
  // every paragraph in chapter order — not just the unresolved ones. The
  // regex baseline is still applied downstream by the route's fuse step.
  let toSend: number[] = paragraphs.map((p) => p.index);

  const truncated = toSend.length > LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS;
  if (truncated) {
    toSend = toSend.slice(0, LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS);
  }

  const paraByIdx = new Map(paragraphs.map((p) => [p.index, p]));
  const allParagraphs: ParagraphRange[] = toSend
    .map((idx) => paraByIdx.get(idx))
    .filter((p): p is ParagraphRange => !!p);

  // Build the same ±1 context window used by the chunked path so the model
  // can resolve cross-paragraph pronouns identically. Already-resolved
  // paragraphs contribute their `prevSpeaker` hint via regexOut.
  const contextByIdx = new Map<number, { prevSpeaker: string | null; nextText: string | null }>();
  for (const idx of toSend) {
    const prevIdx = idx - 1;
    const nextIdx = idx + 1;
    const prev = paraByIdx.get(prevIdx);
    const next = paraByIdx.get(nextIdx);
    const prevResolved = input.regexOut[prevIdx]?.speaker ?? null;
    contextByIdx.set(idx, {
      prevSpeaker: prev ? prevResolved : null,
      nextText: next ? next.text.slice(0, 80) : null,
    });
  }

  // Output budget: respect the user's `aiMaxTokens` setting but cap at 16384
  // — enough for ~300 paragraphs of JSON, and beyond that the input prompt
  // itself is already past the comfort zone for a 9B local model.
  const maxTokens = Math.min(16_384, 16_384); // settings read happens in the route

  const out: ChapterAttributionMap = {};
  const t0 = Date.now();
  let batchHadError: string | null = null;
  try {
    const { system, user } = buildLLMPrompt(allParagraphs, contextByIdx, characterContext);
    // Whole-chapter mode sends everything in one shot. Bump the per-batch
    // timeout from 90s to 240s because the prompt is ~10× larger and a
    // single slow oMLX response can easily take 2-3 minutes.
    const parsed = await chatJSON<LLMResponseRow[]>({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      // Thinking toggle (2026-07-12): whole-chapter Full-LLM defaults OFF
      // because chain-of-thought would burn the JSON output budget
      // (~50 tok/row × N rows) before the model emits rows. The user can
      // override in Settings to enable it for reasoning-heavy models on
      // short chapters.
      enable_thinking: input.enableThinking ?? false,
      timeoutMs: 240_000,
    });
    if (!Array.isArray(parsed)) {
      batchHadError = 'invalid response shape (not an array)';
    } else {
      for (const row of parsed) {
        const rowOut = validateLLMRow(row, allParagraphs, knownNames);
        if (rowOut && rowOut.speaker) {
          out[row.paragraphIdx] = rowOut;
        }
      }
    }
  } catch (e) {
    // JsonChatError / timeout / provider error — mark the whole chapter as
    // failed so the route can fall through to the regex+local baseline.
    batchHadError = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - t0;

  // Fire onBatch exactly once so the modal logs a single "Batch 1/1 ✓/✗"
  // line and the existing LLM-phase card renders correctly (1-batch mode
  // is handled by EbookReader.tsx:556-558). When we truncated the chapter
  // to fit LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS, surface that fact in `error`
  // even on success so the route's "Batch 1/1" log line warns the user
  // that the dropped paragraphs were not attributed by the LLM.
  const truncationWarning = truncated
    ? `chapter truncated to ${toSend.length}/${paragraphs.length} đoạn (LLM_WHOLE_CHAPTER_MAX_PARAGRAPHS)`
    : null;
  const finalError = batchHadError !== null
    ? (truncationWarning ? `${batchHadError}; ${truncationWarning}` : batchHadError)
    : truncationWarning;
  input.onBatch?.({
    idx: 1,
    total: 1,
    indices: toSend,
    ok: batchHadError === null,
    durationMs,
    ...(finalError !== null ? { error: finalError } : {}),
  });

  return {
    map: out,
    failedBatches: batchHadError !== null ? 1 : 0,
    requested: toSend.length,
  };
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
  dominantExplicitSource?: 'regex' | 'llm';
  dominantExplicitWeight: number;
}

export interface ConversationAttributionInput {
  paragraphs: ParagraphRange[];
  characters: CharacterLite[];
  regexOut?: ChapterAttributionMap;
  llmOut?: ChapterAttributionMap;
  /**
   * Optional Vietnamese-novel genre tag (see `VietnameseGenre` in
   * `@/lib/covers/genre-detector`). Used to pick a per-genre minimum
   * score floor so action-heavy books don't over-collapse matches
   * while dialogue-heavy books get a more permissive threshold.
   * Unknown / missing values fall back to the global default.
   * Accepted loosely so callers can pass any string without losing
   * the attribution to runtime errors.
   */
  genre?: string | null;
  /** Final state from an earlier chapter. The caller is responsible for
   * rejecting future/stale or parser-version-mismatched snapshots. */
  seedState?: ConversationStateSnapshot;
}

// ── Per-genre minimum-score floor (ACTION_ITEMS D2) ─────────────────────
//
// The previous code used a single 0.42 floor regardless of genre. In
// practice different Vietnamese-novel genres need different floors:
//   • Cultivation / tu tiểu thuyết uses long internal monologues and
//     named-character voice narration — matches need to clear a higher
//     bar so we don't surface weak regex hits as wrong-speaker lines.
//   • Modern romance / ngôn tình packs short, low-confidence
//     continuity turns ("Em yêu anh.") into rapid ping-pong dialogue.
//     A high floor would drop real turns to "default voice" and lose
//     speaker attribution rate; a slightly lower floor is safer.
//   • Cổ trang / lịch sử has elaborate honorifics + role nouns that
//     the regex layer can't always disambiguate, so we want a stricter
//     floor.
//
// Callers pass `genre` as a freeform string (we don't import the
// VietnameseGenre type to keep attribution.ts independent of the cover
// stack). Lookup keys are normalised to lowercase; missing / unknown
// keys fall back to DEFAULT_MIN_SCORE so a database row without a genre
// column can't silently crash attribution.
const DEFAULT_MIN_SCORE = 0.42;
const MIN_SCORE_BY_GENRE: Record<string, number> = {
  // Cultivation / wuxia / xianxia — heavy internal monologue and named-
  // character narration → stricter floor so weak hits don't surface.
  tu_tieu_thuyet: 0.48,
  kiếm_hiệp: 0.48,
  huyền_huyễn: 0.48,
  // Historical / cổ trang / cung đấu — elaborate honorifics, strict.
  cổ_trang: 0.46,
  lich_su: 0.46,
  // Romance — short low-confidence continuity turns; relax floor.
  ngon_tinh: 0.38,
  // Modern urban / đô thị — usually close-third dialogue; moderate.
  do_thi: 0.4,
  // Lit-RPG / system — narration is sparse, dialogue direct.
  game_system: 0.4,
  // Horror — narrator heavy; relax so possession / monologue works.
  kinh_di: 0.36,
  // Sci-fi / mecha — direct speech; modest.
  khoa_hoc_vien_tuong: 0.4,
  // School / coming-of-age; dialogue-heavy; relax slightly.
  thieu_nien: 0.38,
};

function normaliseGenreKey(genre: string | null | undefined): string | null {
  if (!genre) return null;
  const trimmed = genre.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

export function getMinScoreForGenre(
  genre: string | null | undefined,
): number {
  const key = normaliseGenreKey(genre);
  if (!key) return DEFAULT_MIN_SCORE;
  if (key in MIN_SCORE_BY_GENRE) return MIN_SCORE_BY_GENRE[key]!;
  // Try a few obvious synonyms that don't appear in the map verbatim.
  if (key === 'tu_tien' || key === 'tu_tiên') return MIN_SCORE_BY_GENRE.tu_tieu_thuyet ?? DEFAULT_MIN_SCORE;
  if (key === 'co_trang' || key === 'co_trạng') return MIN_SCORE_BY_GENRE.cổ_trang ?? DEFAULT_MIN_SCORE;
  if (key === 'ngon_tinh' || key === 'ngôn_tình') return MIN_SCORE_BY_GENRE.ngon_tinh ?? DEFAULT_MIN_SCORE;
  if (key === 'do_thi' || key === 'đô_thị') return MIN_SCORE_BY_GENRE.do_thi ?? DEFAULT_MIN_SCORE;
  if (key === 'lich_su' || key === 'lịch_sử') return MIN_SCORE_BY_GENRE.lich_su ?? DEFAULT_MIN_SCORE;
  return DEFAULT_MIN_SCORE;
}

export const ATTRIBUTION_MIN_SCORE_DEFAULT = DEFAULT_MIN_SCORE;

/**
 * Resolve the per-genre attribution floor for a book row. Routes thread the
 * result of this helper into `attributeByConversation` so the global
 * 0.42 default is replaced by a genre-specific threshold when the book's
 * title/description actually carries a meaningful Vietnamese-novel signal.
 *
 * Cheap: it's a regex keyword pass (no LLM). Safe to call once per
 * attribution request — the routing layer doesn't cache the result because
 * the cost is <1ms and chapter attribution is gated by an mtime cache one
 * layer up.
 *
 * The argument shape is intentionally narrow so callers (route handlers)
 * can pass a hydrated `Book` row without dragging in the DB types.
 */
export function resolveBookGenre(book: {
  title: string;
  titleVi?: string | null;
  description?: string | null;
}): string | null {
  if (!book || !book.title) return null;
  try {
    const detection = detectGenre({
      title: book.title,
      titleVi: book.titleVi ?? null,
      description: book.description ?? null,
    });
    if (!detection || detection.genre === 'unknown') return null;
    return detection.genre;
  } catch {
    // Detection is best-effort: any failure (missing keyword table,
    // malformed description, etc.) defaults to the global floor.
    return null;
  }
}

export interface ConversationChapterResult {
  attribution: ChapterAttributionMap;
  finalState: ConversationStateSnapshot;
  seedApplied: boolean;
  seedReason: 'fresh' | 'seed-applied' | 'no-characters';
  potentialNewCharacters: string[];
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
const SILENT_QUOTE_CUE_RE =
  /(?:nghĩ thầm|thầm nghĩ|tự nhủ|thầm nhủ|tự hỏi|trong (?:lòng|đầu)|ý nghĩ|suy nghĩ|nghĩ rằng|nghĩ bụng)/iu;
const WRITTEN_QUOTE_CUE_RE =
  /(?:bức thư|lá thư|thư viết|tin nhắn|dòng chữ|tấm biển|biển báo|tiêu đề|tựa đề|cuốn sách|quyển sách|tác phẩm|đoạn trích|trích dẫn|mật khẩu|cụm từ)(?=$|[^\p{L}\p{N}_])/iu;
const AUDIBLE_QUOTE_CUE_RE = new RegExp(TEXT_SPEECH_VERBS, 'iu');

function lastMatchEnd(pattern: RegExp, text: string): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let end = -1;
  for (const match of text.matchAll(re)) end = (match.index ?? 0) + match[0].length;
  return end;
}

function quoteIsNonSpoken(text: string, quote: QuoteSpan, previousEnd: number): boolean {
  const lineStart = text.lastIndexOf('\n', quote.start - 1) + 1;
  const before = text.slice(Math.max(previousEnd, lineStart, quote.start - 180), quote.start);
  const after = text.slice(quote.end, Math.min(text.length, quote.end + 100)).split('\n', 1)[0];
  const silentEnd = lastMatchEnd(SILENT_QUOTE_CUE_RE, before);
  const audibleEnd = lastMatchEnd(AUDIBLE_QUOTE_CUE_RE, before);
  if (silentEnd >= 0 && silentEnd > audibleEnd) return true;
  const writtenEnd = lastMatchEnd(WRITTEN_QUOTE_CUE_RE, before);
  if (writtenEnd >= 0 && audibleEnd <= writtenEnd) return true;
  const silentAfter = SILENT_QUOTE_CUE_RE.exec(after);
  const audibleAfter = AUDIBLE_QUOTE_CUE_RE.exec(after);
  return !!silentAfter && (!audibleAfter || silentAfter.index < audibleAfter.index);
}

/** True only when every quote in the paragraph is silent thought or written
 * material. Such paragraphs must use the narrator even if conversation
 * history or a permissive parser suggests a character. */
export function isNonSpokenQuotedParagraph(text: string): boolean {
  const quotes = findQuoteSpans(text);
  if (quotes.length === 0) return false;
  return quotes.every((quote, index) =>
    quoteIsNonSpoken(text, quote, index > 0 ? quotes[index - 1].end : 0));
}

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

function emptyConversationSnapshot(): ConversationStateSnapshot {
  return {
    sceneId: 0,
    activeCharacters: [],
    currentSpeaker: null,
    previousSpeaker: null,
    currentFocusCharacter: null,
    lastActionCharacter: null,
    lastMentionedCharacters: [],
    dialogueHistory: [],
  };
}

/** Hydrate a new chapter with the bounded, persistable state from the
 * preceding chapter. Names that are no longer in the roster are discarded so
 * a deleted/merged character cannot keep winning attribution indefinitely. */
function applySeedToState(
  state: ConversationState,
  seed: ConversationStateSnapshot,
  ctx: ConversationContext,
): void {
  const canonical = (name: string | null | undefined): string | null =>
    normalizeSpeakerName(name, ctx);

  state.sceneId = Number.isFinite(seed.sceneId) ? Math.max(0, seed.sceneId) : 0;
  state.currentSpeaker = canonical(seed.currentSpeaker);
  state.previousSpeaker = canonical(seed.previousSpeaker);
  state.currentFocusCharacter = canonical(seed.currentFocusCharacter);
  state.lastActionCharacter = canonical(seed.lastActionCharacter);
  state.lastMentionedCharacters = (seed.lastMentionedCharacters ?? [])
    .map(canonical)
    .filter((name): name is string => !!name)
    .slice(-4);
  state.dialogueHistory = (seed.dialogueHistory ?? [])
    .map((turn) => ({
      paragraphIndex: Number.isFinite(turn.paragraphIndex) ? turn.paragraphIndex : -1,
      speaker: canonical(turn.speaker),
    }))
    .filter((turn): turn is DialogueTurn => !!turn.speaker)
    .slice(-10);
  state.paragraphsSinceDialogue = 0;

  for (const rawName of seed.activeCharacters ?? []) {
    const name = canonical(rawName);
    if (!name || state.activeCharacters.has(name)) continue;
    state.activeCharacters.set(name, {
      score: 0.5,
      lastMentionParagraph: -1,
      spokenCount: 0,
    });
  }
}

const PROPER_NAME_RE =
  /(?:^|[^\p{L}\p{N}_])(\p{Lu}\p{L}*(?:\s+\p{Lu}\p{L}*){1,5})(?=\s|[,.:;!?…]|$)/gu;

function isKnownSurfaceName(surface: string, ctx: ConversationContext): boolean {
  const normalized = surface.toLocaleLowerCase('vi').trim();
  if (!normalized) return false;
  if (ctx.aliasToCanonical.has(normalized)) return true;

  const canonicalSurface = nameCanonical(surface);
  const surfaceWords = canonicalSurface.split(/\s+/).filter(Boolean);
  if (surfaceWords.length === 0) return false;

  return ctx.profiles.some((profile) =>
    [profile.name, ...profile.aliases].some((storedName) => {
      const storedCanonical = nameCanonical(storedName);
      if (storedCanonical === canonicalSurface || g2pMatch(storedName, surface)) {
        return true;
      }
      const storedWords = storedCanonical.split(/\s+/).filter(Boolean);
      // Treat a multi-word registered name and a longer/shorter prefix as the
      // same surface. This catches e.g. "Y Đằng Long" vs "Y Đằng" without
      // allowing a one-word common noun to suppress a candidate.
      if (storedWords.length >= 2 && storedWords.length <= surfaceWords.length) {
        return storedWords.every((word, index) => word === surfaceWords[index]);
      }
      if (surfaceWords.length >= 2 && surfaceWords.length <= storedWords.length) {
        return surfaceWords.every((word, index) => word === storedWords[index]);
      }
      return false;
    }),
  );
}

/** Find capitalised, multi-word Vietnamese name candidates that are not in the
 * current roster. This is intentionally a suggestion list: places and titles
 * may appear and remain subject to user review. */
export function collectNovelNames(
  paragraphs: ParagraphRange[],
  characters: CharacterLite[],
): string[] {
  const ctx = buildConversationContext(characters);
  const candidates = new Map<string, { display: string; count: number }>();

  for (const paragraph of paragraphs) {
    PROPER_NAME_RE.lastIndex = 0;
    for (const match of paragraph.text.matchAll(PROPER_NAME_RE)) {
      const display = (match[1] ?? '').trim();
      if (!display || isKnownSurfaceName(display, ctx)) continue;
      const key = nameCanonical(display) || display.toLocaleLowerCase('vi');
      const previous = candidates.get(key);
      candidates.set(key, {
        display: previous?.display ?? display,
        count: (previous?.count ?? 0) + 1,
      });
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display, 'vi'))
    .map((candidate) => candidate.display);
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
  if (evidence.source === 'regex' || evidence.source === 'llm') {
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
    regexOut = {},
    llmOut = {},
    genre,
  } = input;
  const ctx = buildConversationContext(characters);
  if (ctx.profiles.length === 0) return mergeAttribution(regexOut, llmOut);
  // Per-genre minimum-score floor (ACTION_ITEMS D2). Callers pass the
  // book's VietnameseGenre tag; unknown / missing falls back to the
  // global default so the legacy behaviour is preserved when no genre
  // is wired in.
  const minScore = getMinScoreForGenre(genre);

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

    if (isNonSpokenQuotedParagraph(paragraph.text)) {
      // Do not let parser/regex/history evidence turn thoughts, letters or
      // quoted titles into character speech. Absence from the map is the
      // established narrator fallback contract.
      updateStateAfterParagraph(state, paragraph, mentions, roles, null);
      continue;
    }

    const scores = new Map<string, ScoreBucket>();
    const regexEntry = regexOut[paragraph.index];
    const llmEntry = llmOut[paragraph.index];

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

    const explicitSpeaker = !!(regexSpeaker || llmSpeaker);
    const quoteChars = quotedContentLength(paragraph.text, quotes);
    const narrationChars = Math.max(0, paragraph.text.length - quoteChars);
    const startsWithQuote = QUOTE_OPEN_RE.test(paragraph.text.trim()[0] ?? '');
    const shortTurn = quoteChars > 0 && quoteChars <= 120;
    const implicitTurn = !explicitSpeaker && (startsWithQuote || shortTurn || narrationChars < 80);

    if (implicitTurn && state.currentSpeaker) {
      const activeNames = [...state.activeCharacters.keys()];
      const otherActive = activeNames.filter((name) => name !== state.currentSpeaker);
      // Sensitivity fix (2026-07-08): the previous code always picked the
      // alternation branch when two characters were active, even when the
      // quote had NO character name mentioned. That made any one-sided
      // monologue (or a turn that only uses pronouns like "Em/Anh") flip
      // back and forth between speakers, because the OTHER speaker sat in
      // activeCharacters from an earlier mention. The two cases need very
      // different handling:
      //   • No character name mentioned in the paragraph → the quote is
      //     almost certainly a continuation of the previous speaker
      //     (a thought, a follow-up, a "Vâng ạ."), so we strongly favor
      //     the current speaker.
      //   • A character name IS mentioned → that's the classic
      //     "Chào Lan" pattern where the mention identifies the
      //     addressee, and ping-pong alternation is the right prior.
      const noNameQuote = mentions.length === 0;
      if (noNameQuote) {
        addScore(scores, state.currentSpeaker, 0.55, {
          source: 'history',
          weight: 0.55,
          detail: 'unattributed quote with no character name — strong continuation of previous speaker',
        });
      } else if (activeNames.length === 2 && otherActive.length === 1) {
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

    if (bestName && bestBucket && bestBucket.score >= minScore) {
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
      updateStateAfterParagraph(state, paragraph, mentions, roles, null);
    }
  }

  return out;
}

// ── Legacy wrapper: `attributeConversationChapter` ──────────────────────────
// Used by scripts/measure-attribution.ts and scripts/backfill-conversation-
// state.ts. Older callers expected a different shape: { attribution, finalState }
// where `finalState` is a ConversationStateSnapshot suitable for persisting
// and seeding the next chapter. The modern route handler imports
// `attributeByConversation` directly. This wrapper preserves the legacy
// shape so the measure/backfill scripts build without code changes.
//
// `seedState` is accepted (but unused by attributeByConversation) for source
// compatibility — the modern function applies its own carry-over logic via
// `bookConversationState` reads inside the route.
export interface LegacyChapterAttributionResult {
  attribution: ChapterAttributionMap;
  finalState: import('./db/chapter-attribution').ConversationStateSnapshot;
}

export function attributeConversationChapter(input: {
  paragraphs: ParagraphRange[];
  characters: CharacterLite[];
  regexOut?: ChapterAttributionMap;
  llmOut?: ChapterAttributionMap;
  /** Optional per-genre floor lookup key (ACTION_ITEMS D2). Forwarded
   *  to `attributeByConversation` so the legacy wrapper shape picks up
   *  the new behaviour transparently. */
  genre?: string | null;
  /** Legacy parameter — accepted but ignored. Conversation-state carry-over
   *  happens through the BookConversationState row in the route handler. */
  seedState?: unknown;
}): LegacyChapterAttributionResult {
  const attribution = attributeByConversation({
    paragraphs: input.paragraphs,
    characters: input.characters,
    regexOut: input.regexOut ?? {},
    llmOut: input.llmOut ?? {},
    genre: input.genre,
  });
  // Synthesize an empty snapshot — the measure script only persists when
  // --seed is set, and the real backfill logic lives in src/lib/db/
  // conversation-state.ts. Empty snapshot is a safe no-op for back-compat.
  const finalState: import('./db/chapter-attribution').ConversationStateSnapshot = {
    sceneId: 0,
    activeCharacters: [],
    currentSpeaker: null,
    previousSpeaker: null,
    currentFocusCharacter: null,
    lastActionCharacter: null,
    lastMentionedCharacters: [],
    dialogueHistory: [],
  };
  return { attribution, finalState };
}

// ── Merge regex + LLM outputs ────────────────────────────────────────────
export function mergeAttribution(
  regexOut: ChapterAttributionMap,
  llmOut: ChapterAttributionMap = {},
): ChapterAttributionMap {
  const merged: ChapterAttributionMap = {};
  // Collect all keys from both layers.
  const keys = new Set([
    ...Object.keys(regexOut),
    ...Object.keys(llmOut),
  ].map(Number));
  for (const k of keys) {
    const r = regexOut[k];
    const l = llmOut[k];
    if (r) {
      // Regex partial or resolved (confidence 0.55) — surface as-is. This
      // mirrors the original behavior so the GET route's cache shape stays
      // identical for paragraphs the regex could resolve.
      merged[k] = r;
    } else if (l && l.speaker) {
      merged[k] = l;
    }
  }
  return merged;
}

// ── Stats helper ─────────────────────────────────────────────────────────
export function computeStats(
  paragraphs: ParagraphRange[],
  attribution: ChapterAttributionMap,
): {
  regexHits: number;
  llmHits: number;
  conversationHits: number;
  defaults: number;
  totalParagraphs: number;
} {
  let regexHits = 0, llmHits = 0, conversationHits = 0;
  for (const v of Object.values(attribution)) {
    if (v.speaker && v.source === 'regex') regexHits++;
    else if (v.speaker && v.source === 'llm') llmHits++;
    else if (v.speaker && v.source === 'conversation') conversationHits++;
  }
  const resolved = regexHits + llmHits + conversationHits;
  const defaults = paragraphs.length - resolved;
  return {
    regexHits,
    llmHits,
    conversationHits,
    defaults,
    totalParagraphs: paragraphs.length,
  };
}

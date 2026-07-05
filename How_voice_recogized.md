# How `voice_recogized` — Reverse-Engineered Technical Report

> Repository: `/Volumes/EXT-SSD/Users/anhl/Local-AI`
> Scope: novel text input → final synthesized audio, covering voice recognition, speaker attribution, character tracking, emotion, TTS, memory and LLM usage.
> Date generated: 2026-07 (post `AI_AUDIOBOOK_README.md` v6 release).
> Last code read: commit-on-disk in this workspace, primarily `app/tts-service/*` and `app/ebook-converter/src/**`.

## 2026-07-05 Implementation Update — Stateful Conversation Attribution

The attribution engine has been redesigned from "first matching layer wins" into a chapter-level stateful conversation fusion pass while preserving the existing parser, regex, LLM, character detection, voice assignment, emotion injection, quote detection, live reader, audiobook generation, and `ChapterAttribution` schema.

### What changed

- Added `attributeByConversation()` in `app/ebook-converter/src/lib/attribution.ts`.
- Added cache algorithm versions:
  - `conversation-v1+vncorenlp-1.2`
  - `conversation-v1+vncorenlp-1.2+llm`
- Cache reads now reject stale rows when `parserVersion` does not match the current algorithm version.
- Server-side `sliceParagraphs()` now matches the reader's visible block extraction (`p`, headings, `li`, `blockquote`) before falling back to sentence splitting. This fixes the old paragraph-index mismatch between `/attribute` and `EbookReader.detectSpeaker()`.
- The live reader still uses the same `/attribute` and `/attribute/analyze` endpoints, but those endpoints now return stateful fusion results.
- The Python audiobook generator now mirrors the conversation state pass inside `_regex_segment_chapter()` so pre-generated audiobooks benefit from the same memory model without calling the Next.js API.
- `CHARACTER_MAP` now includes persisted `Character.gender`, so custom/cloned voices no longer make pronoun resolution blind.
- `VoiceDebugPanel` now displays:
  - `state` source badge for conversation-memory decisions
  - scene id
  - active scene participants
  - reason string
  - top evidence weights

### New conversation state model

The state is maintained per chapter and reset on detected scene boundaries:

```text
ConversationState
  sceneId
  activeCharacters
  currentSpeaker
  previousSpeaker
  dialogueHistory
  currentFocusCharacter
  lastActionCharacter
  lastSubject
  lastObject
  lastRecipient
  lastMentionedCharacters
  paragraphsSinceDialogue
```

Scene boundaries are detected from chapter start, long narration blocks, long gaps since dialogue, and explicit transition phrases such as `hôm sau`, `lúc này`, `trong khi đó`, `một lát sau`, `ở một nơi khác`, `trong phòng`, and `trên đường`.

### Weighted confidence fusion

Parser, regex, and LLM no longer override each other by priority alone. Each source contributes weighted evidence:

| Evidence | Typical weight | Purpose |
| --- | ---: | --- |
| VnCoreNLP named subject/speech verb | 0.72 | Strong grammatical speaker signal |
| VnCoreNLP lower-confidence pronoun/non-speech subject | 0.50 | Useful but not absolute |
| Regex speech-verb/name pattern | 0.45-0.58 | Existing strict local attribution |
| LLM fallback | 0.50-0.68 | Optional high-level ambiguity resolver |
| Active scene presence | up to 0.16 | Bias toward characters currently present |
| Current paragraph mention | 0.08 | Weak local context |
| Pronoun resolved from scene roles | 0.38-0.48 | Replaces "last male/female only" |
| Immediate event actor | 0.36 | Timeline action before/around quote |
| Carried last actor | 0.12 | Weak continuity signal only |
| Two-person dialogue alternation | 0.45-0.50 | Handles ping-pong dialogue without speech verbs |
| Previous-speaker continuation | 0.38 | Handles multi-paragraph continued speech |
| Current scene focus | 0.10 | Weak narrative focus support |

The final row is selected by highest total score with a minimum threshold of `0.42`. If one explicit source dominates and the added state evidence is minor, the row keeps source `parser`, `regex`, or `llm`; otherwise the row source is `conversation`.

### Why the old failures occurred

- **Multi-paragraph dialogue** failed because every quote was resolved independently with no previous speaker memory.
- **Two-person ping-pong dialogue** failed because unattributed quotes had no speech verb/name window.
- **Pronoun-heavy scenes** failed because the previous implementation only remembered the latest male/female mention, often ignoring grammatical role and active scene participants.
- **Multiple same-gender characters** failed because "last female/male" was too coarse and did not account for scene presence, subject/object roles, or focus.
- **Story-context attribution** failed because parser/regex layers only looked at local text windows and could not use prior turns or the event timeline.
- **Live/offline divergence** happened because TypeScript and Python implemented separate attribution logic. They now share the same algorithmic design and evidence weights.

### Current unified architecture

```text
Chapter text
  ↓
Reader-aligned paragraph slicing
  ↓
Parser evidence: VnCoreNLP subject/verb map
  ↓
Regex evidence: existing strict speech-verb/name matcher
  ↓
Stateful conversation fusion
  ├─ scene detection
  ├─ active participant graph
  ├─ dialogue turn tracking
  ├─ event timeline
  ├─ role-aware pronoun resolution
  └─ weighted confidence selection + debug evidence
  ↓
Optional /attribute/analyze LLM fallback for remaining unresolved rows
  ↓
Final speaker → voice mapping → emotion → TTS
```

### Verification added

- `src/tests/attribution.test.ts` covers block-aligned slicing, two-speaker alternation, parser/regex fusion, and pronoun resolution from active scene participants.
- `npx tsc --noEmit` passes.
- `python3 -m py_compile app/tts-service/audiobook_generator.py app/tts-service/vncorenlp_attribution.py` passes.

---

## 1. Overall Architecture

The pipeline is split into a Next.js TypeScript frontend + a Python FastAPI TTS stack. There are two parallel ingestion paths that converge on the same three-layer speaker-attribution engine:

### 1.1 Live Read-Aloud Path (Browser → Server → TTS)

```text
EPUB / HTML / TXT upload
     │
     ▼  BullMQ: ebook-conversion
src/worker/index.ts → conversion-pipeline.ts
     │
     ▼  epub-parser.ts → parseEpub()
data/library/<bookId>.epub  (Book row in SQLite)
     │
     ▼  Reader opens /library/[id]/read
EbookReader.tsx
     │  parses chapter HTML into paragraphs
     │  fetches per-paragraph attribution map
     │
     ├─ /api/library/[id]/chapters/[chapterId]/attribute  (GET, cache-first)
     │     │
     │     ▼ sliceParagraphs(html)
     │       attributeByParse()   ← VnCoreNLP parser (Tier 3b)
     │       attributeByRegex()  ← local regex fallback
     │       mergeAttribution()  ← parser wins ≥ 0.75, regex ≥ 0.55
     │       getOrComputeAttribution()  ← ChapterAttribution table (mtime-keyed)
     │
     │ detectSpeaker(text, paragraphIndex)
     │     ├─ Tier 1: server-side attribution map (parser/regex/llm)
     │     ├─ Tier 2: local 6-pass regex engine (findSpeakerForQuote)
     │     └─ returns { name, voiceName, source }
     │
     │ detectEmotion(text) → adjust speed/noise/expressiveness
     │
     ▼  POST /api/tts  { text, bookId, character?, voice?, speed, emotion, expressiveness, callIdx }
     │     │
     │     ▼ resolveVoiceForCharacter() → builtinName or refAudioPath
     │       emotionMarker() → optional [cười] / [thở dài] / [hắng giọng]
     │       applyEmotionMarker() → require laugh-keyword evidence
     │
     ▼  http://127.0.0.1:5010/synthesize  (unified_server.py)
     │
     ▼  VieNeu :5020 / Piper :5002 / MOSS-Nano (ONNX)
     │
audio/wav → <audio> element
```

### 1.2 Pre-Generated Audiobook Path (BullMQ → Python → Disk)

```text
AudiobookPanel.tsx → POST /api/library/[id]/audiobook  { action: "generate" }
     │
     ▼  BullMQ: ebook-audiobook  (concurrency = 1, 2/60s rate-limit)
src/worker/audiobook.ts
     │
     │  for each chapter in epub.htmlFiles:
     │
     │  computeAudiobookConfigHash() → sha256(voices + characters + backend)
     │  skip chapter if status=ready AND configHash matches
     │
     │  parseEpub() → resolve chapter HTML
     │  listVoices/bookId + listCharacters/bookId + getDefaultVoice()
     │
     │  spawn `python audiobook_generator.py … CHARACTER_MAP=<json>`
     │       ▼
     │ app/tts-service/audiobook_generator.py
     │     │
     │     │ strip_html / WS_RE  → plain text
     │     │
     │     ├─ Tier 3b: vncorenlp_attribution.attribute_chapter()  (parallel parser sidecar)
     │     ├─ Tier 3a (opt-in USE_LLM_SEGMENTER): oMLX segment + emotion
     │     └─ Tier 1 (regex):  _regex_segment_chapter()
     │         ├─ find_quote_spans() → QUOTE_RE
     │         ├─ walk quotes (forward) → emit_narration + dialogue segments
     │         └─ per-quote: find_speaker_for_quote()  (6-pass engine)
     │
     │  resolve voices + emotion injection per segment
     │  synthesize each segment with HTTP /synthesize
     │  concatenate_wavs()  → WAV
     │
     │  convertToMp3() via ffmpeg (96 kbps mono, 24 kHz)
     │
     ▼  data/audiobooks/<bookId>/<chapter>.mp3   (or .wav)
     │
     ▼  AudiobookChapter row  status=ready, audioPath, durationMs, sizeBytes, configHash
```

### 1.3 Top-Level Block Diagram

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                          Browser (EbookReader.tsx)                      │
│  DOMParser → paragraphs → detectSpeaker → prefetch audio → <audio>      │
│        │                                       ↑                        │
│        ▼                                       │                        │
│   /api/library/[id]/chapters/[chapterId]/attribute  (parser + regex)   │
│   /api/tts  →  resolveVoiceForCharacter → /api/tts/preview             │
│                                                                         │
│   /api/library/[id]/characters/detect  (LLM → voice-selector)           │
└─────────────────────────────────────────────────────────────────────────┘
            │                                   │
            ▼                                   ▼
┌────────────────────────┐         ┌──────────────────────────────────────┐
│ app/tts-service/       │         │   app/tts-service/vncorenlp/         │
│  audiobook_generator.py│ ──HTTP─▶│     vncorenlp_server.py  :5030        │
│  (Python)              │ POST    │     py_vncorenlp + JVM (1.2.jar)      │
│  _regex_segment_chapter│ /annotate│     LRU 512 SHA1 cache               │
│  vncorenlp_attribution │         │                                       │
│  character_detector    │         └──────────────────────────────────────┘
└────────────────────────┘                                 │
            │                                              │
            ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            unified_server.py   :5010       (FastAPI router)              │
│   POST /synthesize → pick_backend() → vieneu|piper|moss-nano            │
│   GET  /backends                                                             │
└─────────────────────────────────────────────────────────────────────────┘
       ▼                       ▼                            ▼
┌────────────────────┐  ┌────────────────────────┐  ┌──────────────────────┐
│ vieneu_server.py   │  │ server.py              │  │ onnx_tts_runtime.py  │
│ :5020 (v3 Turbo)   │  │ :5002 (Piper legacy)   │  │ (cpu, MOSS-Nano)     │
│ 10 built-in voices │  │ vi_VN-vais1000-medium  │  │ ONNX 24 kHz          │
│ 48 kHz, ref clone  │  │ 22 kHz                 │  │ non-Vietnamese       │
└────────────────────┘  └────────────────────────┘  └──────────────────────┘
```

**Two independent implementations of the attribution engine** exist (`audiobook_generator.py` in Python, `EbookReader.tsx` + `lib/attribution.ts` in TypeScript) — they must be kept in sync and currently match exactly.

---

## 2. Dialogue Extraction

### 2.1 Quote Detection

**Files:**

- `app/tts-service/audiobook_generator.py` lines 44-50, 197-202 (`QUOTE_RE`, `find_quote_spans()`)
- `app/ebook-converter/src/components/library/EbookReader.tsx` lines 698-716 (`QUOTE_OPEN_RE`, `QUOTE_CLOSE_RE`, `findQuoteSpans()`)
- `app/ebook-converter/src/lib/attribution.ts` lines 75-92 (`QuoteSpan`, `findQuoteSpans`)

**Character classes supported:**

| Engine | Open set | Close set |
| --- | --- | --- |
| Python `QUOTE_OPEN_CHARS` | `\u201c \u300c \u300e "` (curly LEFT, 「, 『, ASCII `"`) | `\u201d \u300d \u300f "` |
| TS `QUOTE_OPEN_RE` | `["“”'‘'「『]` — uses the same set for open and close | `[””'‘'」』]` |

**Behaviour:**

- **Symmetric ASCII**: TS treats the same character class as both open and close for non-ASCII quote chars because curly and Asian bracket pairs appear matched in source. Python uses two distinct sets and matches via a *single non-greedy regex* (`QUOTE_RE`) that captures content in one pass.
- **Span limits (Python):** `3–400` characters inside a single quote (drops single-char tokens like `"?"` that fall outside the range and truncates pathological runs).
- **Nested dialogue: NOT supported.** Both engines greedily scan open→close pair, so nested quotes inside an ongoing speech turn are reduced to a single span — the inner quote is absorbed. This matches the way Vietnamese is typically printed (a paragraph rarely contains nested dialogue in this corpus, but it is the most common mis-attribute cause when present).
- **Em-dash + quote:** detected as a separate quote span because em-dash is between or before the quote characters.

### 2.2 Paragraph Splitting

**Files:**

- `app/tts-service/audiobook_generator.py` lines 205-238 (`split_paragraphs_with_offsets`)
- `app/ebook-converter/src/lib/attribution.ts` lines 237-264 (`sliceParagraphs`)

**Logic:**

- Python: matches `re.finditer(r"[^\n]+(?:\n(?!\s*\n)[^\n]*)*", plain)` — split on **blank lines**, then sentence-boundary split if the resulting single paragraph is longer than 1500 chars.
- TS `sliceParagraphs()`: strips tags, then `re = /[^.!?…"”]+[.!?…”"]?/g` — **splits on sentence-ending punctuation**, NOT on paragraph breaks. Quote-character regex overlaps with the closing punctuation class, so quoted sentences are kept whole.

**Divergence:** the two parsers break a chapter differently. The TS slice produces more entries (one per sentence), the Python slice one per paragraph. The TS path is what the live reader uses; the Python path is what runs offline. Both eventually key results by an offset the consumer can correlate to its own input.

### 2.3 Narration vs Dialogue Boundary

- **Tier 1 (Python regex):** every `<open-quote> ... <close-quote>` span becomes a `kind:"dialogue"` segment. Text between spans becomes `kind:"narration"`. The narration is split at sentence boundaries (`.!?。！？`) and chunked to ≤ `NARRATION_CHUNK_TARGET = 1200` chars.
- **Tier 3a (LLM segmenter, opt-in):** the LLM is explicitly told "*For a quoted span, strip the opening/closing quotes from the text field and use kind=dialogue*" — same rule, but at JSON emission time.
- **Tier 3b (VnCoreNLP):** the parser only influences the **speaker** decision, not the segmentation. The regex chapter splitter still produces the dialogue/narration boundary.

---

## 3. Speaker Attribution

### 3.1 Decision Layers (in order, first-match-wins unless noted)

```
Tier 3b   VnCoreNLP dependency parser  →  CONFIDENCE ≥ 0.85 ALWAYS WINS (post-merge)
Tier 3a   oMLX LLM segmentation        →  CONFIDENCE 0.5+ (opt-in via ENABLE_LLM_SEGMENTER)
Tier 1    local 6-pass regex engine    →  CONFIDENCE 0.55
default   fall back to book default (narrator) voice
```

All three layers write to a single `paragraphIndex → {speaker, confidence, source}` map. Merge logic in `lib/attribution.ts::mergeAttribution()` and `audiobook_generator.py::tier3b override`:

```typescript
if (parserOut[key]?.speaker && parserOut[key].confidence >= 0.75) → parser wins
else if (regexOut[key])                                              → regex wins (0.55)
else if (llmOut[key]?.speaker)                                       → LLM wins
else if (parserOut[key])                                             → flag null/0.2 "parser tried, no name"
```

Both the Python worker and the TS reader see the same `parserVersion: "vncorenlp-1.2"` for the GET route and `"vncorenlp-1.2+llm"` for the POST `/analyze` route.

### 3.2 The 6-Pass Regex Engine

Implemented identically in:

- `app/tts-service/audiobook_generator.py` lines 1218-1449 (`find_speaker_for_quote` + helpers)
- `app/ebook-converter/src/components/library/EbookReader.tsx` lines 942-1133 (`findSpeakerForQuote`)
- Simplified mirror in `app/ebook-converter/src/lib/attribution.ts` lines 357-403 (`regexFindSpeaker`, used by server-side merge fallback)

Window sizes (identical across engines):

| Constant | Value | Purpose |
| --- | ---: | --- |
| `ATTR_WINDOW_BEFORE` | 80 chars | Narration before quote |
| `ATTR_WINDOW_AFTER` | 40 chars | Narration after quote |
| `ATTR_THOUGHT_WINDOW_BEFORE` | 500 chars | Thought-verb fallback |
| `PRONOUN_HISTORY_WINDOW` | 400 chars | Gender resolution |
| `ATTR_NAME_TO_VERB_GAP` | 70 chars | Distance between name and verb |

#### Pass-by-Pass Detail

| Pass | Where | Logic | Input | Output | Confidence (informal) |
|---|---|---|---|---|---|
| 1. BEFORE speech-verb | `prev_quote_end..q_start` ≤ 80 chars (or full gap if multi-quote paragraph) | For every name occurrence (longest-first), find a `SPEECH_VERBS` match within 70 chars AFTER. Pick the candidate with smallest `name + gap` distance. Apply `OBJECT_MARKER_RE` (nhìn/với/của/…) filter on the 12 chars BEFORE the name. | name alternation, verb alternation | canonical character (lowercased) | implicit 0.55+ |
| 2. AFTER speech-verb | 40 chars after `q_end` | `(punctuation\|space\|— \|,)` + name + `(gap)` + `SPEECH_VERBS` (or `SUBJECT_ACTION_VERBS` — broader set in the AFTER window). Anchored at start of AFTER. | tail after quote | canonical character | implicit 0.55+ |
| 3. AFTER em-dash | first 40 chars after `q_end` | `^\s*[—\-–]\s*(NAME)\s*[.,!?:：]?\s*$` — bare em-dash + Name alone. | em-dash region | canonical character | implicit 0.55+ |
| 4. BARE-EXCLAMATION (thought-verb / reactive-action) | 500 chars back | Two sub-passes run on the same wide window: (a) `THOUGHT_VERBS` subject — the *latest* name+verb wins (thinker is speaker); (b) `REACTIVE_ACTIONS` subject — same rule (doer is speaker). Object-marker filter still applies. | thought/reactive verb regexes | canonical character | implicit 0.55+ |
| 5a. PRONOUN RESOLUTION (BEFORE) | 80 chars back + 400-char history | Pronoun (Cô/Anh/Chị/…) found at *clause-start* + (gap) + speech verb OR subject-action verb in BEFORE window. Resolve pronoun → most-recently-mentioned same-gender character. Gender is inferred from the character's voice `builtinName` via `VIENEU_GENDER`. Pronoun history tracks each occurrence; right-most per gender wins. | pronoun alternation, gender map, names alt | canonical character | implicit 0.55+ |
| 5a (AFTER). PRONOUN RESOLUTION (AFTER) | first chars of AFTER window | Mirror of 5a but applied to narration that follows the quote. Verb set is broader (includes physical actions like đánh, nắm, véo, thở dài) because the quote has already been spoken and the reaction is action-heavy. | same as 5a | canonical character | implicit 0.55+ |
| 5b. NAME AS SUBJECT (action-verb) | 80 chars back | Last name + gap + `SUBJECT_ACTION_VERBS` (no `SPEECH_VERBS` needed, no physical-action verbs). Pick the latest match. Object-marker filter. | name alternation, action verb set | canonical character | implicit 0.55+ |
| default | (no match) | return `None` → `_resolve_segment_voice(name=None, …)` falls back to `cmap["default_voice_id"]`. | — | narrator | 0 (defaults to narrator voice) |

If `pn` (Tier 3b parser) returned a confident speaker (≥ 0.7 per Python tier3b override rule, mapped to ≥ 0.85 in the live reader by the parser-side scoring), Python overrides the regex answer:

```python
if tier3b_speaker and (not speaker_name
    or tier3b_attribution[p_idx]["confidence"] >= 0.85):
    speaker_name = tier3b_speaker
```

### 3.3 What feeds each decision

| Input | Source |
|---|---|
| `char_aliases` | `Character.aliases` JSON parsed once, lower-cased keys. Built by `_char_tone_map`/`buildGenderByChar` from `cmap["characters"]`. |
| `char_gender` | Only the 10 built-in VieNeu names: Ngọc Linh/Lan/Mỹ Duyên/Trúc Ly → female; Bình An/Gia Bảo/Đức Trí/Thái Sơn/Trọng Hữu/Xuân Vĩnh → male. Custom cloned voices → "unknown" (skip pronoun). |
| Voice builtin name | `Voice.builtinName` column; secondarily `Voice.name` if it matches `BUILTIN_VIENEU`. |
| Speech verbs (Pass 1/2) | 38 verbs: nói, hỏi, đáp, kêu, thì thầm, quát, hét, lẩm bẩm, nói nhỏ, cười nói, trả lời, gọi, thét, lên tiếng, quát tháo, cất tiếng, mở miệng, cất giọng, la lên, hỏi han, gào, kêu gào, tiếp lời, nói tiếp, nói khẽ, khẽ nói, hỏi lại, hỏi thăm, bảo, đọc, kể, xướng, hát, hỏi rằng, nói rằng, nói với, nói thầm, phát biểu, giải thích, giảng giải, xung phong, reo lên, hét lên. |
| Thought verbs (Pass 4a) | cảm thán, thầm nghĩ, nghĩ thầm, thì thầm, lẩm bẩm, tự nhủ, thầm nhủ, nói thầm, bình phẩm, đánh giá, cảm nhận, hy vọng, thắc mắc, lo lắng, băn khoăn, suy nghĩ, tự hỏi, nghĩ tới, nghĩ đến, tưởng nhớ, nhớ ra, thở dài, thở ra, than thở, than rằng, tự trách. |
| Reactive actions (Pass 4b) | cười, mỉm cười, nhếch mép, nháy mắt, chớp mắt, vỗ vai, vỗ lưng, ôm, ghé tai, nắm tay, kéo tay, vuốt tóc, xoa đầu, gõ nhẹ, vẫy tay, giơ tay, chỉ vào, nhìn, liếc nhìn, nhìn trộm. (Notice: NOT pure physical violence — đánh/chém/giết deliberately excluded.) |
| Subject-action verbs (Pass 2 / 5b) | ~60 verbs (everything in `SPEECH_VERBS` ∪ action subset without the physical ones). After the quote: includes đánh, đấm, nắm, véo, vỗ, thở dài, nhíu mày, lườm, liếc, trừng, ngước, cúi, etc. |
| Object markers | nhìn, thấy, gặp, với, của, cho, cùng, gọi, kể, về, bằng, từ, đến, giúp, trả, đưa, đối với, về phía, phía sau, bên cạnh, trước mặt. |
| Pronouns | Female: cô, chị, bà, em gái, con gái, nàng, nữ. Male: anh, ông, chú, bác, em trai, con trai, chàng, nam. Self (NOT used for attribution): tôi, tao, ta, mình, em, anh, cô, chị, ông, bà. |

### 3.4 No Embeddings, No Vector DB, No Coreference Model

The system is rule-based. There is no neural coreference resolver. There is no embedding-based alias resolution at runtime. Aliases are persisted as JSON strings and checked one-by-one against a pre-built alternation regex (longest-first). The only "fuzzy" matching happens at *character detection time* via `vi_g2p.nameCanonical()` / `g2pMatch()` (Vietnamese diacritic + tone folding), which produces deterministic canonical keys used during cluster merging — but this is a preprocessing pass, not a runtime attribution step.

### 3.5 Confidence Schema

| Source | Confidence | Reasoning path |
| --- | ---: | --- |
| `parser` (Tier 3b, speech verb + named subject) | 0.85 | Strongest signal in TS reader; 0.90 in Python worker. |
| `parser` (Tier 3b, pronoun-as-subject) | 0.65-0.70 | Subject is a pronoun, gender must be looked up. |
| `parser` (Tier 3b, name + non-speech verb) | 0.55 | Weaker — only attributed if a quote follows. |
| `parser` partial (no name resolved) | 0.20-0.25 | "Parser tried this paragraph but couldn't resolve." Flag for UI. |
| `regex` | 0.55 | Default for any successful attribution. |
| `llm` (Tier 3a) | `max(0.5, llm_conf)`, capped at 1.0 | `validateLLMRow` floors at 0.5; fuzzy-matched names keep the LLM's reported confidence. |
| `default` (no attribution) | 0 (implicit) | Falls back to narrator voice. |

There is **no machine-learning confidence calibration** — confidence scores are heuristic integers derived from which layer matched.

### 3.6 Limitations of the Regex Engine

Documented in code comments and `AI_AUDIOBOOK_README.md` §10:

- Books that put character names > 500 chars back fall back to narrator voice.
- Two-character ping-pong paragraphs (no narration between `"…". "…".`) cannot be attributed.
- "nhìn NAME", "với NAME", etc. are dropped from candidates.
- Pass 5a's `VIENEU_GENDER` only knows the 10 built-in voices; cloned voices without a recognizable builtin get `unknown` and their pronouns skip Pass 5a.
- Pure physical actions (đánh/chém/vỗ/ôm) are deliberately excluded from `SUBJECT_ACTION_VERBS` in Pass 5b — they describe what the subject DID and the quote following is usually the *other* character's reaction.

---

## 4. Character Tracking

### 4.1 Persistent Character Model

Schema (`app/ebook-converter/prisma/schema.prisma`):

```prisma
model Character {
  id        String   @id @default(uuid())
  bookId    String
  name      String                       // canonical name (e.g. "Y Đằng Ưu Nhi")
  aliases   String?                      // JSON string[] of all variants seen
  voiceId   String?                      // FK → Voice row (null = book default)
  notes     String?
  role      String   @default("supporting")  // main | supporting | minor | crowd
  age       String?                         // young | mature | old | null
  gender    String?                         // male | female | null
  tone      String?                         // calm | cheerful | cold | mysterious | serious | warm | angry | sad | …
  createdAt DateTime @default(now())

  @@unique([bookId, name])
  @@index([bookId, role])
}

model Voice {
  id             String   @id @default(uuid())
  bookId         String
  name           String                       // "Bình An" or user label
  description    String?
  refAudioPath   String                       // "" for built-ins
  language       String   @default("vi")
  isDefault      Boolean  @default(false)
  defaultSpeed   Float?
  defaultEmotion String?                      // calm|sad|tense|romantic|angry|excited|neutral
  kind           String   @default("character")  // narrator | character | common
  builtinName    String?                      // "Bình An" | null=cloned
  …
}

model ChapterAttribution {
  id            String   @id @default(uuid())
  bookId        String
  chapterIndex  Int
  payload       String   // JSON: Record<paragraphIdx, {speaker, confidence, source}>
  sourceMtime   BigInt   // mtime of chapter HTML when attribution ran
  parserVersion String   @default("vncorenlp-1.2")
  …
  @@unique([bookId, chapterIndex])
}
```

### 4.2 What is Persisted

For each book:

- **Voice rows** in `Voice` table (per book). One book has 4 "common" pool voices plus per-character voices plus optionally a default "narrator".
- **Character rows** in `Character` table, keyed by `(bookId, name)`. JSON-encoded `aliases` array.
- **Mapping**: `Character.voiceId` → `Voice.id`. NULL means "use book default."
- **Cached attribution maps** in `ChapterAttribution` keyed by `(bookId, chapterIndex)`. The payload survives across restarts.
- **Pre-generated audio**: `AudiobookChapter` rows with `audioPath`, `configHash` (sha256 of `backend + voices + characters`).

### 4.3 Detection Pipeline

#### Full Book (UI button: "AI Character Detection")

```text
VoicePanel.tsx / CharacterDetection.tsx  (POST /api/library/[id]/characters/detect)
     │
     ▼
characters/detect/route.ts
     │ resolveTtsServiceDir() → character_detector.py
     │
     ▼  spawn(python character_detector.py <epub> <model>)
character_detector.py
     │ extract_chapter_samples()  ← 5 chapters × 3000 chars (strided across spine)
     │
     │ oMLX chat completion  (system prompt strict JSON-only)
     │   "extract every distinct character who has spoken dialogue
     │    ... name, aliases, gender, age, tone, role, sample_lines"
     │
     │ _parse_json_anywhere(raw)  ← tolerates thinking output
     │ _merge_duplicate_characters()  ← union-find by name_canonical()
     │
     ▼  JSON  { characters: [...], language, narrator_gender_hint, total_dialogue_lines, summary }
     │
     ▼  back in TS: suggestVoice() → alreadyUsed diversity pick
     │  VIENEU_PROFILES scored by gender/age/tone (10 profiles)
     │  isAlreadyInDb()  ← g2pMatch against existing names + aliases
     │
     ▼  Return suggestions to UI for user approval. User picks → POST /api/library/[id]/characters
```

#### Per-Chapter (lazy)

```text
EbookReader.tsx → POST /api/library/[id]/chapters/[chapterId]/detect-characters
     │
     ▼
src/app/api/library/[id]/chapters/[chapterId]/detect-characters/route.ts
     │ fetch chapter HTML
     │ resolve user-selected model from Settings DB (Settings.aiModel)
     │
     ▼  spawn(python character_detector.py <chapter.html> <model>)
character_detector.detect_characters_in_chapter_html()
     │ cap to 5000 chars
     │ oMLX with same system prompt
     │
     ▼  TS assignVoicesToCharacters()  ← central voice-selector.ts
     │   merges into existing Character rows
     │   ensures common pool exists
     │   selects builtin or clones
     │
     ▼  inserted + skipped counts returned
```

### 4.4 Merge / Dedup Logic

`character_detector.py::_merge_duplicate_characters()` (mirror in `vi-text-qa.ts::mergeDuplicateCharacters()`) uses **union-find** keyed by:

1. `_vi_canonical(name)` — diacritic + tone-stripped lowercase.
2. `_vi_match(k1, k2)` — cross-canonical g2p equivalence (drop spaces/hyphens, ≥ 2 chars identical when stripped).

Primary record selection: `has_diagonals ? lines_estimate ? name.length`.

### 4.5 Voice Assignment Algorithm

`app/ebook-converter/src/lib/ai/voice-selector.ts`:

1. **Role classification** (`pickRole`):
   - If detector supplied `role` in {main, supporting, minor, crowd} → use it.
   - Otherwise heuristic: ≥ 3 aliases → main; 0 aliases → minor; else supporting.
2. **Voice selection** (`pickOrCreateVoice`):
   - `role ∈ {minor, crowd}` → `poolSlotForName(name)` → 4-voice common pool (`Mỹ Duyên, Gia Bảo, Trúc Ly, Đức Trí`).
   - Otherwise → `pickBestBuiltInVoice({name, gender, age, tone})`:
     - Score = `+10 gender match`, `-20 gender mismatch`, `+3 age match`, `+5 tone match`.
     - Tie-break: stable `name.charCodeAt(i)*31 + index` hash → same character always lands on same voice.
   - Reuse an existing `kind=character` voice with the same builtinName (dedup), except for `role=main` which always gets a dedicated voice.
3. **Jitter** (`jitterForCall`, `kind=common` only):
   - Deterministic by `(name, callIdx)` — speed ±15 %, emotion rotated among `excited/calm/neutral` so repeated appearances feel natural.

### 4.6 Alias Resolution at Attribution Time

Aliases are pre-flattened into a single `lower(name) → canonical` dictionary (`char_aliases`). At runtime the regex engine compares every name occurrence against this dictionary (longest-first), so adding an alias to a character is a one-step DB edit.

Persistent character memory = YES, durable per-book. The system maintains the `(bookId, name) → voiceId` mapping and `(bookId, chapterIndex) → attribution map` across sessions and across chapters.

---

## 5. Pronoun Resolution

### 5.1 Heuristic, not Coreference Resolution

**The system does NOT run a coreference resolver.** It runs **gender-keyed history walking**:

```python
# _resolve_pronoun_subject (and TS mirror)
last_by_gender: dict[str, str] = {}
for each name occurrence in <q_start - 400 .. q_start>:
    if 12 chars before name match OBJECT_MARKER_RE:
        continue          # name is being USED AS OBJECT — skip
    canonical = char_aliases[matched.lower()]
    g = char_gender[canonical]      # 'female' | 'male' | 'unknown'
    if g in ('female', 'male'):
        last_by_gender[g] = canonical   # right-most wins

# 2. Find pronoun-as-subject in last 80 chars of BEFORE window.
# 3. Resolve pronoun → last_by_gender[pronoun_gender]
```

Same code runs in the AFTER window (Pass 5a-After), using the SAME 400-char history anchor `q_start`.

### 5.2 Pronoun → Gender Lexicon

`audiobook_generator.py` lines 160-171:

| Pronoun | Gender | Why included |
|---|---|---|
| cô, chị, bà, em gái, con gái, nàng, nữ | female | unambiguous second-person female honorifics |
| anh, ông, chú, bác, em trai, con trai, chàng, nam | male | unambiguous second-person male honorifics |
| tôi, tao, ta, mình, em, anh, cô, chị, ông, bà | ("SELF") | First/second-person — NEVER used for attribution; only the explicit female/male pronouns above are consulted. |

### 5.3 Gender Inference Sources

Gender is **only** inferred from one of two places:

1. `VIENEU_GENDER` table — hard-coded mapping for the 10 built-in voices:
   ```python
   VIENEU_GENDER = {
       "Ngọc Linh": "female", "Ngọc Lan": "female",
       "Mỹ Duyên": "female", "Trúc Ly": "female",
       "Bình An": "male", "Gia Bảo": "male",
       "Đức Trí": "male", "Thái Sơn": "male",
       "Trọng Hữu": "male", "Xuân Vĩnh": "male",
   }
   ```
2. `Character.gender` column in the SQLite DB (set during detection from the LLM's gender output and backfilled later).

If both fail → `"unknown"` and that character is **skipped** by pronoun resolution. Lines then fall through to a later pass or to narrator.

### 5.4 Limits

- Only the **most-recent** same-gender character is the candidate. Two female characters in the same window → only the right-most wins. This was a known acceptable trade-off (the comment on line ~1470: "walks mention order; the final value is the most recent").
- The pronoun is required to be at *clause-start* (preceded by `. , ! ? … : — ;` or beginning of string) — this avoids matching `Anh` inside `anh trai` (a noun phrase).
- No third-person pronoun resolution for `hắn`, `nó`, `y` (informal "he/she/it") — they are not in the lexicon.
- No resolution across chapter boundaries — every chapter starts a fresh `last_by_gender` because the history is bounded per quote.

---

## 6. Voice Assignment

### 6.1 Voice Registry

```text
┌─── Built-in (10 VieNeu voices) ─────────────────────────────────────────┐
│  Female: Ngọc Linh, Ngọc Lan, Mỹ Duyên, Trúc Ly                        │
│  Male:   Bình An, Gia Bảo, Đức Trí, Thái Sơn, Trọng Hữu, Xuân Vĩnh     │
│  All are 48 kHz, instant, no reference audio.                          │
└────────────────────────────────────────────────────────────────────────┘
┌─── User-uploaded (Cloned via voice cloning) ──────────────────────────┐
│  Stored as Voice row with refAudioPath != ""                           │
│  Routed through VieNeu's clone path → POST reference_path             │
└────────────────────────────────────────────────────────────────────────┘
┌─── Common pool (Minor / crowd characters) ─────────────────────────────┐
│  Created by ensureCommonVoicePool() — 4 voices:                       │
│    "Giọng chung #1" → Mỹ Duyên (female calm)                         │
│    "Giọng chung #2" → Gia Bảo  (male calm)                           │
│    "Giọng chung #3" → Trúc Ly   (female cheerful)                     │
│    "Giọng chung #4" → Đức Trí  (male serious)                        │
│  Slot picked by deterministic name-hash → same character same pool entry│
└────────────────────────────────────────────────────────────────────────┘
┌─── Default voice (one per book) ──────────────────────────────────────┐
│  Voice.isDefault=true. Used when:                                     │
│    - quote not attributed → DEFAULT_VOICE fallback                   │
│    - character has voiceId=null                                       │
│    - user explicitly picks "default" in UI                            │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Voice Resolution Path (Live Read-Aloud)

`/api/tts` route (`app/ebook-converter/src/app/api/tts/route.ts`):

```
1. POST body received: { text, bookId, character?, voice?, speed, emotion, expressiveness, callIdx, ... }

2. resolveVoiceForCharacter(bookId, character, callIdx)
   ├─ If character → lookup Character row by (bookId, name match in name OR aliases)
   │                → follow voiceId → Voice row
   │                → builtinName || (if name in BUILTIN_VIENEU → name, else null)
   │                → refAudioPath || voice.refAudioPath || null
   │                → if kind=common → jitter (speed ± 15%, emotion in {excited, calm, neutral})
   │                → else → voice.defaultSpeed, voice.defaultEmotion
   └─ Fallback → book default voice (Voice.isDefault=true)

3. If voiceName still empty and body.voice is a UUID → getVoice(uuid) → repeat step 2 logic.

4. emotionMarker(body.emotion) — see §7.

5. applyEmotionMarker(text, emotion) — require laugh-keyword evidence for [cười].

6. POST http://127.0.0.1:5010/synthesize
   { text, voice (builtin), reference_path, backend=langext-or-moss-nano,
     language, speed, noise_scale, noise_w }
```

### 6.3 Voice Resolution Path (Audiobook Pre-Generation)

`audiobook_generator.py::_resolve_segment_voice(char_name, cmap, default_voice_id)`:

```python
def resolve(char_name, cmap, default_voice_id):
    tone = None
    # No character resolved → use default voice's tone
    if not char_name:
        v = cmap["voices_by_id"].get(default_voice_id, {})
        tone = v.get("defaultEmotion")
        if v.get("isBuiltinVieNeu"):
            return (default_voice_id, v["name"], tone)   # voice_id, voice_name (for vieneu), tone
        return (default_voice_id, None, tone)

    # Find the Character row
    char = next(c for c in cmap["characters"] if c["name"] == char_name)
    if not char or not char.get("voiceId"):
        # Same default fallback as above
        ...

    voice_id = char["voiceId"]
    voice = cmap["voices_by_id"][voice_id]
    tone = voice.get("defaultEmotion")
    if voice.get("isBuiltinVieNeu"):
        return (voice_id, voice["name"], tone)
    return (voice_id, None, tone)   # custom/cloned → voice_name=None → use reference_path
```

`synthesize_segment()` then sends:

```python
payload = {"text": text, "language": "Vietnamese", "speed": speed, "backend": backend}
if voice_name:    payload["voice"] = voice_name
if voice_ref:     payload["reference_path"] = voice_ref
```

### 6.4 Voice Cache (Client Side)

The browser keeps two in-memory caches inside `EbookReader.tsx`:

- `chapterParagraphsRef: Map<chapterId, string[]>` — chapter text.
- `prefetchCacheRef: Map<chapterId, Map<key, Promise<Blob>>>` — pre-fetched TTS audio.
- Key shape: `${idx}::${character ?? '_'}::${speed.toFixed(2)}::${ttsVoice}::${emotion}::${expressiveness.toFixed(2)}` — changes in any setting invalidate.

There is **no service-side voice cache**. Every TTS request is freshly synthesized (except for the LLM-emotion cache `_LLM_EMOTION_CACHE` in `audiobook_generator.py`, see §9).

### 6.5 Voice Persistence

- DB-level: `Voice` and `Character` rows (per-book).
- File-level: `data/voices/<bookId>/<voice>.wav` uploaded ref-audio (cloned voices).
- Server-runtime: `_VOICES_CACHE` in `vieneu_server.py` — caches `[{id, label}]` after first call.
- VieNeu itself holds MLX model + per-book cloning state in memory.

### 6.6 Configuration Files

| File | Purpose |
|---|---|
| `app/tts-service/audiobook_generator.py:582-602` | `BUILTIN_VIENEU` (Python set), `VIENEU_GENDER` (Python dict) |
| `app/ebook-converter/src/lib/ai/voice-selector.ts:53-72` | `VIENEU_PROFILES` array of 10, `COMMON_POOL_BUILTINS` array of 4, `BUILTIN_VIENEU` set |
| `app/ebook-converter/src/worker/audiobook.ts:267-270` | `BUILTIN_VIENEU` set (third copy) |
| `app/ebook-converter/src/app/api/library/[id]/characters/route.ts:21-24` | `BUILTIN_VIENEU` set (fourth copy) |
| `app/ebook-converter/src/app/api/library/[id]/characters/detect/route.ts:53-58` | `VIENEU_VOICES` for client metadata |
| `app/ebook-converter/src/app/api/tts/route.ts:47-50` | `BUILTIN_VIENEU` set (fifth copy) |
| `app/ebook-converter/src/components/library/EbookReader.tsx:166-177` | `VIENEU_VOICES` UI-facing array |
| `app/ebook-converter/src/components/library/EbookReader.tsx:726-731` | `VOICE_GENDER` (mirror of Python) |

### 6.7 Override / Fallback Logic (full chain)

```
character → voiceId?                            → use that voice (builtin or custom)
            ↓ no voiceId
book default (Voice.isDefault=true)             → use that voice
            ↓ no default
cmap.default_voice_id (or null)                 → use that voice
            ↓ none
unified_server.pick_backend()                   → default backend, no voice preset
            ↓
VieNeu's own default voice                      → emits audio
```

Live reader: explicit `body.voice` (UUID or name) overrides lookup; user can also pick "Bình An (default male)" as a global default.

---

## 7. Emotion Detection

### 7.1 Three Independent Pipelines

```
Tier 1 (Python regex, always runs)
   ├─ KEYWORD_EMOTIONS list — 12 patterns
   │  • laugh:  \bhaha|hehe|hihi|...|(cười gằn)|...    → [cười]
   │  • sigh:   \bthở dài|thở phào|than thở|...         → [thở dài]
   │  • throat: \bhắng giọng|khóc thét|khóc nức nở|...  → [hắng giọng]
   │  *Bare verbs "cười" / "khóc" / "khàn giọng" deliberately OMITTED
   │   (too noisy — match in narration too often).
   │
   └─ Each marker injected at most once per segment, appended to text.

Tier 2 (Python LLM, opt-in via ENABLE_LLM_EMOTION=1)
   ├─ One oMLX call per CHAPTER: batches ALL dialogue segments.
   ├─ System prompt: closed-set taxonomy
   │     "neutral, cheerful, sad, angry, sigh, laugh, sneer, cold,
   │      calm, mysterious, serious, warm"
   ├─ Output: JSON {"1":"laugh","2":"sad",...}
   ├─ Parsed by _parse_emotion_map() — tolerant of garbage around JSON
   └─ Each label mapped via LLM_EMOTION_TO_MARKER table.

Tier 3a (Python LLM segmenter, opt-in via USE_LLM_SEGMENTER=1)
   ├─ Single call per chapter (chunked at LLM_SEGMENT_MAX_CHARS=8000)
   ├─ Replaces regex segmenter entirely
   ├─ Returns per-segment { text, kind, character, emotion }
   └─ Emotion field flows into inject_emotions() as the "LLM marker"

Tier L (Live reader, EbookReader.tsx::detectEmotion)
   ├─ Maps Vietnamese text patterns + punctuation into {label, emoji,
   │  speed, noiseScale, emotion}
   ├─ Categories: hành động (⚡, +22% speed), tức giận (😤, +18% speed),
   │  buồn (💧, -20% speed), lãng mạn (💕, -12% speed, no marker),
   │  căng thẳng (😰, +7% speed), bình yên (🍃, -10% speed), neutral
   └─ Speed/noise adjustments are sent to TTS as speed + noise_scale/noise_w.
```

### 7.2 Priority of Tiers

`inject_emotions()` in `audiobook_generator.py`:

```python
search_text = strip(self.markers, out)
inserted = {}  # each marker added once max
for pattern, marker in KEYWORD_EMOTIONS:
    if pattern.search(search_text) and not inserted[marker.strip()]:
        out += " " + marker.strip()
        inserted[marker.strip()] = True

if out starts with "[":  # Tier 1 matched → done
    return out

# Tier 2: LLM-derived marker (PREPENDED, not appended)
llm = llm_marker.strip()
if llm:
    out = (llm + " " + out).strip()
    if out.lstrip().startswith("["):
        return out

# Tier 3: voice defaultEmotion → tone → marker (dialogue only)
if segment_kind == "dialogue" and character_tone:
    tone_marker = TONE_TO_EMOTION.get(character_tone)
    if tone_marker:
        out = (tone_marker + out).strip()
return out
```

Tier 1 (keyword) wins outright. Tier 2 fires only when Tier 1 didn't, so a forced laugh-marker doesn't layer on top of a forced laugh.

### 7.3 Tone → Marker Mapping (Tier 3)

```python
TONE_TO_EMOTION = {
    "angry":   " [hắng giọng] ",
    "sad":     " [thở dài] ",
    "cold":    "",            # timbre, not emotion
    "mysterious": "",         # timbre
    "calm":    "",            # timbre
    "cheerful":"",            # DELIBERATELY EMPTY — voice timbre
    "warm":    "",            # DELIBERATELY EMPTY — voice timbre
    "unknown": "",
}
```

The "cheerful/warm" → empty mapping was added explicitly after a bug where `[cười]` was injected into threats like *"Chết tiệt, cậu tốt nhất nên có chuyện gì quan trọng"* because the character's *default* voice was cheerful.

### 7.4 Does Emotion Affect TTS?

Yes — through three independent channels:

1. **Inline VieNeu markers** (`[cười] [thở dài] [hắng giọng]`) — VieNeu's `vieneu_server.py` passes them to `tts.infer()` verbatim.
2. **Speed multiplier** — applied in `synthesize_segment(..., speed=speed)`. VieNeu v3 uses soxr resampling.
3. **Expressiveness/noise** — `noise_scale` + `noise_w` sent to Piper (no-op for VieNeu).

### 7.5 Emotion-Marker Content-Evidence Guard (Live Reader)

`applyEmotionMarker` in `/api/tts` route: even if the LLM labels a segment `laugh`, `[cười]` is **only** injected if the text actually contains a laugh pattern (`haha / hehe / cười lớn / *khanh khách* / (cười gằn) / …`). Tightened in 2026-07 to fix the "CẢM XÚC TỰ ĐỘNG injects [cười] between every sentence" bug.

`emotionMarker(label)` (now strict):

| Label | Marker |
|---|---|
| `laugh`, `amused` | `[cười]` (only if evidence present) |
| `sad`, `sigh`, `regret`, `buồn` | `[thở dài]` |
| `angry`, `rage`, `tense`, `serious`, `cold`, `sneer`, `tức giận`, `căng thẳng` | `[hắng giọng]` |
| everything else — `cheerful`, `excited`, `happy`, `joy`, `lãng mạn`, `hành động`, `neutral`, `warm`, … | **(no marker)** |

### 7.6 Emotion Cache (Tier 2 LLM)

```python
_LLM_EMOTION_CACHE: dict[str, str] = {}
_LLM_EMOTION_CACHE_MAX = 4096     # LRU eviction via popitem(last=False)

# Caching key = dialogue-segment text (cleaned of any markers)
# Cached value  = LLM-emitted marker (e.g. " [cười] ")
```

Same dialogue repeated across chapters skips the LLM entirely. Cache is per-process (lost on restart of `audiobook_generator.py`).

---

## 8. TTS Pipeline

### 8.1 Live Read-Aloud Endpoint

Client (`EbookReader.tsx::prefetchParagraph()` → `speakParagraph()`) →

```
POST /api/tts
{ text, bookId, character?, voice?, speed, emotion, expressiveness, callIdx, language }
```

Server (`app/api/tts/route.ts`):

```
1. JSON parse + validate text non-empty
2. resolveVoiceForCharacter(bookId, character, callIdx)
   → {voiceId, builtinName, refAudioPath, speed, emotion}
3. If voice still empty + body.voice is a UUID:
   getVoice(uuid) → resolve same way
4. If body.voice is a plain string: use as builtin name
5. emotion = body.emotion ?? voiceEmotion
6. emotionMarker(emotion) + applyEmotionMarker(text, emotion)
   → text with optional prepended [cười]/[thở dài]/[hắng giọng]
7. Body: { text, backend (auto-derives Vietnamese→vieneu, else moss-nano),
          speed clamped to [0.5, 3.0], language, noise_scale,
          noise_w, voice (builtin name), reference_path }
8. POST http://127.0.0.1:5010/synthesize (timeout 60s)
9. Return audio/wav with X-Voice-Used, X-TTS-Backend headers
```

### 8.2 Audiobook Pre-Generation Endpoint (CLI)

`generate_chapter()` in `audiobook_generator.py`:

```
1. Load CHARACTER_MAP env var (JSON of voices_by_id, characters, default_voice_id)
2. split_into_segments(html_body, cmap) → list of segments
3. for each segment:
     resolve voice (id, name, ref_audio)
     synthesize_segment(text, voice_name, voice_ref, backend, speed) → wav bytes
     max_retries=3 with exponential backoff (1s, 2s, 3s)
     timeout 300s for first-segment warmup
4. concatenate_wavs(parts, pause_ms=350) → single WAV file
5. Write to data/audiobooks/<bookId>/<chapter>.wav
6. Optionally: ffmpeg → 96 kbps MP3 mono 24 kHz
```

### 8.3 Unified TTS Server (`unified_server.py`)

`POST /synthesize`:

```python
backend = pick_backend(req.backend, req.language, text, req.voice, req.reference_path)
#   - explicit backend wins
#   - else if reference_path → vieneu (cloning)
#   - else if has_vietnamese(text) → vieneu
#   - else → moss-nano (MUST have ONNX weights)

if backend == "vieneu":
    wav = synthesize_vieneu(text, voice=req.voice, ref_audio=req.reference_path, ref_text=req.ref_text, speed=req.speed)
elif backend == "piper":
    wav = synthesize_piper(text, model=req.model, speaker=req.speaker,
                           length_scale=1.0/max(0.5, min(3.0, req.speed)),
                           noise_scale=req.noise_scale, noise_w=req.noise_w)
elif backend == "moss-nano":
    wav = synthesize_moss_nano(text, reference_path=req.reference_path)
```

### 8.4 VieNeu Sub-Server (`vieneu_server.py`)

```python
def synthesize(text, voice=None, ref_audio=None, ref_text=None, speed=1.0):
    tts = get_tts()   # lazy Vieneu() singleton, .venv Python
    audio = tts.infer(text, voice=voice, ref_audio=ref_audio, ref_text=ref_text)
    # Convert numpy → mono float32 → int16 PCM
    # Apply speed scaling via soxr resample (if soxr available)
    return build_wav(audio, sr, sample_rate=48000 v3-turbo)
```

Voice cache: `_VOICES_CACHE` (list of `{id, label}` built lazily on first `/voices` GET).

### 8.5 Piper Sub-Server (`server.py`)

Plain FastAPI → `PiperVoice.load(onnx)` → `voice.synthesize(text, cfg)` → collect `audio_int16_bytes` chunks → assemble mono WAV.

Configured model: `vi_VN-vais1000-medium` (22 kHz mono).

### 8.6 MOSS-TTS-Nano Sub-Server (in-process inside `unified_server.py`)

```python
runtime = get_nano()  # OnnxTtsRuntime(model_dir, execution_provider="cpu")
result = runtime.synthesize(
    text, prompt_audio_path=reference_path,
    output_audio_path="_tmp_synth.wav",
    enable_wetext=False, enable_normalize_tts_text=True,
    streaming=False, sample_mode="fixed", do_sample=False,
)
# Read WAV, mix channels if needed, return mono 16-bit
```

### 8.7 Text Normalization

- No explicit normalization step in the Python / TS code.
- HTML is stripped to whitespace-collapsed plain text via `strip_html()` / `sliceParagraphs()`.
- Diacritic-preserving canonicalization (NFKC) in `vi-text-qa.ts::normalizeVietnamese()` for AI-enhanced chapters.
- Minimal-pair QA (`auditMinimalPairs()`) flags common LLM/OCR collapses (tường/thường, trước/chước, số/xố, giải/dải, cách/kếch) without fixing them.

### 8.8 Sentence Splitting

- Regex `[.!?。！？]+\s+` for narration chunking (in `audiobook_generator.py::emit_narration()`).
- Hard limit `NARRATION_CHUNK_TARGET = 1200` chars per narration chunk (otherwise concatenated to keep one TTS call under 300s timeout).

### 8.9 SSML / Prosody

- **No SSML.** The pipeline uses plain text + inline `[]` emotion markers.
- Prosody is via `speed` (clamped to [0.5, 3.0]) + `noise_scale` + `noise_w` (Piper only).
- VieNeu's emotion markers are inline text tokens, not SSML `<break>` or `<prosody>`.

### 8.10 Streaming

- VieNeu inference is non-streaming on the server (returns the whole WAV).
- Audiobook pre-gen is sequential per segment with BullMQ rate-limit `2/60s`.
- Live reader uses **prefetch-ahead** — fetches the next 5 paragraphs as it plays the current one to mask 15-20s latency on Apple Silicon.
- The reader-side oMLX-client (`omlx-client.ts`) uses SSE streaming with `stream_options.include_usage=true` for live token metrics.

### 8.11 Caching

| Cache | Scope | Eviction |
|---|---|---|
| Client-side `prefetchCacheRef` (Browser) | Per chapterId | LRU on memory pressure (no explicit cap) |
| `ChapterAttribution` (SQLite) | (bookId, chapterIndex) keyed by sourceMtime | Re-attribute when mtime changes |
| `_LLM_EMOTION_CACHE` (Python process) | LRU 4096 entries | FIFO via `popitem(last=False)` |
| `_VOICES_CACHE` (vieneu_server) | List of 10 voices | Lazy — never evicted |
| VnCoreNLP `/annotate` LRU | 512 entries SHA1-keyed | LRU |
| VieNeu voice cloning model | In-memory per server | Process restart |
| `Job` + `AudiobookChapter` + DB rows | SQLite | Per-row delete by API |

### 8.12 Audio Stitching

`concatenate_wavs(parts: list[bytes], pause_ms=350)`:

1. Decode each WAV to int16 PCM via Python `wave` module.
2. Concatenate raw PCM frames, inserting 350 ms silence between segments.
3. Rebuild WAV header (44 bytes RIFF/fmt/data) with the concatenated PCM.

The reader's live path **does not stitch** — each paragraph is a separate audio Blob played by one `<audio>` element at a time. Silence gap between paragraphs is added client-side by the JS `setTimeout(resolve, ttsParagraphGap)` (controlled by the "Khoảng nghỉ giữa đoạn" slider, default 0 ms = use model's natural trailing silence).

### 8.13 Output Format

- **Live**: `audio/wav` Response with header `X-TTS-Backend`, `X-Voice-Used`.
- **Audiobook**: MP3 96 kbps mono 24 kHz (after ffmpeg); WAV 48 kHz 16-bit mono fallback (VieNeu v3-turbo native).
- Stored at `data/audiobooks/<bookId>/<chapter>.mp3` (or `.wav`).

---

## 9. Memory Systems

| System | Type | Persistence | Scope | File |
|---|---|---|---|---|
| **Conversation memory** | None — stateless per HTTP request | — | per call | — |
| **Character memory** | SQLite `Character` rows (per book) | SQLite | cross-chapter | `prisma/schema.prisma` |
| **Scene memory** | SQLite `ChapterAttribution` rows (paragraphIndex → speaker map) | SQLite | per-chapter (mtime-keyed) | `prisma/schema.prisma` |
| **Voice memory** | SQLite `Voice` rows (per book) | SQLite | cross-chapter | `prisma/schema.prisma` |
| **Generation memory** | SQLite `AudiobookChapter` rows with `configHash` | SQLite | per-chapter | `prisma/schema.prisma` |
| **LLM emotion cache** | In-memory dict (LRU 4096) | process restart loses it | across chapters in same process | `audiobook_generator.py:372` |
| **VnCoreNLP cache** | LRU 512 SHA1-keyed | process restart loses it | across chapters in same process | `vncorenlp_server.py:111-148` |
| **VieNeu voice model cache** | In-memory MLX | process restart loses it | global | `vieneu_server.py:40` |
| **Browser prefetch cache** | `Map<chapterId, Map<key, Promise<Blob>>>` in React ref | tab reload loses it | per chapter | `EbookReader.tsx:197` |
| **BullMQ jobs** | Redis | durable | book-level | `src/lib/queue/index.ts:47` |
| **Settings** | SQLite `Settings` row, singleton | SQLite | global | `prisma/schema.prisma` |
| **Vector DB** | **None.** | — | — | — |
| **Pickle** | **None.** | — | — | — |

### 9.1 Effective Memory Available for Attribution

- **Within a single quote**: `PRONOUN_HISTORY_WINDOW = 400 chars` of recent text BEFORE the quote.
- **Across quotes in one paragraph**: full gap between quotes used for BEFORE window (no 80-char cap).
- **Across paragraphs**: NO memory — each new paragraph starts fresh `last_by_gender`.
- **Across chapters**: NO in-memory state survives. The `ChapterAttribution` cache stores the resolved speaker per paragraph but **the per-chapter Python worker is a fresh subprocess** — there is no `last_by_gender` bridge from chapter N to chapter N+1.

### 9.2 Cross-Book Memory

- Voice profiles are per-book (`Voice.bookId`). No global voice cache in the DB.
- Character detector runs per-book. Settings.aiModel is global.
- oMLX model state is global (one MLX model loaded in oMLX).

---

## 10. LLM Usage

The system uses **one local LLM** (oMLX, OpenAI-compatible API on `http://127.0.0.1:8080`).

### 10.1 Where the LLM is Called

| Call site | Purpose | Default OFF? |
|---|---|---|
| `character_detector._run_detection` (Python) | Extract character roster from chapter sample | **Always called** via `/api/library/[id]/characters/detect` when user clicks the button |
| `character_detector.detect_characters_in_chapter_html` (Python) | Lazy per-chapter detector | **Always called** when user triggers detection |
| `audiobook_generator._call_omlx_emotion_batch` | Batch classify all dialogue segments in a chapter | **OFF** (`ENABLE_LLM_EMOTION` env, default "0") |
| `audiobook_generator._call_omlx_segmenter` (Tier 3a) | Full chapter segmentation + per-segment emotion | **OFF** (`USE_LLM_SEGMENTER` env, default "0") |
| `lib/attribution.attributeByLLM` (TS) | Resolve zero-anaphora paragraphs not caught by parser+regex | **OFF** — only invoked via the `/attribute/analyze` POST route (the "Wand2" Wand button) |
| `lib/ai/chapter-enhancer`, `chapter-formatter`, `epub-analyzer` (TS) | EPUB conversion AI enhancement | OFF by default; user toggles in Settings |
| `ai-conversion-prompt-review` AI | Cover generation, etc. | OFF unless image provider set |

### 10.2 Prompt Conventions

System prompt template for character detection (`character_detector.py:171`):

```
/no_think
You output ONLY a JSON object. No reasoning, no prose, no markdown.
Analyze the Vietnamese-novel chapters below and extract every distinct character
who has spoken dialogue (including background voices like 'tiếng la',
'người qua đường', 'ông lão', 'cô gái' — call these 'role':'crowd').
For each character output:
  name (string), aliases (array of strings), gender (male|female|unknown),
  age (young|mature|old|unknown — estimated from speech patterns),
  tone (one short word: calm|cheerful|cold|mysterious|serious|angry|sad|warm),
  role (main|supporting|minor|crowd — …),
  lines_estimate (integer), sample_lines (array of 1-2 short example lines).
Also output: narrator_gender_hint (male|female|unknown), language (vi|en|...),
total_dialogue_lines (integer), summary (1-2 short sentences).
Return JSON now, no commentary.
```

System prompt for LLM segmenter (`audiobook_generator.py:1015`):

```
You segment Vietnamese text into audiobook chunks. Respond with a JSON array ONLY.
Format strictly: [{"text":"...","kind":"narration","character":"","emotion":"neutral"}, ...]
RULES:
- Always use double quotes for keys AND string values (valid JSON).
- Every character field is either one of the names listed, or empty string "" for narration.
- Every kind field is exactly "narration" or "dialogue".
- Every emotion field is exactly one of: neutral, cheerful, sad, angry, sigh, laugh, sneer, cold, calm, mysterious, serious, warm
- text field must be a VERBATIM substring from the input. Do NOT paraphrase or summarize.
- Preserve order. Cover the entire input — every sentence in exactly one segment.
- For a quoted span, strip the opening/closing quotes from the text field and use kind=dialogue.
- ATTRIBUTION STRICT: ... [Vietnamese speech-verb rules]
- CLOSEST-SPEAKER-WINS: When multiple character names appear in the BEFORE
  window, the speaker is the name with the SMALLEST name-to-verb distance ...
- Names that appear as OBJECTS of verbs (nhìn / thấy / gặp / với / của / cho / cùng /
  gọi / kể / về / bằng / từ / đến / đối với / về phía) are NOT the speaker ...
- Names that follow a SENTENCE-BREAK (period + space) are usually a new subject
  and the speaker of the next speech verb.
- Narration that merely MENTIONS a character must NOT trigger that character's voice.
- When in doubt (no clear speech verb attached to the quote), leave character empty
  so the segment falls back to the narrator's default voice.
- Output ONLY the JSON array. No comments, no markdown, no explanation.
```

### 10.3 Generation Parameters

| Call site | `temperature` | `max_tokens` | Notes |
|---|---:|---:|---|
| character_detector | 0.1 | 1500 | One call per chapter sample |
| audio_generator emotion batch | 0.1 | `200 + 6 * n` | One call per chapter |
| audio_generator segmenter | 0.1 | `min(8192, 1500 + 0.6 * len(text))` | One call per chunk; retry on prefill-guard with smaller chunk |
| lib/attribution.attributeByLLM (TS) | 0.1 | 1024 | One call per batch of `LLM_BATCH_SIZE=4` paragraphs |
| Pre-flight probe (`omlxPreflight`) | (default 0.2) | 4 | "are you alive?" check before Tier 3a |

### 10.4 Structured Output Strategies

- **JSON-only / no_think system prompts** for every LLM call (reasoning models would otherwise dump explanations before the JSON).
- **Three-tier JSON parsing fallback** (`_parse_json_anywhere` / `_parse_emotion_map` / `_parse_segment_list`):
  1. Try `json.loads(text)` after stripping ` ``` ` fences.
  2. Search for `\{[^}]*\}` (JSON object substring) or `\[[\s\S]*\]` (JSON array substring) and re-parse.
  3. For arrays: tolerant per-field regex parser that handles unquoted keys, single quotes, trailing commas (Vietnamese LLM models are particularly messy).

### 10.5 Retry Logic

| Site | Retry count | Backoff |
|---|---|---|
| LLM segmenter (audiobook_generator) | 1 retry at 0.6× chunk size on "prefill memory guard" or "predicted peak" error | chunk size shrinks from 8000 to 4800 (min 600 chars) |
| lib/attribution.attributeByLLM | Per-batch count as `failedBatches`; **does not retry** within one chapter | — |
| TTS segment synthesis (`synthesize_segment`) | 3 retries | linear: 1s, 2s, 3s sleep |
| BullMQ jobs | 2 attempts (audiobook), 3 attempts (conversion) | exponential, 5s base |
| oMLX client (TS chat) | None — non-retrying | Falls back to non-streaming once |

### 10.6 Fallback Behavior

When the LLM fails:

- **Character detection** → `character_detector._regex_extract_names()` + `_extract_metadata_from_prose()` as last resort; final fallback is an empty list.
- **Audiobook emotion** (Tier 2) → prints `[emotion] oMLX classify failed: …` and all dialogue segments skip the LLM marker (fall back to Tier 1 keyword + voice tone).
- **Audiobook segmentation** (Tier 3a) → entire chapter falls back to `_regex_segment_chapter()` (Tier 1).
- **Live LLM attribution** (`attributeByLLM`) → `failedBatches` counter increments; UI shows "LLM unreachable" hint.
- **oMLX preflight failure** → `omlxReachable: false` returned, LLM step skipped, response still includes parser + regex results.

### 10.7 Tool Calling

**None.** oMLX's tool calling API is not used; every LLM call is plain `chat.completions` with messages.

---

## 11. Data Flow (Step-by-Step)

Every function involved in novel → final audio, with input/output/dependencies.

### 11.1 Offline Path (Audiobook Pre-Generation)

| # | Function | File | Input | Output | Dependencies |
|---|---|---|---|---|---|
| 1 | UI button → `POST /api/library/[id]/audiobook {action:"generate"}` | `EbookReader.tsx / AudiobookPanel.tsx` | Book id, backend | `audiobookQueue.add()` | `getAudiobookQueue` |
| 2 | `getAudiobookQueue()` | `lib/queue/index.ts:74` | `AUDIOBOOK_QUEUE_NAME='ebook-audiobook'` | `Queue<AudiobookJobData>` | Redis `127.0.0.1:6379` |
| 3 | BullMQ worker picks job | `worker/audiobook.ts:451` | `{bookId, chapterFile?, backend?}` | invokes handler | Redis |
| 4 | `generateOneChapter(bookId, chapterFile, backend)` | `worker/audiobook.ts:214` | same + `force?` | `AudiobookChapter` row updated | `getBook`, `getChapter`, `listVoices`, `listCharacters`, `getDefaultVoice`, `parseEpub`, `runGenerator` |
| 5 | `computeAudiobookConfigHash(bookId, backend)` | `worker/audiobook.ts:120` | bookId | sha256 hash | `listVoices`, `listCharacters` |
| 6 | `runGenerator({bookId, chapterFile, backend, language, chapterTextFile, outDir, charactersJson})` | `worker/audiobook.ts:78` | job inputs | `{stdout, stderr, code}` | python spawn |
| 7 | `audiobook_generator.py:generate_chapter()` | `audiobook_generator.py:1826` | bookId, chapterFile, html_body, out_dir, language, backend, on_progress | `{audio_path, duration_ms, size_bytes, segments, segments_ok, by_voice}` | `_load_character_map`, `split_into_segments`, `synthesize_segment`, `concatenate_wavs` |
| 8 | `split_into_segments(html_body, cmap)` | `audiobook_generator.py:682` | html, cmap | `[{kind,text,character,voice_id,voice_name,emotion?}, ...]` | `_TIER3B_AVAILABLE` toggle, `tier3b_attribution`, `_llm_segment_chapter`, `_regex_segment_chapter` |
| 9 | `vncorenlp_attribution.attribute_chapter(plain, cmap, paragraphs)` | `vncorenlp_attribution.py:394` | plain text, cmap, paragraphs | `{paragraphIndex: {speaker, confidence, source}}` | HTTP `POST :5030/annotate` |
| 10 | `_call_annotate(text)` | `vncorenlp_attribution.py:80` | text | parsed sentences | VnCoreNLP server (FastAPI + py_vncorenlp) |
| 11 | `_regex_segment_chapter(plain, cmap, tier3b_attribution, paragraph_offsets)` | `audiobook_generator.py:1140` | plain, cmap, parser map | segments | `find_quote_spans`, `find_speaker_for_quote`, `emit_narration` |
| 12 | `find_quote_spans(plain)` | `audiobook_generator.py:197` | plain text | `[(start, end, content), ...]` | regex |
| 13 | `find_speaker_for_quote(q_start, q_end, prev_quote_end)` | `audiobook_generator.py:1218` | quote offsets, prev quote end | canonical char name or None | `char_aliases`, `char_gender`, `SPEECH_VERBS`, `SUBJECT_ACTION_VERBS`, `THOUGHT_VERBS`, `REACTIVE_ACTIONS`, `OBJECT_MARKER_RE`, `_resolve_pronoun_subject`, `_resolve_subject_action_speaker` |
| 14 | `_resolve_pronoun_subject(...)` | `audiobook_generator.py:1457` | text, q_start, prev_quote_end, aliases, gender, names_alt | canonical char name | `PRONOUNS_FEMALE`, `PRONOUNS_MALE`, `OBJECT_MARKER_RE`, last-by-gender history walk |
| 15 | `_resolve_subject_action_speaker(before, names_alt)` | `audiobook_generator.py:1623` | before window, names alt | canonical char name | `SUBJECT_ACTION_VERBS`, `OBJECT_MARKER_RE` |
| 16 | `inject_emotions(text, kind, char_tone, llm_marker)` | `audiobook_generator.py:524` | segment text, kind, char tone, llm marker | text with markers | `KEYWORD_EMOTIONS`, `TONE_TO_EMOTION`, `LLM_EMOTION_TO_MARKER` |
| 17 | `_classify_segments_with_llm(segments)` | `audiobook_generator.py:376` | all segments | one marker per segment | oMLX (opt-in), `_LLM_EMOTION_CACHE` |
| 18 | `_call_omlx_emotion_batch(texts)` | `audiobook_generator.py:440` | list of dialogue texts | one marker per input | HTTP `POST :8080/v1/chat/completions` |
| 19 | `_resolve_segment_voice(char_name, cmap, default_voice_id)` | `audiobook_generator.py:636` | char name, cmap, default voice id | `(voice_id, voice_name, tone)` | `cmap["characters"]`, `cmap["voices_by_id"]` |
| 20 | `synthesize_segment(text, voice_name, voice_ref, language, backend, speed, max_retries=3)` | `audiobook_generator.py:1793` | segment text, voice, ref, lang, backend, speed | WAV bytes | HTTP `POST :5010/synthesize` (300s timeout) |
| 21 | `concatenate_wavs(parts, pause_ms=350)` | `audiobook_generator.py:1768` | list of WAV byte strings, pause | combined WAV bytes | `wave` stdlib |
| 22 | `convertToMp3(wavPath, mp3Path)` | `worker/audiobook.ts:156` | paths | `{durationMs}` or null | ffmpeg spawn |
| 23 | `updateChapter(row.id, {...})` | `lib/db/audiobook.ts:46` | AudiobookChapter id, fields | updated row | Prisma |

### 11.2 Live Read-Aloud Path

| # | Function | File | Input | Output | Dependencies |
|---|---|---|---|---|---|
| 1 | Reader loads chapter → `useEffect` `getChapterParagraphs(chapterId)` | `EbookReader.tsx:1254` | chapterId | `string[]` paragraphs | `fetch /api/library/[bookId]/chapters/[chapterId]?raw=1` |
| 2 | DOMParser walks `<p>,<h1-6>,<li>,<blockquote>` | `EbookReader.tsx:1259` | chapter HTML | blocks of text | DOM |
| 3 | `loadChapterAttribution(chapterId)` | `EbookReader.tsx:508` | chapterId | cached `attributionRef.current` populated | `fetch /api/library/[id]/chapters/[chapterId]/attribute` |
| 4 | `/api/library/[id]/chapters/[chapterId]/attribute` GET | `attribute/route.ts:43` | bookId, chapterId | `{attribution, fromCache, parserReachable, stats}` | Prisma ChapterAttribution, sliceParagraphs, callParser, attributeByParse, attributeByRegex, mergeAttribution, computeStats, getOrComputeAttribution |
| 5 | `sliceParagraphs(html)` | `lib/attribution.ts:237` | HTML | `ParagraphRange[]` | regex |
| 6 | `callParser(text)` | `lib/attribution.ts:106` | text | `{sentences, cached, elapsedMs}` or null | HTTP `POST ${VNCORENLP_URL}/annotate`, 25s timeout |
| 7 | `attributeByParse(paragraphs, sentences, knownNames, genderByChar)` | `lib/attribution.ts:305` | parsed paragraphs + sentences | attribution map | `mapSentencesToParagraphs`, `findSubjectFor`, `resolveSubjectToName` |
| 8 | `attributeByRegex(paragraphs, knownNames)` | `lib/attribution.ts:384` | parsed paragraphs, known names | attribution map | `findQuoteSpans`, `regexFindSpeaker` |
| 9 | `mergeAttribution(parserOut, regexOut, llmOut)` | `lib/attribution.ts:640` | three attribution maps | merged map | confidence ordering |
| 10 | `getOrComputeAttribution(bookId, chapterIndex, mtime, computeFn)` | `lib/db/chapter-attribution.ts:105` | keys + compute closure | `{payload, fromCache}` | Prisma getCachedAttribution + setCachedAttribution |
| 11 | `detectSpeaker(text, paragraphIndex)` | `EbookReader.tsx:1148` | paragraph text, optional index | `{name?, voiceName?, source?}` | `ttsCharacterMap`, `chapterAttributionRef`, `findSpeakerForQuote` |
| 12 | `findSpeakerForQuote(text, qStart, qEnd, knownNames, prevQuoteEnd)` | `EbookReader.tsx:942` | full text, quote offsets, prev quote end, names | lowercase name or null | `ttsCharacterMap`, `VOICE_GENDER`, all the SPEECH/SUBJECT/THOUGHT/REACTIVE/OBJECT/Pronoun regexes |
| 13 | `detectEmotion(text, baseSpeed, baseNoise)` | `EbookReader.tsx:263` | text, base speed, base noise | `{label, emoji, speed, noiseScale, emotion}` | 6 keyword classes |
| 14 | `prefetchParagraph(chapterId, paragraphs, idx, speed, character?, emotion?, expressiveness?)` | `EbookReader.tsx:1207` | chapter id, paragraphs, idx, speed, character, emotion, expressiveness | `Promise<Blob>` | `fetch /api/tts` |
| 15 | `/api/tts` POST | `app/api/tts/route.ts:118` | body | `audio/wav` Response | `resolveVoiceForCharacter`, `getVoice`, `applyEmotionMarker`, HTTP `:5010/synthesize` |
| 16 | `resolveVoiceForCharacter(bookId, characterName, callIdx)` | `lib/ai/voice-selector.ts:167` | bookId, character, call idx | `VoiceAssignment \| null` | `listCharacters`, `listVoices`, `jitterForCall` (common only) |
| 17 | `applyEmotionMarker(text, emotion)` | `app/api/tts/route.ts:101` | text, emotion | text with optional `[marker]` | regex keyword evidence guard |
| 18 | HTTP `:5010/synthesize` | `unified_server.py:177` | TTS request | WAV | routes to `:5020`/`:5002`/in-process ONNX |
| 19 | Browser `<audio>` playback | `EbookReader.tsx:1330` | Blob URL | onended → resolve | DOM Audio API |

### 11.3 Character Detection Path (one-time per book)

```
UI button → POST /api/library/[id]/characters/detect
  → spawn python character_detector.py <epub> <model>
    → extract_chapter_samples(epub, max_chapters=5)
    → call_omlx(system, user, timeout=180)        POST :8080/v1/chat/completions
    → _parse_json_anywhere(raw)
    → _merge_duplicate_characters()              union-find by vi_g2p
    → returns JSON
  → TS suggestVoice()                            score + diversity pick
  → Returns { characters: [...suggestions...] } to UI
UI selects & applies → POST /api/library/[id]/characters
  → route.ts: characters/route.ts POST           resolve voiceName → voiceId, create voice rows
  → upsertCharacters(bookId, chars)              Prisma
  → setBookAudiobookStatus(id, "none")           invalidate audiobook cache
```

### 11.4 Round-Trip Reference

```
PDF/HTML/TXT upload
    │ ebook-conversion BullMQ
    ▼
src/worker/index.ts → pipeline/epub-parser.ts → data/library/<id>.epub + Book row
    │
    ▼ (later, lazy)
EbookReader.tsx → POST /api/library/[id]/characters/detect → character_detector.py
    │ oMLX
    ▼
CharacterDetection.tsx → POST /api/library/[id]/characters
    ▼
Database (SQLite) ─── Voice[], Character[], Settings[]
    │
    ▼ (lazy)
EbookReader.tsx → POST /api/library/[id]/chapters/[chapterId]/attribute
    │ VnCoreNLP server + regex (Tier 3b + Tier 1)
    │ cached in ChapterAttribution keyed by mtime
    ▼
detectSpeaker() per paragraph → name, voiceName
    │
    ▼
POST /api/tts → unified_server → vieneu/piper/moss-nano
    │
    ▼
<audio> playback
                                          OR     ┌──────────────────────────────────┐
                                                  │ AudiobookPanel.tsx              │
                                                  │ → POST /api/library/[id]/audiobook │
                                                  │ → BullMQ ebook-audiobook         │
                                                  │ → worker/audiobook.ts            │
                                                  │ → spawn python audiobook_generator.py │
                                                  │ → Tier 3b + Tier 1 (regex) + Tier 3a (LLM opt-in) │
                                                  │ → synthesize_segment × N        │
                                                  │ → concatenate_wavs → ffmpeg MP3 │
                                                  │ → data/audiobooks/<id>/<chapter>.mp3 │
                                                  │ → AudiobookChapter row status=ready │
                                                  └──────────────────────────────────┘
```

---

## 12. Weakness Analysis

### 12.1 Attribution-Specific Weaknesses

| # | Weakness | Severity | Where it bites |
|---|---|---|---|
| W-1 | **Nested dialogue not supported** | High | A line like `"Anh không muốn đi à?" cậu bé ngại ngùng hỏi, "Chỉ là…" ` collapses to one quote; the inner attribution (`"Anh không muốn đi à?"`) is attributed along with the outer if there's a speech verb in the BEFORE window. |
| W-2 | **No coreference resolver** | High | Multi-character dialogue that uses *only* `Anh`/`Cô`/`Hắn` for entire scenes will be attributed to the most-recent same-gender character, which often jumps whenever the narrative mentions the second character briefly. |
| W-3 | **Cross-chapter pronoun history** lost | High | The book-wide `last_by_gender` is computed only inside one chapter. Chapter 2's first pronoun often has no in-window gender signal → defaults to narrator voice for the first 1-2 paragraphs of every chapter. |
| W-4 | **500-char thought-verb window is a magic number** | Medium | Novels that put a thought/reflective paragraph 600+ chars before a quote misinterpret the speaker. |
| W-5 | **Gender is determined by voice builtin name only** | High | Any cloned voice without a recognizable builtin → `unknown` → pronoun resolution skips that character entirely. |
| W-6 | **`SUBJECT_ACTION_VERBS` exclusions leak in** | Medium | Excluded physical actions (đánh, vỗ, ôm, đấm) sometimes appear in novels as proper speech-introducing verbs (e.g., idiomatic `"Em đánh anh!"` = "You're killing me!" — `đánh` is slang for "to tease", not violence). |
| W-7 | **Best-effort recency heuristics** | Medium | Two female characters in the same 400-char window → only the right-most resolves. Books with alternating dialogue scenes suffer. |
| W-8 | **Honorifics leak into name recognition** | Low | `_NAME_SKIP` and `_HONORIFICS` filter some Vietnamese honorifics (thiếu gia, tiểu thư, …) so an LLM-detected character named *only* as `cô nương` won't be assigned; alias-list has it. |
| W-9 | **`object_marker` regex is hard-coded** | Low | Names containing marker substrings (e.g., a character actually named `Trợ Lý Của Hoàng Thượng`) would be filtered out. |
| W-10 | **LLM attribution in `attributeByLLM` truncates at `LLM_MAX_PARAGRAPH=80`** | Medium | Books with > 80 unresolved paragraphs in one chapter get the rest defaulted. |
| W-11 | **VnCoreNLP singleton JVM** | Medium | If the JVM hangs or crashes during parsing, all subsequent calls fail silently → entire chapter defaults to regex. Recovery requires restarting the sidecar container. |
| W-12 | **No paragraph ↔ attribution cache invalidation on character rename** | Low | A user who manually merges characters via VoicePanel → API gets a stale attribution cache pointing at the old name. The cache is `parserVersion`-keyed but not `charactersHash`-keyed. |

### 12.2 State / Pipeline Weaknesses

| # | Weakness | Impact |
|---|---|---|
| W-13 | **Two-source-of-truth regex engines** | Python `audiobook_generator.py` and TS `EbookReader.tsx` both re-implement the 6-pass engine. Every fix has to be mirrored — drift is documented in `AI_AUDIOBOOK_README.md` as a recurring hazard. |
| W-14 | **TS live reader uses sentence-level paragraphs; Python uses 2-newline paragraphs** | The two paths disagree about what counts as "a paragraph." Chapter-attribution `payload[]` indices are not directly compatible between the two paths in mixed-traffic scenarios. |
| W-15 | **Multiple copies of `BUILTIN_VIENEU` / `VIENEU_GENDER`** | Same set duplicated in 5+ files. Adding a new builtin requires edits in: `audiobook_generator.py`, `voice-selector.ts`, `worker/audiobook.ts`, `characters/route.ts`, `tts/route.ts`, `EbookReader.tsx`. Drift risk: high. |
| W-16 | **Browser `prefetchCacheRef` is unbounded** | Memory grows with chapters visited × unique (speed, voice, emotion, expressiveness) tuples. Long sessions can accumulate MBs. |
| W-17 | **No streaming TTS** | Every chapter segment is a synchronous 15-20s wait. Even with prefetch, the reader can stutter on chapter boundaries because both chapter-prefetch and same-chapter-paragraph-prefetch race for the same VieNeu singleton. |
| W-18 | **Single BullMQ worker for audiobook** | `concurrency=1, limiter max=2/60s` — large books (200+ chapters) take multiple hours. No per-book priority. |
| W-19 | **WAV→MP3 fallback silent** | If `ffmpeg` is missing the user gets a 48 kHz WAV stored per chapter (~7× the disk space of an MP3). `convertToMp3()` returns `null` and the audio still works, but space consumption balloons. |
| W-20 | **`voice_speed` and `defaultEmotion` mix concerns** | `Voice.defaultSpeed` (a model-level speed hint) and the per-call `jitter` (a presentational speed wobble) are both conflated under the same field. Renaming requires a schema migration. |
| W-21 | **OOO character gender backfill races** | `voice-selector.assignVoicesToCharacters` backfills `gender/tone` on existing characters only if new value isn't `unknown`. Once `unknown`, no reset unless user manually edits in VoicePanel. |
| W-22 | **`_LLM_EMOTION_CACHE` is process-local & LRU-evicts by insertion order** | Same dialogue appearing twice with a different prefix (e.g., trimmed by `\s+` cleanup) gets two cache entries. |
| W-23 | **Tier 3b uses `VNCORENLP_TIMEOUT_S=20s` but tier 3b is the FIRST layer run per chapter** | Cold JVM startup typically takes 10-15s; a long paragraph can take 5-8s. A single cold call can exceed 20s and silently fall back to regex. |
| W-24 | **No per-voice interpolation / blending** | VieNeu v3 supports reference audio blending but the unified_server always sends one `voice` OR one `ref_audio`. Can't mix two reference audios for character continuity. |
| W-25 | **Unified server `pick_backend` decides purely on Vietnamese presence** | A chapter with mixed Vietnamese + English falls back to Vietnamese-only VieNeu and the English text quality degrades. |
| W-26 | **`tts-character-map` in browser is rebuilt every reader session** | The map is fetched once per chapter but is not persisted in localStorage; reopening the same book re-fetches all voice/character rows. |
| W-27 | **`AudiobookPlayer` state is browser-local only** | Resume position + bookmarks + sleep timer are stored in `localStorage`, not in DB. Switching browsers/devices → lost. |
| W-28 | **No text-level cache for synthesized segments** | Even though `_LLM_EMOTION_CACHE` exists, the actual WAV bytes are NOT cached anywhere. Same dialogue synthesized 100× across 100 books costs the full TTS time each time. |
| W-29 | **Llm-driven segmentation (`USE_LLM_SEGMENTER=1`) overwrites the whole chapter** | A single bad JSON response wipes out all paragraph-level attribution for that chapter and falls through to regex. |
| W-30 | **VnCoreNLP doesn't honour prefill-guard** | If JVM heap maxes, returns 502 → silently falls back to regex without retry. |

### 12.3 Race Conditions / Concurrency

- BullMQ worker concurrency=1, rate 2/60s — no intra-book race within `audiobook.ts::generateEntireBook` (sequential).
- Per-chapter subprocess `python audiobook_generator.py` is *single-shot*, no shared state between runs except SQLite.
- Reader's `chapterAttributionInFlightRef: Set<string>` deduplicates inflight requests but doesn't prevent stale data when the user toggles between chapters quickly.
- `prefetchCacheRef` is per-`chapterId` but not per-user/per-book — opening two books in two tabs in the same browser would share the cache (read-only collisions). Negligible.
- The unified_server's global `_nano` (`OnnxTtsRuntime`) is lazily created in the parent process — concurrent requests serialise on whatever locks `OnnxTtsRuntime.synthesize()` takes internally. No app-level queue.

### 12.4 Memory Growth Hot Spots

| Resource | Where | Risk |
|---|---|---|
| Browser `prefetchCacheRef` | `EbookReader.tsx` | unbounded; one entry per unique (chapter, idx, character, speed, voice, emotion, expressiveness) tuple |
| `_LLM_EMOTION_CACHE` (Python) | `audiobook_generator.py:372` | bounded 4096 (LRU via popitem) — safe |
| VnCoreNLP `_cache` | `vncorenlp_server.py:148` | bounded 512 (LRU) — safe |
| VieNeu `_VOICES_CACHE` | `vieneu_server.py:41` | bounded to 10 entries (constant) — safe |
| BullMQ retention | `getQueue` default options | `removeOnComplete: 100`, `removeOnFail: 200` — safe |
| Browser audio Blobs | `<audio>` elements | explicit `URL.revokeObjectURL()` after play — safe |
| React state in `EbookReader.tsx` | single component, hundreds of state hooks | grows but bounded by props |
| Disk: per-book WAV→MP3 space | `data/audiobooks/<id>/` | W: temp; M: persistent. No GC. |

### 12.5 Technical Debt

- **Five duplicated copies** of the builtin voice list.
- **Two duplicated copies** of the entire 6-pass attribution engine.
- **Two duplicated copies** of the `SPEECH_VERBS` list (38 verbs in TS, similar in Python).
- **Multiple `_NAME_SKIP` / `_HONORIFICS` heuristics** for Vietnamese name validation that duplicate logic.
- **The `_regex_segment_chapter()` function is ~600 lines** — should be decomposed.
- The cached `Bookmarks[]` / `ttsContinuousPlay` / `ttsVoice` are managed in `localStorage`/`sessionStorage` directly inside `EbookReader.tsx`, scattered across multiple `useState`s.
- Tests cover EPUB validation/styling/builder but **none** cover attribution, speaker resolution, or TTS request building.

---

## 13. Improvement Opportunities (ordered by impact)

For each: difficulty (E/M/H/X = easy/medium/hard/expert), expected gain on attribution accuracy, risk, files touched, effort estimate.

| # | Improvement | Difficulty | Attribution gain | Risk | Files affected | Effort |
|---|---|---:|---|---|---|---|
| 1 | **Persist pronoun+gender history in the `ChapterAttribution` cache** (so a chapter's first paragraphs reuse the last-known characters from the previous chapter) | M | +5–10 % | low — adds one column to DB | `schema.prisma`, `chapter-attribution.ts`, `EbookReader.tsx`, `audiobook_generator.py` | 2–3 d |
| 2 | **Single source of truth for the 6-pass engine** (extract to a shared `@/lib/attribution/engine.ts` and import from both reader and worker via subprocess call) | H | +0 % but removes 600-line duplication | medium — refactor touches every reader call-site | `lib/attribution.ts`, `EbookReader.tsx`, `audiobook_generator.py` | 1–2 wk |
| 3 | **Allow user-curated gender per character** (override `Character.gender` to fix cloned-voice pronoun failures) | E | +10–15 % for books with cloned voices | low — new optional column | `schema.prisma`, VoicePanel, attribution helpers | 1 d |
| 4 | **Replace hard-coded `VIENEU_GENDER` with `Character.gender` column** for pronoun resolution; preserve `VIENEU_GENDER` only as fallback | M | +5–10 % across the board | low — both engines need to be updated | `attribution.ts`, `audiobook_generator.py`, `EbookReader.tsx` | 3–4 d |
| 5 | **Embeddings-based alias matching** (lightweight Vietnamese embedding model or fastText; replace `vi_g2p` canonical-only match) | M-H | +3–7 % on OCR-noisy books | medium — model weight, latency | `vi-text-qa.ts`, `vi_g2p.py`, character_detector, attributeByParse | 1–2 wk |
| 6 | **Add a small neural coreference resolver** (e.g., neuralcoref-style or a Vietnamese-trained BERT-CRF) for pronoun resolution Pass 5a | X | +10–20 % | high — model lifecycle, accuracy not guaranteed for Vietnamese | new file, integration | 3–4 wk |
| 7 | **Six-pass engine audit** + edge-case unit tests (parameterized over book samples) | M | ensures no regression | low | new test file | 1 wk |
| 8 | **Cache synthesized WAV bytes on disk** (key = sha1(text + voice + speed + emotion)) so pre-generation + live read-aloud share | M | speeds up re-generations ~80 % | medium — invalidation strategy | unified_server, worker/audiobook.ts, /api/tts | 1–2 wk |
| 9 | **Streaming chunked synthesis** for VieNeu | H | UX — eliminates visible gap | high — requires VieNeu-side streaming support | vieneu_server, unified_server, all callers | 2–3 wk |
| 10 | **Configurable `ATTR_THOUGHT_WINDOW_BEFORE`** per-book (default 500, but some novels need 1500) | E | +3–5 % on a subset | low | AudiobookPanel, attribution API | 0.5 d |
| 11 | **Store a `(bookId, characterId) → lastMentionOffset` index in DB** to build narrator-free bridge between chapters | M | +5–10 % cross-chapter | medium | schema.prisma, attribution API | 4–5 d |
| 12 | **Per-call `VoiceAssignment.jitter`** applied to non-common-pool voices when they're being read in close succession (subtle pitch wobble) | E | +UX variety | low | voice-selector.ts | 0.5 d |
| 13 | **Replace per-chapter Python subprocess with persistent Python worker** listening on a Unix socket for chapter requests | H | removes BullMQ subprocess latency overhead | high — replaces subprocess model | worker/audiobook.ts, audiobook_generator.py, unified_server (or new daemon) | 2–3 wk |
| 14 | **Reader-side prefetch chunked at finer granularity** (prefetch the next 3 sentences, not next 5 paragraphs) | E | UX latency | low | EbookReader.tsx | 0.5 d |
| 15 | **Auto-correct missing `defaultVoiceId`** by picking the first declared voice with `kind='narrator'` or `isDefault=true` fallback | E | prevents silent narrator-drop bug | low | audiobook_generator.py, voice-selector.ts | 0.5 d |
| 16 | **Add `dump_format` to character detector output** and write (name, gender, voice builtin, sample_lines) JSON file for offline review | E | UX for users to inspect detection | low | character_detector.py, /detect route | 1 d |
| 17 | **Replace 5 copies of `BUILTIN_VIENEU` with one import** in a shared package | E | maintenance | low | all 5 files | 0.5 d |
| 18 | **Add `confidence` field to the `Character` table** (set by character detector) so the picker prefers higher-confidence assignments | E | +minor stability | low | schema.prisma, character_detector, voice-selector | 1 d |
| 19 | **Implement per-book `narratorStyle` enum** (`first-person`, `third-person-omniscient`, `epistolary`) that biases pronoun resolution defaults | M | +5 % on first-person novels | medium — training data needed | Character model, attribution helpers | 1 wk |
| 20 | **Make `_call_omlx_segmenter` use VnCoreNLP for sentence segmentation before sending to LLM** (avoid LLM doing both segmentation AND attribution at once) | M | LLM reliability | low | audiobook_generator.py | 1 d |
| 21 | **Incremental `configHash` invalidation** keyed only on the changed characters (not full re-hash on any character tweak) | E | UX speed | low | worker/audiobook.ts, audiobook/route.ts | 1 d |
| 22 | **Add reading-position persistence in DB** (currently browser-local) | M | cross-device | low | schema.prisma, AudiobookPlayer.tsx, /api/library route | 1–2 d |
| 23 | **Add an explicit "unknown speaker" output section** in the AudiobookPanel UI (list of paragraphs that defaulted → click to assign manually) | M | UX curation, ultimate speaker accuracy +N % | low | UI only | 2–3 d |
| 24 | **Allow custom alias editing per character in the UI** (currently aliases are auto-merged only) | E | +3–5 % on tricky aliases | low | VoicePanel, /characters API | 1 d |
| 25 | **Add a "swap names" admin tool** (when LLM assigns voices to the wrong character, user can drag-drop to reassign and re-emit audio) | M | UX correction, eventual +10 % | medium | VoicePanel, /api/library route | 3–5 d |

The highest leverage improvements for speaker-attribution accuracy are #1, #3, #4, #6, #11.

---

## 14. Architecture Score (1-10, with rationale)

### Dialogue Extraction — **8/10**
- **Pros:** handles curly quotes, 「/」, em-dashes, action descriptions (`*vỗ vai*`); sentence-aware narration chunking; one LRU LRU-bounded paragraph split.
- **Cons:** no nested-dialogue support, no `<br>`-aware splitting, quote boundaries scan via a single regex that breaks when a chapter has a 1000-character single quote (truncated to 400 chars).

### Speaker Attribution — **7/10**
- **Pros:** layered Tier 1/3a/3b design; six-pass regex engine covers the major Vietnamese patterns; recoverable failures (every tier has a fallback); object-marker filter prevents the most common mis-attribute.
- **Cons:** no coreference model; gender inference depends on the 10 builtin voices; no cross-chapter carry-over; thought-verb window cap is a brittle constant; Tier 3b silently degrades to regex when the JVM has issues.

### Character Tracking — **8.5/10**
- **Pros:** persistent per-book `Character` + `Voice` tables; deterministic voice assignment by name-hash; union-find dedup using `vi_g2p`; idempotent upserts; user can backfill gender/tone incrementally.
- **Cons:** doesn't track *cross-book* character profiles (e.g., the same protagonist in a series); no character evolution/event log; common-pool rotation is by name hash, which can collide.

### Coreference Resolution — **3/10**
- **Pros:** pronoun-class heuristic with gender-aware history walking covers the common VN novel patterns; not blind to first/second-person self.
- **Cons:** no real coreference resolution; 400-char history is short; only knows pronouns in `PRONOUNS_FEMALE`/`PRONOUNS_MALE`; depends on `VIENEU_GENDER` for cloned voices; per-chapter reset erases long-distance dependencies.

### Voice Assignment — **9/10**
- **Pros:** scoring function considers gender (high-weight penalty for mismatch), age, tone, with deterministic tie-break; smart common-pool routing for minor/crowd; jitter for crowd voices; per-call jitter is deterministic on `(name, callIdx)` so re-reads are stable; full DB persistence.
- **Cons:** jitter applies *only* to common voices — main/supporter voices feel robotic on long books (no variation); no pitch / tempo variation; voice "consistency across the book" is enforced via same builtinName, but two characters can quietly share a builtin if they have identical profiles.

### Emotion Detection — **7/10**
- **Pros:** three tiers that fail independently into each other; content-evidence guard added 2026-07 to fix the "every cheerful → [cười]" bug; keyword rules carved to *exclude* generic narration verbs that polluted the input; LRU-bounded emotion cache survives across chapters.
- **Cons:** Tier 2 / Tier 3a are opt-in (default OFF), so the practical emotion quality depends entirely on Tier 1 keywords; emotion is text-classified per-dialogue, not per-utterance; no prosodic variation across long utterances.

### TTS — **8/10**
- **Pros:** multi-backend router with graceful Vietnamese/non-Vietnamese split; VieNeu v3-Turbo at 48 kHz with cloning; Piper as fallback; MOSS-Nano for non-Vietnamese cloning; clear audio stitching with 350 ms inter-segment pause; ffmpeg MP3 transcode at 96 kbps.
- **Cons:** VieNeu inference is non-streaming → first-segment warmup is 10-30 s; no segment-level WAV cache; silence gap is hard-coded 350 ms; no SSML; backend chosen purely by `has_vietnamese()` — mixed-language chapters degrade.

### Caching — **7.5/10**
- **Pros:** LRU caches at three layers (VnCoreNLP, LLM emotion, VieNeu voices); browser prefetch-ahead amortises latency; ChapterAttribution cache survives restarts via SQLite; configHash keeps audiobook chapters stable across voice tweaks.
- **Cons:** no disk cache for synthesized WAV bytes (same text synthesized twice → full inference); browser prefetch cache is unbounded; emotion cache drops on worker restart.

### Maintainability — **5/10**
- **Pros:** extensive comments and English docstrings explain the why; `AI_AUDIOBOOK_README.md` is a goldmine; tests exist for EPUB builder/validator/styler.
- **Cons:** the attribution engine is duplicated in two languages; builtin voice lists are in 5 files; the Python `_regex_segment_chapter` is 600+ lines; the `_NAME_SKIP` / `_HONORIFICS` heuristics duplicate the TS ones; bare `_backfill_*` and `_check_*` scripts litter the repo (`_backfill_gender.js`, `_backfill_helper.py`, `_check_default.js`, `_check_default2.js`, `_final_inspect.js`, `_inspect_voices.js`, `_set_default_voice.js`).

### Scalability — **7/10**
- **Pros:** BullMQ rate-limit 2/60s keeps the workspace from overloading oMLX / TTS; VnCoreNLP LRU 512 entries; SQLite is fast enough for a local library of < 1000 books.
- **Cons:** BullMQ concurrency=1 → 200-chapter book ≈ hours; per-chapter Python subprocess spawn is expensive (each spawns a venv-moss-nano python); no horizontal scale (single machine assumed); browser prefetch cache scales linearly with chapters visited.

### Code Quality — **6/10**
- **Pros:** TS is type-safe (`@prisma/client`-generated types); Python uses dataclasses/typing; every regex is documented with the offending test case; the regex engine includes enumeration of pitfalls in code comments; `extract_chapter_samples` / `_warm_model` / etc. are well-isolated.
- **Cons:** magic constants everywhere (`ATTR_WINDOW_BEFORE = 80`, `ATTR_NAME_TO_VERB_GAP = 70`, `MAX_CHAPTERS = 5`, `LLM_SEGMENT_MAX_CHARS = 8000`); one-off scripts in `_*.js` / `_*.py` indicate tribal knowledge; some long functions (`generate_chapter`, 100+ lines); no tests for attribution paths; CPU-bound code runs single-threaded.

---

## 15. Final Summary

### Executive Summary

The `Local-AI` workspace is a local-first Vietnamese-novel-to-audiobook pipeline built on a Next.js (TypeScript) front-end + Python FastAPI TTS backends + an optional VnCoreNLP parser sidecar + an oMLX-served local LLM. The core novelty is its **layered speaker-attribution engine** that handles Vietnamese `cô/anh/chị/ông/bà/hắn/nàng/cậu` pronouns and the closest-name-vs-object-marker problem. The same engine is re-implemented twice — once in TS (`EbookReader.tsx` + `lib/attribution.ts`) and once in Python (`audiobook_generator.py` + `vncorenlp_attribution.py`) — and consistency is documented as a recurring maintenance hazard.

### Current Strengths

- **Robust 6-pass regex attribution** that handles the most common Vietnamese narration patterns (named subject + speech verb in BEFORE window, em-dash attribution AFTER, thought-verb / reactive-action in 500-char window, pronoun-as-subject in 80-char + 400-char history, name-as-subject action-verb).
- **Tiered design** (parser → regex → LLM → default) with deterministic confidence scores and clear fallback semantics.
- **Deterministic voice assignment** by name-hash so re-reads are stable.
- **Persistent per-book character / voice / attribution cache** in SQLite.
- **Multi-backend TTS router** with VieNeu native (48 kHz, 10 voices, cloning), Piper legacy (22 kHz), and MOSS-Nano ONNX (non-Vietnamese cloning).
- **Emotion injection** with 3-tier priority and a content-evidence guard added 2026-07 to prevent over-triggering.
- **Browser prefetch-ahead** masks 15-20s per-segment latency on Apple Silicon.
- **BullMQ-backed audiobook pre-generation** with `configHash` so voice tweaks invalidate only affected chapters.

### Current Weaknesses

- **No real coreference resolution** — only a 400-char pronoun-history walk that resets per chapter.
- **Gender inference** depends on the 10 builtin VieNeu names; cloned voices without a recognizable builtin are skipped.
- **No disk cache for synthesized WAVs** — re-synthesis pays full inference cost.
- **Two parallel implementations of the attribution engine** risk drift; fixing a bug requires both codebases to be touched.
- **Five duplicates** of the built-in VieNeu voice list.
- **Limited to `vi` for Vietnamese-native quality**; mixed-language chapters degrade on TTS routing.
- **No tests for attribution**, only for EPUB builder/styler/validator.

### Top 10 Improvements (from §13, ranked)

1. **Persist pronoun+gender history in `ChapterAttribution`** so a chapter's first paragraphs reuse the last-known characters from the previous chapter. (+5–10 % attribution accuracy, M, 2-3 d)
2. **Allow user-curated `Character.gender`** to fix cloned-voice pronoun failures. (+10–15 %, E, 1 d)
3. **Replace hard-coded `VIENEU_GENDER`** with `Character.gender` for pronoun resolution. (+5–10 %, M, 3-4 d)
4. **Unify the two copies of the 6-pass engine** into one TypeScript implementation that the Python worker invokes via subprocess over a thin shim. (Maintainability win, H, 1-2 wk)
5. **Embeddings-based alias matching** (lightweight Vietnamese model) replacing the canonical-only `vi_g2p` match. (+3-7 %, M-H, 1-2 wk)
6. **Disk cache for synthesized WAVs** keyed by sha1(text + voice + speed + emotion). (Performance win, M, 1-2 wk)
7. **Cache the last-mentioned-character map per-book in SQLite** so pronoun history can cross chapter boundaries. (+5-10 %, M, 4-5 d)
8. **Auto-correct missing `defaultVoiceId`** by picking `kind='narrator'` or `isDefault=true`. (E, 0.5 d)
9. **Replace 5 copies of `BUILTIN_VIENEU`** with a single import. (E, 0.5 d)
10. **Add unit tests for the 6-pass engine** (parameterized over book samples) to catch regressions. (M, 1 wk)

### Long-Term Roadmap

- **Quarter 1**: Ship improvements 1, 2, 3, 7, 8, 9. Land basic attribution test coverage. Address the cross-chapter pronoun history gap and the cloned-voice gender inference gap.
- **Quarter 2**: Ship improvements 4, 6. Replace the per-chapter Python subprocess with a persistent Python worker daemon over a Unix socket. Add WAV caching.
- **Quarter 3**: Explore improvement 5 (embeddings) — eval a Vietnamese fastText/Word2Vec for alias clustering and replace `vi_g2p` for noise tolerance.
- **Quarter 4**: Investigate improvement 6 (small neural coreference resolver). Train or fine-tune a Vietnamese coreference model on novel corpora. Add streaming TTS support if VieNeu v3-Turbo exposes it.
- **Quarter 5+**: Cross-book character profiles (so the same `Y Đằng Ưu Nhi` across a series gets one voice), character-event log ("character X mentions character Y → strength +1"), and M4B audiobook export with chapter markers and cover art.

---

## Appendix A — File Inventory

| Concern | Files |
|---|---|
| **Live attribution** | `app/ebook-converter/src/components/library/EbookReader.tsx`, `app/ebook-converter/src/lib/attribution.ts`, `app/ebook-converter/src/lib/db/chapter-attribution.ts`, `app/ebook-converter/src/app/api/library/[id]/chapters/[chapterId]/attribute/route.ts`, `app/ebook-converter/src/app/api/library/[id]/chapters/[chapterId]/attribute/analyze/route.ts`, `app/ebook-converter/src/lib/vi-text-qa.ts` |
| **Offline attribution** | `app/tts-service/audiobook_generator.py`, `app/tts-service/vncorenlp_attribution.py`, `app/tts-service/vncorenlp/vncorenlp_server.py`, `app/tts-service/vi_g2p.py`, `app/tts-service/character_detector.py` |
| **Worker / queue** | `app/ebook-converter/src/worker/audiobook.ts`, `app/ebook-converter/src/worker/index.ts`, `app/ebook-converter/src/lib/queue/index.ts`, `app/tts-service/start_all.sh` |
| **DB schema** | `app/ebook-converter/prisma/schema.prisma` (Character, Voice, ChapterAttribution, AudiobookChapter), `app/ebook-converter/src/lib/db/voices.ts`, `app/ebook-converter/src/lib/db/audiobook.ts`, `app/ebook-converter/src/lib/db/settings.ts` |
| **Voice selection** | `app/ebook-converter/src/lib/ai/voice-selector.ts` |
| **TTS server (router)** | `app/tts-service/unified_server.py` |
| **TTS backends** | `app/tts-service/vieneu_server.py` (VieNeu), `app/tts-service/server.py` (Piper), MOSS-Nano via in-process ONNX |
| **Read-aloud API** | `app/ebook-converter/src/app/api/tts/route.ts`, `app/ebook-converter/src/lib/tts/client.ts` |
| **Character detection** | `app/ebook-converter/src/app/api/library/[id]/characters/detect/route.ts`, `app/ebook-converter/src/app/api/library/[id]/chapters/[chapterId]/detect-characters/route.ts`, `app/ebook-converter/src/components/library/CharacterDetection.tsx` |
| **Character management** | `app/ebook-converter/src/app/api/library/[id]/characters/route.ts`, `app/ebook-converter/src/app/api/library/[id]/voices/route.ts`, `app/ebook-converter/src/app/api/library/[id]/voices/[voiceId]/route.ts` |
| **Audiobook panel UI** | `app/ebook-converter/src/components/library/AudiobookPanel.tsx`, `app/ebook-converter/src/components/library/AudiobookPlayer.tsx`, `app/ebook-converter/src/components/library/VoicePanel.tsx`, `app/ebook-converter/src/components/library/VoiceDebugPanel.tsx`, `app/ebook-converter/src/components/library/ReadAloudPanel.tsx` |
| **LLM client** | `app/ebook-converter/src/lib/ai/omlx-client.ts`, `app/ebook-converter/src/lib/ai/index.ts` |
| **Reference documentation** | `AI_AUDIOBOOK_README.md`, `PROJECT_REVIEW_AND_RECOMMENDATIONS.md`, `ARCHITECTURE.md` |

## Appendix B — Vocabulary Cross-Reference

| Term | Definition (in this codebase) |
|---|---|
| **Speaker** | The character (canonical name) who said the quoted dialogue. The attribution engine's output. |
| **Voice** | A row in `Voice` table = {built-in VieNeu name OR custom ref-audio path}. Distinct from a character's mapped voice. |
| **Character** | A row in `Character` table = {name, aliases, voiceId, role, age, gender, tone}. Book-scoped. |
| **Builtin voice** | One of the 10 preset VieNeu voices (Ngọc Linh … Xuân Vĩnh). No reference audio needed. |
| **Custom voice** | A `Voice` row with `refAudioPath != ""`, used by VieNeu's instant-clone path. |
| **Common pool** | 4 `Voice` rows (`kind='common'`) created per book by `ensureCommonVoicePool()`. Minor / crowd characters rotate through them. |
| **Default voice** | The single `Voice` row with `isDefault=true` per book. Used for narration and unattributed dialogue. |
| **Attribution** | The mapping `{ paragraphIndex → { speaker, confidence, source } }`. |
| **Tier 1** | Local 6-pass regex engine. Default always-on. Confidence 0.55. |
| **Tier 3a** | oMLX LLM segmentation + per-segment emotion. Opt-in `USE_LLM_SEGMENTER=1`. |
| **Tier 3b** | VnCoreNLP parser (dependency parse → (sub, V)). Best-effort; falls back to Tier 1 when unreachable. Confidence 0.65-0.90. |
| **CHAPTER** | `htmlFiles` entry from `parseEpub()`. One chapter = one read aloud unit. |
| **Paragraph** | Sentence-grouped by `sliceParagraphs()` (TS) or 2-newline-grouped by `split_paragraphs_with_offsets` (Python). Used as the attribution key. |
| **Emotion marker** | `[cười]`, `[thở dài]`, `[hắng giọng]` — inline text tokens recognised by VieNeu. |
| **configHash** | sha256 over `{backend, voices[], characters[]}` — invalidates the audiobook chapter cache when voices change. |

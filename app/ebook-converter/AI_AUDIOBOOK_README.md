# AI Audiobook Pipeline — Documentation

> Complete reference for the emotional voice reader with multi-character
> voice cloning and pre-generation pipeline.
>
> **Last updated 2026-07-12.** This file is consistent with the current
> VieNeu-only TTS stack (single `vieneu_server.py` on `:5020`, no
> compatibility router). The Piper + MOSS-TTS-Nano + `unified_server.py`
> layout is gone as of the 2026-07-12 removal. The architectural flow
> diagrams (§1–§6) describe the current pipeline. For cross-cutting
> context, see [`../../README.md`](../../README.md) §TTS Stack and
> [`../../DEVELOPMENT_INSTRUCTIONS.md`](../../DEVELOPMENT_INSTRUCTIONS.md).

## Table of Contents

1. [What it does](#1-what-it-does)
2. [System architecture](#2-system-architecture)
3. [Services & ports](#3-services--ports)
4. [Data model (Prisma)](#4-data-model-prisma)
5. [File layout](#5-file-layout)
6. [User flow](#6-user-flow)
7. [API reference](#7-api-reference)
8. [TTS backends](#8-tts-backends)
9. [Voice & character model](#9-voice--character-model)
10. [Dialogue attribution](#10-dialogue-attribution)
11. [Emotion injection](#11-emotion-injection)
12. [Pre-generation pipeline](#12-pre-generation-pipeline)
13. [Configuration & env vars](#13-configuration--env-vars)
14. [Day-to-day operations](#14-day-to-day-operations)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What it does

The **AI Audiobook** pipeline turns any Vietnamese EPUB into a multi-character
audiobook:

1. **Auto-detect characters** in the book using a local LLM (oMLX)
2. **Suggest voices** for each character (10 built-in VieNeu voices, gender & tone aware)
3. **Pre-generate** the entire book's audio offline (no model needed at read time)
4. **Stream playback** as pre-rendered MP3/WAV with HTTP Range requests (instant seek)
5. **Control live read-aloud** with browser voice commands when the reader microphone is enabled
6. **Resume listening** with per-book progress, timestamp bookmarks, restart, and sleep timer controls

### Why this is special

- **Voice consistency**: the same character sounds identical across all 173
  chapters — the mapping is persisted in the DB
- **Multiple voices per chapter**: narrator + character dialogue each get a
  distinct voice
- **Emotion cues**: `[cười]`, `[thở dài]`, `[hắng giọng]` are injected based on
  the character's tone
- **100% offline**: no cloud TTS, no per-character data sent anywhere
- **48 kHz stereo** (vs Piper's 22 kHz mono) — dramatically better fidelity

---

## 2. System architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                  Next.js Reader UI  (ebook-converter on :3100)            │
│                                                                          │
│  Reader (EbookReader.tsx)                                               │
│  ├─ Microphone button → browser SpeechRecognition reader commands       │
│  └─ Headphones button → AudiobookPanel (right side panel)               │
│      ├─ "Pre-generation" tab   → AudiobookPanel.tsx                     │
│      └─ "Giọng & nhân vật" tab → VoicePanel.tsx + CharacterDetection.tsx │
│  AudiobookPlayer resumes progress, stores bookmarks, and has sleep timer │
│                                                                          │
│  ← POST /api/library/[id]/characters/detect  (oMLX via Python)         │
│  ← POST /api/library/[id]/characters         (apply suggestions)        │
│  ← POST /api/library/[id]/audiobook         (queue pre-generation)      │
│  ← GET  /api/library/[id]/audiobook/[file]  (stream rendered MP3/WAV)   │
│  ← GET  /api/tts/health                    (local TTS readiness)        │
│  ← POST /api/tts/preview                    (audition voices)            │
└──────────────────────────────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│            TTS Service  (Python FastAPI)                                 │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ tts-service/vieneu_server.py  (:5020)                                │ │
│  │  POST /synthesize  → Vietnamese-native, 48 kHz stereo, 10 voices    │ │
│  │  GET  /health       → used by Next.js to verify availability        │ │
│  │  Reference-path upload → instant voice cloning                       │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  (Piper and MOSS-Nano backends were removed on 2026-07-12.)              │
└──────────────────────────────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                  oMLX  (:8080)  +  Redis  (:6379)                         │
│                                                                          │
│  oMLX serves any loaded MLX model (currently whichever model is set     │
│  in `omlx-home/settings.json` as `default_model`). The character         │
│  detector samples 5 chapters → calls oMLX chat completions → returns     │
│  character names, genders, tones, sample lines.                          │
│                                                                          │
│  Redis is the BullMQ broker for the audiobook pre-generation jobs.       │
└──────────────────────────────────────────────────────────────────────────┘
```

### Worker pipeline

```
[UI: "Tạo audiobook" button]
         │
         ▼
[POST /api/library/[id]/audiobook] ──► BullMQ queue (ebook-audiobook)
         │                                     │
         │                                     ▼
         │                          [src/worker/audiobook.ts]
         │                                     │
         │                                     │ for each chapter:
         │                                     ▼
         │                          spawn audiobook_generator.py
         │                                     │ CHARACTER_MAP env var
         │                                     ▼
         │                          [app/tts-service/audiobook_generator.py]
         │                                     │
         │                                     │ split → resolve voice →
         │                                     │ synthesize each segment →
         │                                     │ concatenate and encode audio
         │                                     ▼
         │                          data/audiobooks/<bookId>/<chapter>.mp3 or .wav
         │                                     │
         │                                     ▼
         │                          Update AudiobookChapter row (status: ready)
         ▼
[UI polls /api/library/[id]/audiobook for progress]
         │
         ▼
[AudiobookPlayer streams chapter audio and stores resume/bookmarks locally]
```

---

## 3. Services & ports

| Port | Service | Process | Purpose |
|---|---|---|---|
| **3100** | Next.js | `npm run dev` | UI + API |
| **5020** | VieNeu-TTS v3 | `python vieneu_server.py` | Vietnamese-native (10 voices, 48 kHz) — **sole TTS backend as of 2026-07-12** |
| **8080** | oMLX | `omlx serve` | Local LLM (5 GB resident) |
| **6379** | Redis | `redis-server` | BullMQ broker |

> **Removed 2026-07-12:** Piper (`:5002`), the unified TTS router
> (`:5010`), and the MOSS-TTS-Nano backend. The audiobook pipeline
> talks directly to VieNeu at `:5020`; no compatibility router runs in
> front of it. The `UNIFIED_TTS_URL` env var is preserved as a back-compat
> alias for `VIENEU_BASE_URL`.

**Start everything:**
```bash
cd /Volumes/EXT-SSD/Users/anhl/Local-AI
./scripts/start_full_app.sh
```

Background mode:

```bash
cd /Volumes/EXT-SSD/Users/anhl/Local-AI
./scripts/start_full_app.sh --background
```

**Health check:**
```bash
curl -s http://localhost:3100/api/tts/health
curl -s http://localhost:3100/api/worker/status
curl -s http://127.0.0.1:5020/health
```

---

## 4. Data model (Prisma)

```prisma
model Book {
  id                  String  @id @default(uuid())
  title               String
  author              String
  language            String  @default("vi")
  ttsBackend          String  @default("vieneu")
  audiobookStatus     String  @default("none")  // none|generating|ready|partial|failed
  audiobookGeneratedAt DateTime?
  audiobookDurationMs   Int?

  voices            Voice[]              // book-scoped voice definitions
  characters        Character[]          // name + aliases + voice
  audiobookChapters AudiobookChapter[]   // per-chapter generated audio
  illustrations    Illustration[]        // AI-generated chapter images
  shelfBooks        ShelfBook[]
}

model Voice {
  id           String  @id @default(uuid())
  bookId       String
  name         String                            // "Bình An" or custom
  description  String?
  refAudioPath String                            // absolute path to reference WAV (10-30 sec clip), "" for built-ins
  language     String  @default("vi")
  isDefault    Boolean @default(false)
  defaultSpeed  Float?
  defaultEmotion String?  // calm|cheerful|sad|tense|romantic|angry|excited|neutral

  book       Book         @relation(fields: [bookId], references: [id], onDelete: Cascade)
  characters Character[]

  @@index([bookId])
}

model Character {
  id        String  @id @default(uuid())
  bookId    String
  name      String                            // canonical name as in the text
  aliases   String?                           // JSON: ["La Dạ", "lão giả", ...]
  voiceId   String?                           // → Voice row
  notes     String?

  book  Book   @relation(fields: [bookId], references: [id], onDelete: Cascade)
  voice Voice? @relation(fields: [voiceId], references: [id], onDelete: SetNull)

  @@unique([bookId, name])
  @@index([bookId])
}

model AudiobookChapter {
  id           String  @id @default(uuid())
  bookId       String
  chapterFile  String                            // e.g. "chapter001.xhtml" or "EPUB/chapter003.xhtml" — matches parseEpub htmlFiles
  chapterTitle String?                           // pre-extracted for UI display
  audioPath    String?                           // absolute path to concatenated WAV (data/audiobooks/<bookId>/<chapterFile>.wav)
  durationMs   Int?
  sizeBytes    Int?
  status       String  @default("pending")       // pending|generating|ready|failed|skipped
  progress     Int     @default(0)
  errorMsg     String?
  generatedAt  DateTime?
  configHash   String?                           // for invalidation when voice mapping changes

  @@unique([bookId, chapterFile])
  @@index([bookId, status])
}
```

---

## 5. File layout

```
/Volumes/EXT-SSD/Users/anhl/Local-AI/
├── app/
│   ├── ebook-converter/                            # Next.js project
│   │   ├── prisma/schema.prisma
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── api/
│   │   │   │   │   ├── library/[id]/
│   │   │   │   │   │   ├── voices/route.ts          ← upload/list voices
│   │   │   │   │   │   ├── voices/[voiceId]/route.ts ← test/delete voice
│   │   │   │   │   │   ├── characters/route.ts      ← upsert characters
│   │   │   │   │   │   ├── characters/detect/route.ts ← oMLX detection
│   │   │   │   │   │   ├── audiobook/route.ts        ← pre-gen API
│   │   │   │   │   │   └── audiobook/[chapterFile]/route.ts ← WAV streaming
│   │   │   │   │   └── tts/preview/route.ts         ← audition voice
│   │   │   │   ├── library/
│   │   │   │   └── (dashboard)/
│   │   │   ├── components/library/
│   │   │   │   ├── AudiobookPanel.tsx             ← pre-gen UI
│   │   │   │   ├── AudiobookPlayer.tsx             ← fixed-position audio player
│   │   │   │   ├── VoicePanel.tsx                 ← voice management
│   │   │   │   └── CharacterDetection.tsx          ← AI suggest UI
│   │   │   ├── lib/
│   │   │   │   ├── db/{voices,audiobook,books}.ts  # CRUD
│   │   │   │   └── tts/client.ts                   # VieNeu HTTP client (sole backend)
│   │   │   └── worker/
│   │   │       └── audiobook.ts                    # BullMQ worker
│   │   └── .env.local                              # OMLX_API_KEY, VIENEU_BASE_URL
│   └── tts-service/
│       ├── .venv/bin/python                        # Python 3.11 + httpx (VieNeu deps)
│       ├── voice_samples/                           # 10 built-in VieNeu voice WAVs (~9 MB)
│       ├── VieNeu-TTS/                              # Vietnamese TTS repo
│       ├── vieneu_server.py                         # VieNeu direct (port 5020) — sole TTS process
│       ├── audiobook_generator.py                   # chapter → WAV pipeline
│       ├── conversation_attribution.py             # Python port of attributeConversationChapter
│       ├── conversation_state_client.py             # HTTP client for /api/library/[id]/conversation-state
│       ├── vncorenlp_attribution.py                # Tier 3b parser (Python-side)
│       ├── vi_g2p.py                                # Vietnamese grapheme→phoneme + name canonicalisation
│       ├── character_detector.py                    # oMLX-based detection
│       ├── start_all.sh / stop_all.sh              # manage services
│       ├── measure_attribution.py                  # parity measurement script
│       ├── tests/                                   # 203 Python tests
│       └── scripts/
│           └── measure_attribution.py              # mirror of measure-attribution.ts
```

---

## 6. User flow

### 6.1 Setup voices
1. Open http://localhost:3100/library
2. Click any Vietnamese book → "Read"
3. Click 🎧 **Headphones** in the reader header
4. The right-side panel opens with two tabs: **Pre-generation** | **Giọng & nhân vật**

### 6.2 Detect characters automatically (AI)
5. Switch to **"Giọng & nhân vật"** tab
6. At the top, click **"Phân tích nhân vật"** (60-90 s)
7. UI shows detected characters with gender + tone badges + suggested voices
8. Each card has a **▶ nghe thử** button — click to preview the suggested voice
9. Override voice in dropdown if you prefer a different one
10. ✅ check the characters you want → **"Áp dụng N nhân vật"**

### 6.3 Pre-generate the audiobook
11. Switch to **"Pre-generation"** tab
12. Click **"Tạo audiobook"**
13. Watch progress per chapter (poll every 3 s)
14. Click play on any chapter to play the pre-rendered audio
15. Use the bottom player to resume, restart, add timestamp bookmarks, or set a sleep timer
16. Use the **Reset** button to delete all generated audio

### 6.4 Re-generate after voice changes
- Any voice/character change automatically invalidates the cache
- Next "Tạo audiobook" will only re-generate stale chapters
- A chapter is considered stale if its `configHash` ≠ current hash

---

## 7. API reference

All API routes live under `/api/library/[bookId]/`.

### `POST /api/library/[id]/characters/detect`

Runs oMLX on a sample of the book to extract characters.

**Request:** empty body
**Response (200):**
```json
{
  "language": "vi",
  "summary": "Fallback regex extraction (8 names from reasoning output).",
  "narrator_gender_hint": "unknown",
  "total_dialogue_lines": 0,
  "characters": [
    {
      "name": "La Dạ",
      "aliases": [],
      "gender": "male",
      "tone": "cold",
      "lines_estimate": 0,
      "sample_lines": ["Tu La giới chúa tể, Tu La Vương!"],
      "suggested_voice": "Thái Sơn",
      "already_in_db": false
    }
  ],
  "available_voices": [
    {"id": "Ngọc Lan", "gender": "female", "tone": "calm", "desc": "nữ, dịu dàng"},
    ...
  ]
}
```
**Latency:** 60–90 s (one oMLX call)
**Errors:** 404 if book not found, 500 if detector script missing / OMLX unreachable

### `POST /api/library/[id]/characters`

Upsert characters (also auto-creates Voice rows for built-in VieNeu names).

**Request:**
```json
{
  "characters": [
    {"name": "La Dạ", "aliases": ["lão giả"], "voiceName": "Thái Sơn"},
    {"name": "Thiếu nữ", "voiceId": "uuid-of-existing-voice"}
  ]
}
```
**Response (201):** full Character rows with joined voice
**Side effect:** sets `book.audiobookStatus = 'none'` → cache invalidated

### `POST /api/library/[id]/voices`

Upload a new custom voice (multipart).

**Form fields:**
- `file` (required): reference audio WAV (3–30 s)
- `name` (required)
- `description`, `language`, `isDefault`, `defaultSpeed`, `defaultEmotion`

### `POST /api/library/[id]/voices/[voiceId]?action=test`

Synthesize a short sample with this voice (used by VoicePanel's ▶ button).

### `POST /api/library/[id]/audiobook`

**Actions:**
- `{ action: "generate" }` — queue the whole book
- `{ action: "reset" }` — delete all generated audio files + rows
- `{ action: "regenerate_one", chapterFile: "EPUB/chapter003.xhtml" }`

### `GET /api/library/[id]/audiobook`

Returns book status + per-chapter rows + voice list.

### `GET /api/library/[id]/audiobook/[chapterFile]`

Streams the pre-generated audio with HTTP Range support. New generations are MP3 when ffmpeg is available, with WAV kept as the fallback format.

### `POST /api/tts/preview`

Audition any voice (built-in OR custom).

**Request:** `{ voice: "Bình An" | "<uuid>", text?: string, language?: "vi" }`
**Response:** `audio/wav` body

---

## 8. TTS backends

**As of 2026-07-12 the TTS service is consolidated to a single VieNeu process on `:5020`.** The historical Piper and MOSS-TTS-Nano backends, the `unified_server.py :5010` router, and the `UNIFIED_TTS_URL` compatibility variable have been removed. The `Settings.ttsProvider` value is always `vieneu`; setting `piper` or `moss-nano` returns a 400.

| Backend | Vietnamese | Voice cloning | Speed (M4) | Quality | Status |
|---|---|---|---|---|---|
| **VieNeu v3 Turbo** | ✅ native | ✅ instant from 3–5 s | 0.5–3 s / segment | 48 kHz stereo | **default, sole backend** |
| ~~Piper~~ | ✅ fixed voices | ❌ | 0.5 s / segment | 22 kHz mono | **removed 2026-07-05** |
| ~~MOSS-TTS-Nano~~ | ❌ | ✅ instant | 4–5 s / segment (English) | 48 kHz | **removed 2026-07-05** |

The audiobook pipeline calls VieNeu directly at `http://127.0.0.1:5020/synthesize` (overridable via `VIENEU_BASE_URL`). The legacy `UNIFIED_TTS_URL` env var is preserved as a back-compat alias for `VIENEU_BASE_URL`; setting it to `:5010` will fail the health check because no router runs on that port anymore.

Why we removed the other backends:
- **Piper** — Vietnamese voices were lower fidelity (22 kHz mono) and the catalogue didn't cover all character roles. Now that VieNeu covers the same diacritic-safe Vietnamese path at 48 kHz stereo, the lower-fidelity fallback is unnecessary.
- **MOSS-TTS-Nano** — Designed for English voice cloning; Vietnamese diacritics are unreliable. VieNeu cloning (`reference_path` upload) replaces it for custom voices.
- **`unified_server.py :5010`** — When the routing table collapsed to a single backend, the router was a pure indirection layer with no production value.

`Settings.ttsProvider` accepts only `vieneu`; any other value returns 400. The `backend` field on synthesize requests is ignored.

---

## 9. Voice & character model

### Voice resolution priority

When synthesizing a segment, the worker resolves which voice to use:

```
1. If segment.character is set:
   a. Look up Character → Voice in DB
   b. If voice is a built-in VieNeu name → send `voice` to unified server
   c. If voice has refAudioPath → send `reference_path` (cloning)
2. Else: use the book's default voice (Voice row with isDefault=true)
3. Else: use Bình An (Vietnamese); English-language segments fall back to a generic English voice
```

### Voice presets (built-in VieNeu)

| ID | Gender | Tone | Vietnamese desc |
|---|---|---|---|
| Ngọc Lan | female | calm | nữ, dịu dàng |
| Mỹ Duyên | female | calm | nữ, mượt mà |
| Trúc Ly | female | cheerful | nữ, trẻ trung |
| Ngọc Linh | female | cheerful | nữ, tươi sáng |
| Gia Bảo | male | calm | nam, mượt mà |
| Đức Trí | male | calm | nam, rõ ràng |
| Thái Sơn | male | cold | nam, chắc khỏe |
| Bình An | male | calm | nam, điềm đạm |
| Trọng Hữu | male | mysterious | nam, uyên bác |
| Xuân Vĩnh | male | cheerful | nam, vui tươi |

The AI suggester scores each voice per character:
- Gender match: +5
- Tone match: +3
- Tiebreaker: alphabetical

---

## 10. Dialogue attribution

The audiobook generator walks each chapter's text and splits it into:

1. **Narration segments** — text between quote pairs, default voice
2. **Dialogue segments** — text inside `""`/`""`/`「」`/`『』`/etc.

For each dialogue segment, `find_speaker_for_quote(q_start, q_end)` in
[`audiobook_generator.py`](../../tts-service/audiobook_generator.py)
runs **six passes** in order — the first hit wins. Each pass is mirrored
to the browser-side `findSpeakerForQuote()` in
[`EbookReader.tsx`](../../ebook-converter/src/components/library/EbookReader.tsx)
so live read-aloud and pre-generated audiobooks behave identically.

| Pass | Window | Logic |
| --- | --- | --- |
| 1. BEFORE speech-verb | `prev_quote_end .. q_start`, max 80 chars back | For every name occurrence, look for a Vietnamese speech verb (`nói`, `hỏi`, `quát`, `thì thầm`, `cười nói`, …) within ~70 chars AFTER it. Pick the (name, verb) pair with the smallest name-to-verb distance. **Object-marker filter** drops names preceded by `nhìn / với / của / cho / gặp / …` (those are objects, not subjects). |
| 2. AFTER speech-verb | 40 chars after the quote | `name + (gap) + speech_verb`, anchored at the start of the AFTER window. |
| 3. AFTER em-dash | first 40 chars after the quote | `— Name` (alone, optional punctuation) — catches "— Ai đó?" attribution. |
| 4. BARE-EXCLAMATION fallback (thought-verb / reactive-action) | 500 chars back | When passes 1–3 fail, scan the **wider** 500-char BEFORE window for: **(a)** thought verbs (`cảm thán`, `nghĩ`, `thầm nghĩ`, `thì thầm`, `lẩm bẩm`, `tự nhủ`, `bình phẩm`, `cảm nhận`, …) — the subject is the THINKER, speaker of the following reaction quote; **(b)** reactive actions (`mỉm cười`, `nháy mắt`, `vỗ vai`, `ghé tai`, `ôm`, `nắm tay`, `vuốt tóc`, …) — the subject is the DOER. Among multiple matches, pick the LATEST name+verb pair (most recently expressed thought wins). Object-marker filter still applies. |
| 5a. PRONOUN RESOLUTION (subject-as-pronoun) | 80 chars before + 400 chars history | New in 2026-07-04. Catches Vietnamese pronouns (`Cô`, `Anh`, `Chị`, `Ông`, `Bà`, `Em`, `Cậu`, `Chú`, `Bác`, `Nàng`, `Chàng`) used as the subject of a quote-introducing verb. The pronoun is resolved to the **most recently mentioned same-gender character** (gender inferred from the character's voice builtin name via `VIENEU_GENDER`: Ngọc Lan/Linh/Mỹ Duyên/Trúc Ly = female; Bình An/Gia Bảo/Đức Trí/Thái Sơn/Trọng Hữu/Xuân Vĩnh = male). |
| 5b. NAME AS SUBJECT (action-verb) | 80 chars before | When the BEFORE window ends with a known name + a quote-introducing **action verb** (`gọi`, `hỏi`, `cười khẽ`, `hừ`, `quay phắt đầu`, `nhéo`, `reo`, `cất tiếng`, …) right before the quote, the name is the speaker. Pure physical actions (`đánh`, `vỗ`, `ôm`, `đấm`) are deliberately excluded — they describe what the subject DID and the following quote is usually the OTHER character's response. |

The wider 500-char window for pass 4 is intentional: thought verbs like
`"Y Đằng Long … âm thầm cảm thán: …"` often sit far back from the following
reaction quote, and the THINKER is the speaker, not the closest name. Without
pass 4 the closest-name logic would either mis-attribute to a closer object
name (e.g. `Tiểu Ưu Nhi` after `cảm thán`) or fall back to the narrator voice.

Passes 5a/5b were added to fix lines like `Anh hư quá đi, người ta nhớ anh
như vậy, …` where the subject is the pronoun `Cô` (she) — pass 1 needs a
literal character name to attribute to. Pass 5a builds a gender-aware
"most-recent character" map from the 400-char history, then resolves the
pronoun to it. Pass 5b handles the same shape but with a literal name +
action verb (e.g. `Y Đằng Ưu Nhi quay phắt đầu lại, "Long……"`).

If all six passes miss, the segment falls back to the book's default voice
(`Voice.isDefault=true`) — by convention **Bình An (male)** for the Vietnamese
novels we've tested, but configurable per book. When no `isDefault` voice is
set, the unified TTS server falls back to its built-in default.

### Worked examples

#### Example A — Pass 4 (thought-verb)

Source text (chapter 5 of `Bắt Đầu 100 Triệu Năm Tu Vi` style):

```
Ngay cả Y Đằng Long đang vội vàng đón tiếp khách khứa cũng không thể
không âm thầm cảm thán: Tiểu Ưu Nhi thật sự trưởng thành rồi!
"Quỷ nghịch ngợm!"
```

- Pass 1 (BEFORE speech-verb, 80 chars): contains `cảm thán` (not a
  SPEECH_VERB) → no match.
- Pass 2 (AFTER, 40 chars): empty → no match.
- Pass 3 (em-dash): no em-dash → no match.
- Pass 4 (BARE-EXCLAMATION, 500 chars): finds
  `Y Đằng Long … âm thầm cảm thán` → speaker = **Y Đằng Long**, not
  `Tiểu Ưu Nhi` (closer name but is the object of `cảm thán`).

→ `"Quỷ nghịch ngợm!"` is spoken in Y Đằng Long's voice.

#### Example B — Pass 5a (pronoun resolution)

Source text (same chapter):

```
"Cô vui vẻ gọi một tiếng, ôm lấy thắt lưng anh trai,
 "Anh hư quá đi, người ta nhớ anh như vậy, thế mà anh lại vô lương tâm
  vừa thấy mặt đã suýt làm em sợ muốn chết!""
```

- Pass 1 (BEFORE speech-verb, 80 chars): looks for `[name] … [speech-verb]`.
  The closest names are `anh trai` (noun phrase, not in `char_aliases`) and
  `Y Đằng Ưu Nhi` from the previous sentence (too far back, beyond the 80
  char window after `prev_quote_end`) → no match.
- Passes 2-4: no AFTER verb, no em-dash, no thought verb → no match.
- Pass 5a (PRONOUN): BEFORE window contains `Cô … gọi`. The 400-char history
  holds `Y Đằng Ưu Nhi` (voice = Ngọc Lan = female). Pronoun `Cô` is
  female → resolves to **Y Đằng Ưu Nhi**.

→ `"Anh hư quá đi, …"` is spoken in Y Đằng Ưu Nhi's voice (Ngọc Lan, female).

#### Example C — Pass 5b (name-as-subject)

Source text:

```
Y Đằng Ưu Nhi bị âm thanh bất ngờ làm hoảng sợ, quay phắt đầu lại,
 "Long……"
```

- Pass 1: closest name = `Y Đằng Ưu Nhi`, but the verb `quay phắt` is not a
  SPEECH_VERB → no match.
- Pass 5b: matches `Y Đằng Ưu Nhi … quay phắt` (SUBJECT_ACTION_VERBS) →
  speaker = **Y Đằng Ưu Nhi**.

→ `"Long……"` is spoken in Y Đằng Ưu Nhi's voice.

### Known limitations

- Books that put character names very far from the speaker action
  (>500 chars back) will still fall back to the narrator voice.
- The TS path and Python path must be kept in sync — passes 4 and 5a/5b were
  added to both `EbookReader.tsx::findSpeakerForQuote` and
  `audiobook_generator.py::find_speaker_for_quote` in the same change.
- Thought-verb list excludes bare modifiers like `âm thầm`, `thầm`,
  `trong lòng` — they must be absorbed into the gap, not matched as the
  predicate itself. Adding them would cause early stopping at the modifier
  and return a wrong/partial thinker.
- SUBJECT_ACTION_VERBS (pass 5b) deliberately excludes physical actions
  (`đánh`, `vỗ`, `ôm`, `đấm`, `hôn`, …). These describe what the subject
  DID; the quote that follows is usually the OTHER character's reaction
  ("he hit her lightly. 'Ouch!'" — the "Ouch" is hers, not his). Including
  them in pass 5b would cause systematic mis-attribution.
- Pass 5a pronoun resolution depends on `VIENEU_GENDER` — cloned voices
  whose display name does not match any builtin fall back to `unknown`
  and are skipped (their lines will fall through to a later pass or to
  default voice).
- Lines where two characters alternate with no narration between them
  (e.g. `A said X. "Y." B said Z.`) still cannot be attributed from text
  alone — the gap between quotes contains no signal. These will fall
  back to default voice.

---

## 11. Emotion injection

VieNeu supports inline emotion markers in synthesis text:
- `[cười]` → laugh
- `[thở dài]` → sigh
- `[hắng giọng]` → clear throat

The generator inserts these automatically:

1. **Tier 1 — keyword matching** in any segment (regex patterns from
   `audiobook_generator.py::KEYWORD_EMOTIONS`):
   - Distinctive laugh patterns only: `haha`, `hehe`, `cười lớn`,
     `cười khanh khách`, `cười khúc khích`, `(cười gằn)`, `(cười khổ)`,
     `\*khanh khách\*`, … → adds `[cười]`
   - Sighs: `thở dài`, `thở phào`, `than thở`, `\*thở dài\*`,
     `(than thở)` → adds `[thở dài]`
   - Throat-clearing: `hắng giọng`, `khóc thét`, `khóc nức nở`, `sniff sniff`
     → adds `[hắng giọng]`
   - Each marker is added at most once per segment.
   - Bare `cười` / `khóc` are deliberately OMITTED (they appear in narration
     as descriptive nouns like `nụ cười` / `khóc nhè`) — matching them caused
     `[cười]` to be injected into nearly every paragraph.
   - Trailing `…` is NOT mapped to `[thở dài]` (Vietnamese uses ellipses for
     hesitation, not sighs).

2. **Tier 2 — oMLX classification** (default OFF via `ENABLE_LLM_EMOTION`):
   one batched call classifies all dialogue segments in a chapter and
   re-injects markers based on the LLM's per-segment label.

3. **Tier 3a — oMLX segmenter** (default OFF via `ENABLE_LLM_SEGMENTER`):
   when oMLX is healthy, replace the regex splitter with an LLM-based
   one that returns character + emotion per segment in one call. Falls
   back to Tier-1 regex on oMLX error.

### Emotion → marker mapping (`emotionMarker()` in `/api/tts` route)

Tightened on 2026-07-04 to fix the "CẢM XÚC TỰ ĐỘNG injects `[cười]`
between every sentence" over-trigger bug.

| LLM/detector label | Marker |
| --- | --- |
| `laugh`, `amused` | `[cười]` |
| `sad`, `sigh`, `regret`, `buồn` | `[thở dài]` |
| `angry`, `rage`, `tense`, `serious`, `cold`, `sneer`, `tức giận`, `căng thẳng` | `[hắng giọng]` |
| **anything else** — `cheerful`, `excited`, `happy`, `joy`, `lãng mạn`, `hành động`, `neutral`, … | **no marker** |

**Content-evidence guard** (also added 2026-07-04): even when the LLM
labels a segment `laugh`, `[cười]` is only injected if the segment text
actually contains a laugh pattern (`haha / hehe / cười lớn / *khanh
khách* / (cười gằn) / …`). Without this guard, the LLM's "cheerful"
default tone caused every dialogue to be marked as a laugh.

Speed/noise adjustments (via `detectEmotion` in `EbookReader.tsx`) still
carry the paragraph's tone — only the explicit markers above are gated.

The marker `defaultEmotion` on the character's Voice row is the source of
truth for the Tier-1 tone classification (passed via `resolveVoiceForCharacter`).
Edit via:
- UI: VoicePanel → click pencil on a voice row
- API: `PATCH /api/library/[id]/voices/[voiceId]` with `{ defaultEmotion: "cheerful" }`

---

## 12. Pre-generation pipeline

### Worker (`src/worker/audiobook.ts`)

Listens on BullMQ queue `ebook-audiobook`. Each chapter is one job:

1. Parse EPUB with `parseEpub()`
2. Load voices + characters from DB
3. Serialize character→voice map as `CHARACTER_MAP` env var (JSON)
4. Spawn `audiobook_generator.py` for one chapter
5. Generator segments → synthesizes → concatenates audio → writes MP3 when
   ffmpeg is available, with WAV fallback under `data/audiobooks/<bookId>/`
6. Update `AudiobookChapter` row to `status=ready` + `audioPath + durationMs + sizeBytes`

### Concurrency & rate limits

- BullMQ: `concurrency=1`, `limiter: max 2 per 60s` (CPU-bound)
- Generator: 300-second per-segment HTTP timeout (VieNeu first call is slow)
- Vietnamese text typically takes ~0.5–3 s per segment
- A 13 KB chapter (~48 segments) finishes in ~3 minutes

### Per-segment HTTP details

```
POST http://127.0.0.1:5020/synthesize
{
  "text": "...",                  ← segment text (with emotion markers if any)
  "backend": "vieneu",            ← forced
  "language": "Vietnamese",
  "speed": 1.0,
  "voice": "Bình An",             ← for built-in characters
  "reference_path": "/path.wav"   ← for custom cloned voices
}
```

---

## 13. Configuration & env vars

### `app/ebook-converter/.env.local`

```bash
# oMLX (for character detection)
OMLX_BASE_URL=http://127.0.0.1:8080/v1
OMLX_API_KEY=<from ~/.omlx/settings.json auth.api_key>
OMLX_MODEL=<currently loaded model name>

# TTS service (VieNeu is the sole backend as of 2026-07-05)
# UNIFIED_TTS_URL is preserved as a back-compat alias for VIENEU_BASE_URL;
# setting it to :5010 will fail the health check.
VIENEU_BASE_URL=http://127.0.0.1:5020
UNIFIED_TTS_URL=http://127.0.0.1:5020   # back-compat alias
TTS_PYTHON=/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11

# Storage
DATABASE_URL="file:./data/ebook-converter.db"
UPLOAD_DIR=./data/uploads
OUTPUT_DIR=./data/outputs
MAX_FILE_SIZE_MB=100
```

### Character-map env var (set by worker)

`CHARACTER_MAP` — JSON-encoded, passed to `audiobook_generator.py`:

```json
{
  "voices_by_id": {
    "uuid-1": { "name": "Bình An", "refAudioPath": "", "isBuiltinVieNeu": true, "defaultEmotion": null }
  },
  "characters": [
    { "name": "La Dạ", "aliases": [], "voiceId": "uuid-1" }
  ],
  "default_voice_id": "uuid-1"
}
```

### Path resolution

The Next.js worker looks for `tts-service` in this order:
1. `process.cwd() + ../tts-service` (dev layout)
2. `process.cwd() + app/tts-service` (legacy)
3. `process.cwd() + tts-service`
4. `/Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service` (absolute fallback)

For Python interpreter, it falls back to the in-container / system `python3`
(Dockerfile installs Python 3.11 + `httpx` for this). The dev-time layout
uses the root `app/tts-service/VieNeu-TTS/.venv/bin/python` interpreter
which has the VieNeu runtime deps.

---

## 14. Day-to-day operations

### Start everything

```bash
cd /Volumes/EXT-SSD/Users/anhl/Local-AI
./scripts/start_full_app.sh
```

### Stop everything

```bash
cd /Volumes/EXT-SSD/Users/anhl/Local-AI
./scripts/start_full_app.sh --stop
```

### Health check (one-liner)

```bash
for p in 3100 5020 8080 6379; do
  code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" http://127.0.0.1:$p/ 2>/dev/null)
  echo ":$p  $code"
done
```

Expected:
```
:3100  200      # Next.js
:5020  404      # VieNeu (only /health, no /)
:8080  404      # oMLX (no /, but /v1/... works)
:6379  -        # Redis (HTTP probe doesn't work; use redis-cli ping)
```

Note: ports 5002 (Piper) and 5010 (unified router) are no longer expected to be listening. Their absence is normal after the 2026-07-05 TTS consolidation.

### Update oMLX model

If you load a different model in oMLX, update `.env.local`:
```bash
LOADED=$(curl -s http://127.0.0.1:8080/health | python3 -c "import json,sys; print(json.load(sys.stdin)['default_model'])")
sed -i '' "s|^OMLX_MODEL=.*|OMLX_MODEL=$LOADED|" .env.local
```
Then restart Next.js dev server.

### Re-detect characters for a book

Delete old Character rows first (they have unique bookId+name constraint):
```bash
cd /Volumes/EXT-SSD/Users/anhl/Local-AI/app/ebook-converter
node -e "
const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
p.character.deleteMany({where:{bookId:'YOUR_BOOK_ID'}}).then(r => {
  console.log('Deleted', r.count, 'characters');
  return p.\$disconnect();
});
"
```
Then click "Phân tích nhân vật" again in the UI.

---

## 15. Troubleshooting

### "Detector not found at …"

Fixed in current code — the route uses `resolveTtsServiceDir()` which
tries four candidate paths. If you still see this:
```bash
ls -la /Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service/character_detector.py
```
If the file is elsewhere, set `TTS_SERVICE_DIR` env var.

### "TTS service unreachable"

Unified server isn't running. Start it:
```bash
bash /Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service/start_all.sh
curl -s http://127.0.0.1:5020/health
curl -s http://localhost:3100/api/tts/health
```

The app also exposes this in the navigation, reader header, and Settings TTS health panel.

### "OMLX API key required"

`.env.local` doesn't have `OMLX_API_KEY`. Get it:
```bash
cat /Volumes/EXT-SSD/Users/anhl/Local-AI/omlx-home/settings.json | python3 -c "
import json, sys
print(json.load(sys.stdin)['auth']['api_key'])
"
```
Add to `.env.local`:
```
OMLX_API_KEY=<paste>
OMLX_MODEL=<currently loaded model>
```

### Character detection returns 0 characters

The book might:
- Be in a language oMLX doesn't understand well
- Have very little dialogue
- Be in a format that confuses the LLM

Try increasing MAX_CHAPTERS in `character_detector.py`:
```python
MAX_CHAPTERS = 10  # was 5
```

### Audiobook WAV plays but with wrong voice

Check `/api/library/[id]/characters` — character → voice mapping should be
intact. If a character shows "(none)" voice, re-apply through the UI.

### "No module named 'httpx'" in detector

Install in the venv:
```bash
/Volumes/EXT-SSD/Users/anhl/Local-AI/.venv/bin/pip install httpx
```

### BullMQ says "backend: piper" but I sent "vieneu"

Fixed in current code. The audiobook API and worker now default to `vieneu`,
and the queue type accepts `vieneu`. If you still see `piper`, restart the
Next.js dev server and worker:

```bash
cd /Volumes/EXT-SSD/Users/anhl/Local-AI
./scripts/start_full_app.sh --stop
./scripts/start_full_app.sh --background
```

### Old failed job keeps getting returned

BullMQ dedupes by `jobId`. If you change the request body but keep the same
`audiobook:<bookId>:<chapterFile>` jobId, BullMQ returns the OLD job. Either:
1. Wait for the old job to expire (BullMQ removes failed jobs after `removeOnFail: 100`)
2. Delete the old job manually:
```bash
redis-cli DEL "bull:ebook-audiobook:audiobook:<BOOK_ID>:<CHAPTER>"
redis-cli ZREM bull:ebook-audiobook:completed "audiobook:<BOOK_ID>:<CHAPTER>"
```

### "output WAV not found at …"

Usually means the Python generator wrote to a slightly different path than
the worker expects. Fixed in current code — see
`audiobook_generator.py` line 461 (CLI `out-dir` is now optional-book-id).

### Disk space

Pre-generated WAVs are big (~50-70 MB per chapter for a typical novel).
A 173-chapter book = ~10 GB. Check disk:
```bash
du -sh /Volumes/EXT-SSD/Users/anhl/Local-AI/app/ebook-converter/data/audiobooks/
df -h /Volumes/EXT-SSD
```

---

## Appendix A: End-to-end test results (2026-06-28)

The pipeline was fully verified on a real Vietnamese novel:

```
Book: Bắt Đầu 100 Triệu Năm Tu Vi (a75c2296-...)
Chapters processed: chapter003 (EPUB/chapter003.xhtml, 11 KB)
Backend: VieNeu v3 Turbo
Generation time: 649.6 s
Output: 54.6 MB WAV at 48 kHz mono
Segments: 48 (37 narration + 11 dialogue)
Voice distribution:
  Bình An (narrator): 37 segments
  Thái Sơn (La Dạ): 9 segments
  Bình An (Thanh niên tuấn lãng): 1 segment
  Mỹ Duyên (Giọng nói kinh ngạc): 1 segment

Status: ✓ ready
Audio path: data/audiobooks/<bookId>/EPUB_chapter003.wav
```

---

## Appendix: Vietnamese dialogue patterns

The generator recognises these quote pairs:

| Open | Close | Unicode | ASCII equivalent |
|---|---|---|---|
| `"` | `"` | U+201C / U+201D | " |
| `「` | `」` | U+300C / U+300D | |
| `『` | `』` | U+300E / U+300F | |
| `"` | `"` | U+0022 | |
| `<<` | `>>` | literal | (rare) |

Em-dash `—` (U+2014) and colon `:` are used to attribute dialogue to the
preceding character name.

If a book uses an unsupported dialogue format (e.g. `*"dialogue"*` italic),
add the relevant quote characters to `QUOTE_OPEN_CHARS` / `QUOTE_CLOSE_CHARS`
in `audiobook_generator.py`.

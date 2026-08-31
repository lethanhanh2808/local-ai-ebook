# Phân Giọng (Voice Assignment) — Enhancement Plan

> Goal: extend the full-page **Phân giọng** experience (`src/components/library/VoiceAssignPage.tsx`)
> with 5 features the user requested. This document is written to be picked up cold in a new session.

## 1. Context & current state

- **Page**: `app/ebook-converter/src/components/library/VoiceAssignPage.tsx`
  (route: `app/ebook-converter/src/app/library/[id]/assign-voices/page.tsx`).
- **Data model**: per-chapter `ChapterVoicePlan` (Prisma `chapterVoicePlan`, keyed by `bookId + chapterIndex`).
  - Stored shape: `sentences: [{ i, text, charId, voiceId, source, para }]`.
  - `voiceId === null` ⇒ narration (người dẫn chuyện) voice.
- **APIs already in place**:
  - `GET/PUT /api/library/[id]/chapters/[chapterId]/voice-plan` — returns/stores the plan. `GET` auto-builds a *suggested* plan via `buildSuggestedVoicePlan()` (attribution only; `voiceId` stays `null`).
  - `POST /api/tts` — synthesizes one text with `{ text, voice, bookId, language, emotion, ... }` (see `EbookReader.tsx` ~line 3051 for the exact body).
  - `POST /api/tts/preview` — voice audition (used in the picker today).
  - `POST /api/library/[id]/audiobook` with `{ action: 'regenerate_one', chapterFile }` — already queues a **single** chapter for audiobook generation (worker `generateOneChapter`).
- **Python generator** (`app/tts-service/audiobook_generator.py`) **already consumes a per-sentence voice plan** via the `VOICE_PLAN` env var (`_load_voice_plan()` / `_resolve_voice_plan_override()` / applied in `generate_chapter()`). It matches plan rows to segments by normalized text and overrides the voice. **The worker does NOT currently pass `VOICE_PLAN`** — that is the only gap for feature (d).
- **Chapter id vs file**: `GET /api/library/[id]/chapters` returns `{ id: <basename e.g. "chapter001">, title, order, file: <full path e.g. "chapter001.xhtml"> }`. The worker/audiobook route use `chapterFile` (full path). So `chapterId` (basename) must be mapped to `file` when triggering per-chapter generation.

## 2. The 5 features

### (a) Per-sentence audio preview (play the assigned voice on the assigned sentence)
- Add a small **play button** rendered inline on each sentence (recommend: show on hover for all, always for assigned).
- On click: `POST /api/tts` with the **exact** body `EbookReader.tsx` uses:
  ```ts
  { text: s.text, bookId, voice: s.voiceId ?? undefined, language: 'vi',
    emotion: undefined, expressiveness: undefined, callIdx: s.i }
  ```
  - If `s.voiceId` is `null`, omit `voice` so the server uses the default narration voice.
- Play the returned `blob` via a shared `HTMLAudioElement` (`audioRef` already exists). Reuse the existing `stopPreview`/`previewing` pattern but key it by **sentence index** (`playingSentence: number | null`) instead of voice id, so the icon toggles correctly per sentence.
- Disable the button while a sentence is playing; clicking again stops.

### (b) Distinct color highlight per assigned voice
- Add a pure helper `voiceColor(voiceId: string): string` (e.g. deterministic HSL from a hash of the id, or a fixed palette indexed by a stable `voiceId → index` map built from `voices`). Keep it in this file (or `lib/utils`).
- Apply as inline `style={{ backgroundColor: color + '22', boxShadow: inset ring color }}` on the sentence `<button>` when `assigned`. Keep the existing `Volume2` marker.
- Add a **legend** (small strip under the header) listing each used voice with its color swatch + label, so users can read the mapping. Build the legend from `voices` filtered to currently-used `voiceId`s.

### (c) Multi-select + batch assign
- Add selection state: `const [selected, setSelected] = useState<Set<number>>(new Set())` and a `selectionMode` boolean.
- Toolbar button **"Chọn nhiều câu"** toggles `selectionMode`. In selection mode:
  - Each sentence shows a checkbox (or click toggles selection instead of opening the picker).
  - A sticky bottom bar appears: `Đã chọn N câu` + **"Gán giọng cho N câu"** + **"Bỏ chọn"**.
- Clicking **"Gán giọng cho N câu"** opens the existing picker (reuse `Dialog`) in **multi mode**: selecting a voice calls a new `assignVoiceMany(indices, value)` that maps over all selected indices and persists once.
- `assignVoiceMany` mirrors `assignVoice` but updates all selected indices in one `setSentences` + single `persist` call.

### (d) Per-chapter audiobook generation that consumes the plan
**Frontend (VoiceAssignPage):**
- Add a bottom section **"Tạo Audio Book"** with:
  - A **"Tạo audio chương này"** button → `POST /api/library/[id]/audiobook` `{ action: 'regenerate_one', chapterFile: currentChapterFile }`.
  - Need `currentChapterFile`: extend `ChapterInfo` to also carry `file` (from the chapters API) and use `c.file` as `chapterFile`.
  - Show status by polling `GET /api/library/[id]/audiobook` and finding the row whose `chapterFile === currentChapterFile` (`ready` / `generating %` / `failed`). Reuse the existing `AudiobookPanel` polling pattern (3s interval while generating).
  - Optional: a **"Tạo toàn bộ sách"** button reusing the existing `action: 'generate'` for parity.

**Backend (worker) — thread the voice plan:**
- In `src/worker/audiobook.ts` `generateOneChapter(bookId, chapterFile, backend, opts)`:
  - After parsing the EPUB, compute `chapterIndex` (same logic as the voice-plan route: `epub.htmlFiles.findIndex(f => path.basename(f, ext) === chapterId || path.basename(f) === chapterId)` — or match by `chapterFile`).
  - Load `prisma.chapterVoicePlan.findUnique({ where: { bookId_chapterIndex: { bookId, chapterIndex } } })`.
  - If present, build `voicePlanJson = JSON.stringify(plan.sentences.map(s => ({ text: s.text, voiceId: s.voiceId })))` and pass it to `runGenerator` as `opts.voicePlanJson`.
  - In `runGenerator`, add `VOICE_PLAN: opts.voicePlanJson ?? ''` to the `env` object (alongside `CHARACTER_MAP`).
- The Python side already applies `VOICE_PLAN` overrides — no Python change required. Verify by reading `audiobook_generator.py::_load_voice_plan` / `generate_chapter`.

### (e) AI suggest voices button
- Add a **"AI đề xuất giọng"** button in the header/toolbar.
- Backend: add `POST /api/library/[id]/chapters/[chapterId]/voice-plan/suggest` that:
  1. Reuses `buildSuggestedVoicePlan()` (attribution) to get `charId`/`source` per sentence.
  2. For each character-attributed sentence, resolve the character's `voiceId` from `listCharacters(bookId)` (map `charId → voiceId`). If the character has no voice yet, fall back to a gender-appropriate built-in via `pickBestBuiltInVoice` (`lib/ai/voice-selector.ts`) using the character's `gender`.
  3. Returns the full plan with `voiceId` populated (deterministic, no LLM needed → fast & reliable).
  - Persist is left to the UI (so the user can review before saving), OR auto-save — recommend: apply client-side then rely on existing debounced `persist`.
- Frontend: button calls the endpoint, then `setSentences(suggested)` + `persist`. Show a toast/inline note "Đã đề xuất N câu". Keep the existing manual picker for overrides.

## 3. Files to touch

| File | Change |
|------|--------|
| `src/components/library/VoiceAssignPage.tsx` | (a) play button + `playingSentence`; (b) `voiceColor` + inline style + legend; (c) `selected` set + selection mode + `assignVoiceMany` + bottom bar; (d) audiobook section + poll; (e) AI suggest button + fetch |
| `src/app/library/[id]/assign-voices/page.tsx` | No change (passes `bookId`/`bookTitle`) |
| `src/worker/audiobook.ts` | Thread `voicePlanJson` → `VOICE_PLAN` env in `generateOneChapter` + `runGenerator` |
| `src/app/api/library/[id]/chapters/[chapterId]/voice-plan/suggest/route.ts` | **New** — AI suggestion endpoint (feature e) |
| `prisma/schema.prisma` | No change (ChapterVoicePlan already exists) |
| `app/tts-service/audiobook_generator.py` | No change (already reads `VOICE_PLAN`) |

## 4. Key implementation notes / gotchas
- **`/api/tts` body must match `EbookReader.tsx`** exactly (omit `speed` — server falls back to per-voice `voiceSpeed`; client `playbackRate` handles speed). Use `callIdx: s.i`.
- **Color contrast**: use `backgroundColor: color + '22'` (≈13% alpha) + a 1px ring in the solid color so text stays readable in light/dark.
- **Selection vs click conflict**: in `selectionMode`, a sentence click toggles selection (does NOT open the picker). The single-assign picker is only used when NOT in selection mode, or via the batch bar's "Gán giọng" button.
- **`chapterFile` mapping**: the chapters API returns `file` (full path). Store it on `ChapterInfo` and pass `c.file` to the audiobook `regenerate_one` action. Do not pass the basename `id`.
- **Polling**: only poll the audiobook status while a generation is in flight for the current chapter (avoid hammering the API when idle).
- **Voice plan text matching** in Python is normalized/lowercased; the plan we send must contain the **original** `s.text` (not stripped) so it matches the generator's segment text. The generator normalizes both sides.

## 5. Verification
1. `npm run build` (or `npx tsc --noEmit`) in `app/ebook-converter` — must pass with no type errors.
2. `npm run dev -p 3100`, open `http://localhost:3100/library/<bookId>/assign-voices`.
3. Manual checks:
   - (a) Click play on an assigned sentence → hear that voice read the sentence; icon toggles to stop.
   - (b) Assign 2-3 different voices → each sentence shows a distinct color; legend lists them.
   - (c) Toggle multi-select, pick 3 sentences, batch-assign one voice → all 3 update + save.
   - (d) Click "Tạo audio chương này" → status shows generating → ready; play the chapter audio; confirm the assigned voices are used (compare with a sentence that has a distinct voice).
   - (e) Click "AI đề xuất giọng" → character sentences get voiceIds; review; save.
4. (Optional) Run the existing e2e/unit tests: `npx vitest run` and the `e2e/0x-*.spec.ts` voice tests if they exist for this page.

## 6. Reference pointers (exact locations)
- `/api/tts` body: `src/components/library/EbookReader.tsx` ~line 3051 (`fetch('/api/tts', { ... body: JSON.stringify({ text, bookId, character, voice, language, emotion, expressiveness, callIdx }) })`).
- Suggested-plan builder: `src/lib/voice-plan.ts` → `buildSuggestedVoicePlan()`.
- Voice suggestion helper: `src/lib/ai/voice-selector.ts` → `pickBestBuiltInVoice()`.
- Worker single-chapter: `src/worker/audiobook.ts` → `generateOneChapter` (line ~265) and `runGenerator` (env built ~line 380).
- Audiobook API: `src/app/api/library/[id]/audiobook/route.ts` (`regenerate_one` branch).
- Python plan consumption: `app/tts-service/audiobook_generator.py` → `_load_voice_plan`, `_resolve_voice_plan_override`, `generate_chapter`.

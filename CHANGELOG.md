# Changelog

This file tracks the major product changes and cleanup steps. It is intentionally short and current-focused.

## Unreleased

- **Converter — send WHOLE chapter to AI + composable AI options + presets:**
  - **Send whole chapter:** removed the 8000-char truncation in `src/lib/ai/chapter-enhancer.ts` (both `enhanceChapter` and `enhanceChaptersParallel`). The AI now receives the **entire** chapter body for enhancement, so cleanup/encoding-fix is complete and accurate. The `max_tokens` output cap (bounded by `aiMaxTokens` and a 2× input-token budget) still prevents OOM on the output side.
  - **Composable AI stages:** `aiEnhance` and `deepFormat` can now BOTH run on the same book. In `src/lib/pipeline/conversion-pipeline-chapters.ts`, the old `!deepFormat && !readerFriendly` guard that cancelled AI Enhancement when Deep Format was on is removed — Deep Format runs first (restructures HTML), then AI Enhancement cleans up residual artifacts. `readerFriendly` is now purely a build-stage CSS swap and no longer cancels any AI stage.
  - **In-flight cap:** AI Enhancement already bounds concurrency via `aiEnhanceConcurrency` (default 3, max 16) in `enhanceChaptersParallel`, so total in-flight requests stay at `workerConcurrency × aiEnhanceConcurrency` — no unbounded fan-out.
  - **UI presets:** new Fast / Balanced / Thorough preset selector in `UploadZone.tsx`. Fast = AI Enhancement only; Balanced = AI Enhancement + Deep Format; Thorough = both + AI Watermark Clean. Flipping any individual toggle switches the selector to "CUSTOM". A hint banner appears when both AI stages are on, explaining the sequential run + whole-chapter send.

- **Phân tích nhân vật theo chương — fixed "analyzed chapters not marked + re-run every time" bug:**
  - **Root cause:** in `src/lib/ai/character-bible.ts`, `refreshBible()` caught LLM failures (e.g. `chatJSON parse failed: Unexpected end of JSON input`) and returned early **without writing a `BibleRefreshLog` entry**. So a chapter whose LLM call failed was left with NO log row → the status endpoint reported it as "not analyzed" → every subsequent run (including "Tiếp tục phân tích") re-attempted it and failed again the same way. This is why many chapters (e.g. chương 5, 10–13 in the user's book) appeared unmarked while only the few that succeeded (e.g. chương 14) got marked.
  - **Fix:** `refreshBible()` now ALWAYS writes a `BibleRefreshLog` row — on LLM failure it records `status: 'failed'` plus the error in the existing `lastError` column (already in schema/migrations). Successful runs still record `status: 'applied'`. The `analyze-range` skip logic uses `NOT: { status: 'failed' }`, so failed chapters are correctly retried on the next run while successful ones are skipped. The UI (`BibleAnalysisControls.tsx`) already renders `failed` chapters with a distinct amber `AlertTriangle` + "lỗi" tooltip. Verified: a forced re-run of a failing chapter now leaves a `failed` log (visible in status + flag strip) instead of being silently left unmarked.

- **Phân tích nhân vật — configurable chapter-text cap (new Settings field `bibleChapterChars`):**
  - **Why:** long chapters sent the full text to the LLM, which intermittently tripped the `504 Gateway Time-out` on the MiniMax-M3 gateway (e.g. chương 5 / raw index 4). A smaller prompt is faster and avoids the timeout.
  - **Resilience:** added retry-on-5xx/408/429/empty in `rawChat` (`maxRetries` default 2, exponential backoff up to 8s) and set `maxRetries: 3` on the bible `chatJSON` call. `refreshBible` now reads `bibleChapterChars` from settings (default 12000, was hard-coded 30000) and truncates the chapter text to that many characters before sending.
  - **GUI:** new `Giới hạn ký tự chương (Phân tích nhân vật)` field on `Settings` page — number input (min 2000 / max 40000 / step 1000) with preset chips 6K / 12K / 20K / 30K and a tooltip explaining lower = faster / avoids 504, higher = more context. Wired end-to-end: `Settings`/`UserSettings` Prisma models + migration `20260901000004_add_bible_chapter_chars` + both DBs altered + `src/lib/db/settings.ts` + `GET/PUT /api/settings` (clamps to 2000–40000) + `src/app/settings/page.tsx` + consumed in `refreshBible`. Verified: settings GET returns the value, PUT saves + clamps, and a re-run of the previously-failing chương 5 now succeeds (`status: applied`).

- **Đề xuất chờ duyệt — show "hiện tại vs đề xuất" + AI gợi ý quyết định:**
  - **Why:** the old pending-diff UI only listed the proposed fields and flagged conflicts with a generic "Xung đột với chỉnh sửa của bạn". The user couldn't see what would change vs what they already had, and had no help deciding accept/reject/merge.
  - **Backend:** new `POST /api/library/[id]/characters/bible/diffs/suggest` — sends one or many pending diffs (with their current profile values) to the AI in a single call; returns per-diff `{ decision: accept|reject|merge, reason, merged? }`. Read-only (never mutates the bible). The single-diff `apply` route now accepts an optional `merged` body so a "merge" decision actually combines current + proposed values.
  - **UI (`CharactersPanel.tsx`):** each pending diff now shows a **Hiện tại | Đề xuất** two-column comparison (for update diffs), the evidence quote, and an AI suggestion banner (Nên chấp nhận / Nên bỏ qua / Nên gộp) with the AI's reason. Per-diff buttons: **Gợi ý AI**, **Áp dụng** (or **Áp dụng (gộp)** when merged), **Chỉ đề xuất**, **Bỏ qua**. A **Gợi ý AI (tất cả)** button batch-reviews every pending diff in one LLM call. Verified: suggest endpoint returns sensible accept/reject/merge decisions with merged text.

- **Nhân vật — auto-promote protagonists to `main` (fixed Cơ Lạc Dao mis-classified as `supporting`):**
  - **Root cause:** the LLM bible analysis never emits a `role` field for existing characters, so a character first seen as `supporting` (the default) was never upgraded even when it dominated the book. The appearance ledger is also sparse (the LLM rarely emits `kind:'appearance'` patches), so chapter counts alone were unreliable.
  - **Fix:** new `recomputeCharacterRoles(bookId)` in `src/lib/db/character-bible.ts` promotes `supporting` → `main` for characters that are hubs of the relationship graph (>= 3 edges in/out). Called at the end of every `refreshBible()` run, idempotent, never demotes a `main` the user set. Verified: Cơ Lạc Dao (3 relationships, the social-graph hub) is now correctly `main`; no other character qualifies.

- **Nhân vật tab — per-character voice settings (fixed shared-voice bleed):**
  - **Bug fix:** two characters that shared the same `Voice` row (e.g. `Đại Chủ Giáo Hắc Vu Giáo` and `Giang Hạo` both using voice "Đức Trí") had their speed/emotion stored on the shared `Voice.defaultSpeed`/`defaultEmotion`. Editing one card's speed silently changed the other card's speed.
  - **Fix:** moved speed/emotion storage to per-`Character` columns (`Character.defaultSpeed Float?`, `Character.defaultEmotion String?`, added via migration `20260901000003_add_character_voice_settings` + applied to both `data/ebook-converter.db` and `prisma/data/ebook-converter.db`). New `PATCH /api/library/[id]/characters/[characterId]` endpoint persists these per character; `CharactersPanel` now loads/writes settings keyed by **character id** (not voice id). The worker (`audiobook.ts`) and Python generator (`audiobook_generator.py`) now prefer per-character `defaultSpeed`/`defaultEmotion` over the voice-level values. Verified: PATCH one character's speed/emotion leaves the other character untouched (HTTP 200, isolated).

- **Fixed 500 on Audio Studio / Nhân vật tab (client/server import leak):**
  - Root cause: `BibleAnalysisControls.tsx` (a `'use client'` component) imported `getSettings` from `@/lib/db/settings`, which transitively pulls in `node-fetch` → `node:buffer`. Webpack can't bundle `node:` URIs into the browser bundle, so the whole `/library/[id]/audio` route failed with `UnhandledSchemeError: Reading from "node:buffer" is not handled by plugins` (HTTP 500).
  - Fix: removed the server-only import and instead fetch the live `bibleConcurrency` setting over `GET /api/settings` inside the client component. `getSettings` (Prisma) stays server-side only.

- **Nhân vật tab — uniform card silhouette:**
  - Each character card now always renders the **same set of attribute slots** (giới tính, độ tuổi, giọng, bí danh, mô tả) regardless of how much data exists. Missing values show a faint `—` placeholder instead of collapsing the row, so every card has an identical height/silhouette and the grid reads harmoniously. The tone badge keeps its character-tinted color when present, and falls back to a neutral gray `—` when absent.

- **Nhân vật tab — fixed edit dialog (couldn't change anything) + nicer cards:**
  - **Bug fix:** the edit dialog's role/gender/age fields used Radix `Select` components. Inside the custom (non-Radix) `Dialog`, the Radix `Select` portal left a transparent full-viewport overlay that intercepted every pointer event — so after opening edit, nothing was clickable (`<html> intercepts pointer events`). Replaced the three `Select`s in the edit dialog with native `<select>` elements (the old `CharacterDetection` card used these successfully), which removes the portal/stacking conflict. The dialog is now fully interactive (verified in-browser: role/age/gender/aliases/description all editable, save works).
  - **Card visual polish:** added a role-colored left accent border (main=amber, supporting=sky, minor/crowd=slate), larger rounded-2xl avatar, a header chip showing the avatar + name + "Tên không thể đổi" hint, tone badge tinted with the character's avatar color, and hover-to-primary icon buttons (edit/play) for a cleaner, more premium feel.

- **Nhân vật tab — pending-diff UX + card style parity with old detection card:**
  - **Pending diffs now show character names, not UUIDs.** The `Đề xuất chờ duyệt` section resolves `patch.characterId` → the character's display name via a `charNameById` map built from the loaded characters. Conflict diffs (`autoReason='conflict-with-user-edit'`) are visually flagged (red border) and their per-row **Áp dụng** is disabled with a tooltip, since they need manual review; the raw `autoReason` string is no longer dumped into the UI.
  - **Added "Áp dụng tất cả" button** in the pending-diffs header that calls the existing `POST /api/library/[id]/characters/bible/diffs/apply-all` endpoint (bulk-applies every non-conflicting diff, leaves conflicts pending) and refreshes the grid.
  - **Nhân vật cards now match the old `CharacterDetection` card style:** each assigned character card gained a per-voice **Tùy chỉnh giọng** block with a speed slider (0.5×–2.0×) and an emotion select (Bình thường / Điềm tĩnh / Buồn / Căng thẳng / Lãng mạn / Giận dữ / Hào hứng), persisted via `PATCH /api/library/[id]/voices/[voiceId]` (`defaultSpeed` / `defaultEmotion`). Settings are loaded from `/api/library/[id]/voices` on every refresh.

- **Nhân vật tab — richer character cards + edit dialog + pending-diff review:**
  - Each character card now shows more info: gender, age, **tone** (Giọng) badges, aliases, and a 2-line description/notes preview, alongside the existing role badge and voice picker.
  - Added a **pencil edit button** on every card opening a dialog to edit role, gender, age, aliases (comma-separated), and description/notes. Saves via the existing `POST /api/library/[id]/characters` upsert (aliases/role/gender/age) + `PATCH .../profile` (description, `source='user'`). Name is read-only (the upsert keys on name; rename would need a new endpoint).
  - Added a **"Đề xuất chờ duyệt (N)"** section that surfaces the bible `pendingDiffs` (new characters, relationship suggestions, profile updates) with per-diff **Áp dụng / Bỏ qua** actions wired to the existing `.../bible/diffs/[id]/apply` and `/reject` endpoints — so AI suggestions are visible and actionable after analysis instead of disappearing.

- **Nhân vật tab redesign — removed duplicate analysis button & fixed stale results:**
  - Removed the duplicate "AI phân tích nhân vật" button that lived in `CharactersPanel` (it called the old single-shot `/characters/detect` path, which overlapped with the range-based `BibleAnalysisControls` "Phân tích" / "Tiếp tục phân tích" buttons). The tab now has a single, clear analysis entry point at the top.
  - Fixed the bug where running a chapter-based analysis left the character grid + relationship graph empty/stale: `AudioStudio` now bumps a `refreshSignal` prop on `CharactersPanel` (and refreshes the header counts) when `BibleAnalysisControls` finishes, so the panel re-fetches characters + graph. `BibleAnalysisControls` now also fires `onAnalysisComplete` in its `finally` block, so partial results show even on error/abort.
  - Moved the **relationship graph to the very bottom** of the Nhân vật tab (after the character grid) per request, and removed the now-orphaned AI-detection review UI (`DetectedCharacterCard`, `PropertyRow`, `DetectionResult`, related state) from `CharactersPanel` for a simpler, single-flow layout.

- **Audio Studio — incremental character-bible analysis, relationship graph & Phân giọng uncertainty review:**
  - **Backend (new endpoints, build on existing `BibleRefreshLog`/`refreshBible`):**
    - `GET /api/library/[id]/characters/bible/status` — per-chapter analyzed flags (from `BibleRefreshLog`) + total/analyzed/failed counts + chapter titles. Powers the "already analyzed" UI without a schema change.
    - `POST /api/library/[id]/characters/bible/analyze-range` (SSE) — sequential range orchestrator that loops `refreshBible()` over a chapter range, **skips already-analyzed chapters by default** (idempotency via `BibleRefreshLog`), and streams `range-start` / `chapter-skip` / `chapter-start` / `chapter-progress` / `chapter-done` / `chapter-error` / `range-done` events. Concurrency is 1 (a single chapter already pushes the local model near its context window; parallel fan-in merges corrupt the bible).
    - Client helpers in `lib/character-bible-client.ts`: `openRangeAnalysisStream`, `consumeSseStream`, `fetchBibleStatus`, `BibleRangeEvent` type.
  - **Nhân vật tab (`CharactersPanel` + new `BibleAnalysisControls`):**
    - Range picker (from/to chapter), **"Phân tích"** (run selected range) and **"Tiếp tục phân tích"** (only not-yet-analyzed chapters) buttons, a per-chapter flag strip (✓ analyzed / ⚠ failed / ○ not yet), live SSE progress log, and a **"Phân tích lại"** toggle to force re-run analyzed chapters.
    - `AudioStudio` `characters` tab now renders `BibleAnalysisControls` + `CharactersPanel` (previously it rendered `VoicePanel section="characters"`).
    - **Relationship graph** (`RelationshipGraph.tsx`): self-contained SVG force-directed graph (no new dependency) of `Character` + `CharacterRelationship` — role-tinted nodes (main/supporting/minor/crowd), labelled edges, hover ego-network highlight, click-to-select. Rendered in the Nhân vật tab above the character grid.
  - **Phân giọng uncertainty review (`VoiceAssignPage` + `voice-plan.ts`):**
    - `VoicePlanSentence` gained optional `confidence` + `uncertain` fields, populated from the paragraph attribution confidence (`<0.6` → uncertain) and preserved through serialize/deserialize.
    - Uncertain sentences are highlighted with an amber left-border + "?" chip; a **"Câu cần review (N)"** toolbar toggle filters the editor to just those sentences so the user can resolve them quickly.
  - **Note:** the AI gateway (`gw.greenhome.net`) was intermittently unreachable during development, so end-to-end LLM analysis couldn't be fully exercised; the SSE pipeline, status API, and UI all typecheck and the range endpoint streams correctly (empty LLM output was a gateway outage, not a code bug).
  - **Audiobook coverage warning (`AudiobookPanel` + `lib/db/audiobook.ts`):** `getAudiobookSummary` now returns a `coverage` block (planned chapters, assigned/uncertain sentences) computed from stored `ChapterVoicePlan` JSON. The Audiobook tab shows amber warnings before generation: (1) no Phân giọng plans yet → everything uses the narrator voice; (2) N uncertain sentences still need review in the Phân giọng tab.

- **Fixed character alias / bí danh detection for cổ trang novels:**
  - Root cause: the Python `character_detector.py` prompt explicitly told the model to add generic throne honorifics (`Bệ Hạ`, `trẫm`, `hoàng thượng`…) as aliases of whoever it detected — so the main character `Giang Hạo` got wrong aliases `Bệ Hạ` / `Hạ Hoàng` and missed his real title `Vệ Quốc Công`. The `character-bible.ts` prompt had the same gap.
  - Fix: both prompts now instruct the model to capture the character's **title / tước vị / bí danh / hiệu / tự** as aliases (e.g. `Vệ Quốc Công` for `Giang Hạo`), but **explicitly NOT** to capture generic throne honorifics that refer to whoever holds power (`Bệ Hạ`, `trẫm`, `hoàng thượng`, `thiên tử`, `nữ hoàng`, `đại vương`, `thần`, `thiếp`) unless the narration clearly calls THAT character by that word.
  - Also bumped the detector's OMLX timeout 180s → 300s (the MiniMax-M3 gateway is slow for 10-chapter detection).
  - Manually corrected the already-stored `Giang Hạo` row: removed the wrong `Bệ Hạ` / `Hạ Hoàng` aliases and added the correct `Vệ Quốc Công` title.

- **Fixed "Chương 1 only shows 1 character" on Phân giọng page (cached broken plan):**
  - Root cause: the per-chapter voice plan was cached in `ChapterVoicePlan.sentences` with only **2 sentences** (the chapter title + a stray `"x"`) for `Bắt Đầu Bị Nữ Đế Đánh Vào Ngục` → Chương 1. The HTML for that chapter actually has 118 paragraphs / ~120 sentences, so the splitter was working correctly when the bad cache was generated — the stale cache just got pinned by `mtime` matching. The Phân giọng page rendered the 2 short sentences, and the user had no way to recover from inside the UI (no "regenerate" button, the `?raw=1` debug query was the only escape).
  - Fix:
    - **Cleared the bad cache row** (`DELETE FROM ChapterVoicePlan WHERE chapterIndex=4`) — the route now returns the correct 121-sentence plan and the Phân giọng page renders the full chapter.
    - **New `?fresh=1` query param** on `GET /api/library/[id]/chapters/[chapterId]/voice-plan` that skips the cache, regenerates from the chapter HTML, and overwrites the stored plan. Lets future recovery be one click.
    - **New "Làm mới" button** in the Phân giọng toolbar (next to "AI đề xuất giọng") that snapshots the current plan to history first (so it's reversible), then calls `?fresh=1`. The button shows a confirmation dialog before destroying the plan.

- **Made `Max tokens` a real user knob and surfaced where it actually applies:**
  - **Settings UI** (`/settings` → AI tab): the `Max tokens` field now has a tooltip listing every code path that respects the value (chapter enhancer, EPUB analyzer, character bible, attribution, Python character detector, Python audiobook segmenter, TTS emotion classifier) plus the hardcoded tiny outputs that intentionally don't (cover titles, watermark detection, test-AI ping). It also has 4 one-click preset chips — **4096 Tiết kiệm / 8192 Cân bằng / 16384 Rộng rãi / 24576 Reasoning** — so users don't have to guess values for their model. A ⚠ warning reminds users that reasoning models (Qwen3, DeepSeek-R1, MiniMax-M3) need at least ~4096 tokens because part of the budget goes to internal thinking.
  - **Code paths now honoring `Settings.aiMaxTokens`** (via `chat()` helper fallthrough or explicit env forwarding):
    - `src/lib/ai/epub-analyzer.ts` → `detectChapters` (was hardcoded 8192)
    - `src/lib/ai/character-bible.ts` (was hardcoded 8192)
    - `src/app/api/tts/analyze/route.ts` (was hardcoded 2000)
    - `app/tts-service/audiobook_generator.py` → LLM segmenter (was hardcoded `min(8192, 1500+len*0.6)`); new `_segmenter_max_tokens(text_len)` helper reads `OMLX_MAX_TOKENS` env first, then falls back to the length-based heuristic
    - `src/worker/audiobook.ts` → `OMLX_MAX_TOKENS` is now forwarded to the Python `audiobook_generator.py` subprocess (new `resolveAiMaxTokens` helper reads DB `aiMaxTokens`, clamped 256..16384)
  - **Audit results** — hardcoded values that stay hardcoded, with rationale: `test-ai/route.ts:20` (32 — test ping), `attribution/analyze/route.ts:90` (4 — single-word), `watermarks/route.ts:129` (256 — binary classification), `ai-generate-cover.ts:200` (600 — title), `image-generator.ts:464` (800 — image prompt), `attribution.ts:557` (1024 — per-batch), `audiobook_generator.py:506` (`200+len*6` — per-line emotion), `chapter-formatter.ts:293` (derived `0.8×input len` — proportional to chunk size). All of these are intentionally small/derived outputs that don't benefit from user control.

- **Fixed "regex fallback" character detection on reasoning-model providers:**
  - Root cause: `app/tts-service/character_detector.py` hardcoded `"max_tokens": 1500`. For a 5-chapter Vietnamese novel (~10 KB sample text) the LLM JSON output needs ~3000+ tokens, so the response was truncated to an empty body. The Python script then fell back to regex (which scrapes generic capitalized strings like "Vạn", "Đại", "Phượng" with no gender/tone/role metadata) and emitted the `⚠ regex fallback` warning. Reasoning models like `MiniMax-M3` made this worse because they spend budget on internal `reasoning_content` before producing any answer.
  - Fix: the detector now reads `OMLX_MAX_TOKENS` from env (forwarded from DB `Settings.aiMaxTokens` by `detectorEnvOverrides`) and defaults to **8192** (clamped 256..16384). When the model name hints at reasoning (`minimax*`, `*r1*`, `reasoning*`, `deepseek-r*`, `qwq*`) the cap is bumped to at least 8192 so the JSON answer isn't truncated mid-output. End-to-end test on `Bắt Đầu Bị Nữ Đế Đánh Vào Ngục` now returns 4 rich characters (`Giang Hạo`, `Hạng Vũ`, `Viên Thiên Cương`, `Phượng tộc tộc trưởng`) with aliases, gender, age, tone, role, sample_lines, and a Vietnamese summary — instead of 20 generic regex scraps. The regex-fallback path is preserved for when the gateway is genuinely unreachable.

- **Dashboard (`/`) now surfaces pipeline + engagement signals at a glance:**
  - **Worker status pill** on the welcome bar — green ("Worker online"), amber ("Worker offline" with the official `start-worker.sh` hint in the title attribute), or red ("Worker + Redis offline"). Surfaces a dead worker immediately instead of waiting for the next failed conversion.
  - **Active-job pill** that only appears when something is cooking (`processing + queued + pending > 0`) with a spinner and count, linking to `/convert` where `JobList` shows live progress + cancel/download.
  - **"Hôm nay" stat** in the inline stats strip — counts how many books the user opened today (via `Book.lastRead`). Green when > 0, encouraging the streak.
  - **New "Vừa đọc" section** between "Đang đọc dở" and "Thêm gần đây" — a compact list (up to 5) of books the user opened recently, with cover thumb + author + "X phút/giờ trước" + progress %. Falls back to in-progress books when the user has nothing with a `lastRead`, so the section never looks empty if reading IS happening.
  - **Footer "Cập nhật X trước" + "Làm mới" button** — surfaces data freshness and lets the user force-refresh without leaving the Dashboard. A 30 s tick keeps the "X trước" label current while the user lingers.
  - All three dashboard fetches (`/api/library`, `/api/settings`, `/api/worker/status`) now run in parallel via `Promise.all` and each is independently best-effort — a failed settings or worker fetch no longer blanks the whole page.
  - Added `lastRead?: string | null` to the shared `BookSummary` interface so all library cards can surface it consistently.

- **Database is now the single source of truth for AI settings (fixes "AI 401" detection bug):**
  - `mergeEffectiveSettings` / `mergeSettingsWithOverrides` now treat the DB (`Settings` singleton + `UserSettings`) as authoritative. The browser `ai-settings-session` cookie is only a **gap-fill** fallback — it can no longer shadow a DB value (e.g. a stale `provider=omlx-local` cookie can't override a DB `provider=custom` with a real key). Empty-string AI keys in the DB are treated as "explicitly cleared" and win over a leftover cookie value.
  - Character-detection routes (`/api/library/[id]/characters/detect` and `/api/library/[id]/chapters/[chapterId]/detect-characters`) now read the session cookie and thread it through `getEffectiveSettings` / `detectorEnvOverrides` as a fallback, so a Custom AI key saved to the cookie still reaches the Python detector. The DB remains the primary source.
  - `detectorEnvOverrides` accepts an optional `sessionOverride` so the cookie's provider/baseUrl/key/insecureTls are forwarded to `character_detector.py` when the DB has no value.
  - Corrected the persisted Custom AI config in the DB: `aiModel` was `minimax` (a gateway-virtual model that ignores the extraction prompt); changed to `MiniMax-M3` (the gateway's working default model) so detection reaches the LLM reliably.

- **Added a dedicated Audio Studio page (`/library/[id]/audio`) and slimmed the reader's Audio panel:**
  - The reader's right-side Audio panel now hosts only **Read aloud** (synced to the chapter iframe). All audio *production & management* moved to the new full-page Audio Studio: Audiobook generation, Voice library (Giọng), Character detection (Nhân vật), and per-sentence voice assignment (Phân giọng).
  - Audio Studio shows a live **status strip** (audiobook progress, voice count, character-assigned count) and **tab badges** so state is visible across tabs. A **"Tạo audiobook" CTA** on the Phân giọng / Nhân vật tabs generates the audiobook from the current voice setup and jumps to the Audiobook tab.
  - The legacy `/library/[id]/assign-voices` route now **redirects** to `/audio?tab=assign` (old links/bookmarks keep working). The rich `VoiceAssignPage` (multi-select, AI suggest, per-sentence play, per-chapter generation) is the Phân giọng tab — the simpler `VoiceAssignEditor` was removed as dead code.
  - Reader header "Phân giọng ↗" link → "Audio Studio ↗"; the icon-only Phân giọng button and mobile menu item now deep-link to `/audio?tab=assign`.

- **Deployment model changed to build-once / publish-pull (Mac builds, VM pulls):**
  - The VM no longer runs `docker compose build` from source. The Mac builds the
    `app` + `worker` images once and pushes them to a local Docker registry
    (`localhost:5005`); the VM `docker pull`s the exact same artifact via
    `docker-compose.pull.yml` + `scripts/deploy-vm.sh code`.
  - Added `scripts/publish-image.sh` (build + tag `:latest` + `:git-<sha>` + push)
    and `scripts/deploy-vm.sh` (VM-side pull + restart; git-tolerant because the
    VM is a snapshot, not a git repo).
  - `docker-compose.yml` (base) now has **no** `build:`/`image:` on `app`/`worker`
    so it is compose-version-agnostic; `docker-compose.build.yml` (Mac) adds
    `build: .` + `image:` + `platform: linux/amd64` and drops the `../tts-service`
    mount; `docker-compose.pull.yml` (VM) supplies `image:` + `pull_policy: always`
    + re-adds the `../tts-service` mount. **No `build:` key in the pull override**
    (older Compose rejects `build: null`/`build: false`).
  - Removed the broken in-stack `tts-vieneu` container; VieNeu TTS runs on the
    host (Mac) at `:5020` and is reached via `host.docker.internal:5020`.
  - **Fixed `exec format error` on the VM:** the Mac is arm64 but the VM is
    amd64, so an unpinned build produced an arm64 image that crashed the VM.
    `docker-compose.build.yml` now pins `platform: linux/amd64` (QEMU-emulated
    build on the Mac) so the published image is always VM-runnable. See
    `docs/dev-workflow.md` "Gotchas #7".
- **Added a Voice Assign Editor (Phân giọng) for per-sentence voice assignment:**
  - New `ChapterVoicePlan` Prisma model stores a per-chapter, per-sentence voice
    plan (discovered character + chosen voice) so assignments persist and survive
    navigation.
  - **AI đề xuất giọng is now propose-only (no auto-save):** the suggestion builds a
    preview proposal shown in a banner ("AI đề xuất N câu có giọng… Áp dụng / Hủy").
    The user reviews, edits individual sentences if needed, then presses **Áp dụng**
    to commit. This prevents accidental overwrites of manual assignments.
  - **Rolling history (max 30, auto-rotate):** a new `VoicePlanHistory` Prisma model
    snapshots the current plan **before** every apply / restore / manual save, so any
    change is always reversible. A **Lịch sử** dialog lists snapshots (label +
    timestamp + sentence count) with one-click **Khôi phục**; restoring also snapshots
    the current plan first, so restore is itself undoable. When the 30-entry cap is
    exceeded the oldest snapshot is dropped (ring buffer). A **Lưu phiên bản** button
    lets the user checkpoint the current state before risky manual edits.
  - New `GET/PUT /api/library/[id]/chapters/[chapterId]/voice-plan` route derives
    sentence suggestions from the existing attribution engine (default = narration
    voice for every sentence; dialogue quotes attributed to a known character are
    suggested as that character) and auto-saves edits.
  - New "Phân giọng" tab in the reader's Audio panel lists every sentence with its
    suggested character and a voice picker; changes auto-save (debounced PUT) and
    show a "Đã lưu" indicator. Sentences left on the narration voice need no
    assignment — read-aloud and the audiobook generator fall back to narration
    automatically.
  - Read-aloud now consults the saved plan (single-sentence paragraphs) so manual
    voice overrides take effect during playback; unassigned sentences use the
    narration (default) voice.
  - The Python audiobook generator honours an optional `VOICE_PLAN` env var
    (sentence text → voiceId) so the same per-sentence assignments drive
    generation; a null voiceId forces the narration voice. No-op when unset.
- Consolidated repo documentation to one active source of truth.
- Archived historical plans, debug notes, and expired research into docs/archive.
- Kept the product docs aligned to the current app and TTS architecture.
- **AI cover generation is now fully working and user-triggerable:**
  - Fixed the image model name (`minimax` → `nexus-image`) so the custom OpenAI-compatible gateway actually generates images.
  - `cover/generate` now accepts `force: true` to skip EPUB cover extraction and always produce a fresh AI cover (previously it only generated when extraction failed, so books with embedded covers never got an AI cover).
  - Added a visible "Generate cover" button + "Generating…" badge so users know when a cover is being generated in the background (grid, list, and Dashboard).
  - Added a `hasCover` flag (checks the cover file on disk) so missing covers surface a clear action instead of a silent placeholder.
  - Fixed cover cache-busting: the URL now uses the book's `updatedAt` instead of a local counter that reset on remount, so generated covers persist across navigation and on the Dashboard.
  - Library covers use `object-fill` to fill the card area.
- **Removed the 2-side (spread / two-column) reader mode:**
  - The spread pagination was unreliable (content clipping, wrong column counts), so
    the mode was pulled entirely. The reader is now single-column scroll only.
  - Deleted `buildSpreadCss`, `SPREAD_SCRIPT`, the `#epub-clip`/`.epub-spread` CSS,
    the `Layout` type, the `layout` setting, the layout toggle (header + settings
    panel + dropdown), the spread page-indicator/progress bar, and all spread
    postMessage pagination (`next-page`/`prev-page`/`go-last-page`/`page-info`).
  - The chapter route now always renders scroll-mode HTML.

## Recent milestones

- Refactored the conversion pipeline into domain-specific stages.
- Split large reader logic into module-level helper files.
- Added robust watermark detection and stripping with wrapper-aware cleanup.
- Improved EPUB image preservation, including interior images and data-URI conversion.
- Added deterministic E2E fixtures and stricter validation around build/test flows.

## Notes

For implementation details, startup instructions, and API structure, use [app/ebook-converter/README.md](app/ebook-converter/README.md) and [docs/README.md](docs/README.md).

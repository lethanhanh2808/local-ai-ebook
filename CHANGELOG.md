# Changelog

This file tracks the major product changes and cleanup steps. It is intentionally short and current-focused.

## Unreleased

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

# Changelog

This file tracks the major product changes and cleanup steps. It is intentionally short and current-focused.

## Unreleased

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

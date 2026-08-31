# Changelog

This file tracks the major product changes and cleanup steps. It is intentionally short and current-focused.

## Unreleased

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

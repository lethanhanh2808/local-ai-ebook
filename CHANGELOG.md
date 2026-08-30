# Changelog

This file tracks the major product changes and cleanup steps. It is intentionally short and current-focused.

## Unreleased

- Consolidated repo documentation to one active source of truth.
- Archived historical plans, debug notes, and expired research into docs/archive.
- Kept the product docs aligned to the current app and TTS architecture.

## Recent milestones

- Refactored the conversion pipeline into domain-specific stages.
- Split large reader logic into module-level helper files.
- Added robust watermark detection and stripping with wrapper-aware cleanup.
- Improved EPUB image preservation, including interior images and data-URI conversion.
- Added deterministic E2E fixtures and stricter validation around build/test flows.

## Notes

For implementation details, startup instructions, and API structure, use [app/ebook-converter/README.md](app/ebook-converter/README.md) and [docs/README.md](docs/README.md).

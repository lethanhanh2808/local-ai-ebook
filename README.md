# Local AI Ebook Platform

A local-first ebook conversion and audiobook system built around a Next.js app, a Python TTS pipeline, and a SQLite-backed library workflow.

## Repository layout

- app/ebook-converter — main web app and conversion pipeline
- app/tts-service — Python TTS and voice attribution services
- docs — repo-level documentation and archive boundaries
- scripts — startup and verification helpers
- reference — standards and reference material

## What is in the app

- EPUB, HTML, and TXT conversion with repair and normalization
- Library management, catalog pages, and reader UI
- Per-book chapter extraction and metadata tooling
- AI-assisted enhancement, watermark cleanup, and illustrations
- Audiobook generation using local TTS and chapter-level voice mapping

## Quick start

From the repo root:

```bash
./scripts/start_full_app.sh
```

For background mode:

```bash
./scripts/start_full_app.sh --background
```

Check status:

```bash
./scripts/start_full_app.sh --status
```

## Main docs

- [docs/README.md](docs/README.md) — central repo guide and archive map
- [app/ebook-converter/README.md](app/ebook-converter/README.md) — app setup and feature overview
- [CHANGELOG.md](CHANGELOG.md) — recent release notes

## Important notes

- The active development area is the ebook app and TTS service.
- Historical research and expired plans live in the archive under [docs/archive](docs/archive).
- Local runtime state and generated data are not treated as repo source.

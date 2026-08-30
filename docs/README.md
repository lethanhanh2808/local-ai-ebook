# Project documentation

This is the single source of truth for repo-level context. Keep this file current and use it to orient contributors before diving into the app code or archive folders.

## Scope

This repository contains the local ebook conversion platform and its audiobook / TTS pipeline:

- app/ebook-converter — the Next.js app and database-backed library/reader workflow
- app/tts-service — the Python TTS + voice attribution pipeline
- scripts — local startup and verification helpers
- reference — downstream standards and reference material
- docs/archive — historical notes, research dumps, and expired plans

## Active product map

### 1) Core app

- [../app/ebook-converter/README.md](../app/ebook-converter/README.md) — product README for setup, feature flow, API routes, and app structure
- [../app/ebook-converter/package.json](../app/ebook-converter/package.json) — commands, verification gates, and runtime scripts
- [../CHANGELOG.md](../CHANGELOG.md) — release history and important changes

### 2) Repo operations

- [../README.md](../README.md) — repository-level overview and entry point
- [../scripts/start_full_app.sh](../scripts/start_full_app.sh) — start the full local stack
- [../scripts/verify_changes.sh](../scripts/verify_changes.sh) — project-wide verification path

### 3) Archive

The archive contains historical engineering notes and expired plans that are retained only for traceability:

- [archive](./archive) — older docs, incident notes, and obsolete plans
- [archive/legacy](./archive/legacy) — long-tail historical research and prompt notes
- [archive/expired](./archive/expired) — retired plans and reports that are no longer used by the active codebase

## Current architecture summary

### Product flow

1. A user uploads EPUB/HTML/TXT content to the app.
2. The conversion pipeline validates, repairs, and normalizes the source.
3. Chapters are built and optional AI enrichment / watermark cleanup is applied.
4. The output is packaged as EPUB3 and stored in the library.
5. The reader can stream chapter content, analyze characters, generate audiobooks, and serve voice data.

### Major subsystems

- Conversion and library: app/ebook-converter/src/lib/pipeline and app/ebook-converter/src/app
- AI orchestration: app/ebook-converter/src/lib/ai
- Background jobs: app/ebook-converter/src/worker
- Database access: app/ebook-converter/src/lib/db and Prisma schema
- TTS stack: app/tts-service

## Documentation rules

- Keep the root repo view focused on current product material.
- Move historical, debug-first, or expired notes into docs/archive instead of leaving them at the top level.
- Prefer app-level docs for feature details and this file for repo navigation.
- Update this file when the product structure changes.

## Recommended starting points

If you are new here:

1. Read [../README.md](../README.md)
2. Read [../app/ebook-converter/README.md](../app/ebook-converter/README.md)
3. Use this page for repo orientation and archive boundaries
4. Only browse docs/archive when you need historical context

## Status

The repo is intentionally narrow and code-driven: the active development surface is the ebook app, the TTS service, and the minimal supporting scripts. Historical notes are archived instead of kept in active navigation.

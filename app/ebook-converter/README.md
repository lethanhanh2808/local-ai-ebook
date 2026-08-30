# Ebook Converter

The main Next.js application for local ebook conversion, library management, reading, and audiobook generation.

## Stack

- Next.js 15 + App Router + TypeScript
- Prisma + SQLite
- BullMQ + Redis
- Local AI through oMLX
- VieNeu TTS as the active TTS backend

## Features

- EPUB, HTML, and TXT conversion
- Repair and normalization for messy source files
- Chapter extraction and EPUB packaging
- Reader with library, shelves, metadata, and editor workflows
- Character and voice management for audiobook generation
- AI enhancement, watermark cleanup, and image handling

## Quick start

From the repo root:

```bash
./scripts/start_full_app.sh
```

Or run directly in the app:

```bash
cd app/ebook-converter
npm install
cp .env.example .env.local
npm run dev
```

## Useful commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e:local:smoke
```

## App structure

```text
app/ebook-converter/
├── src/app              # routes and UI pages
├── src/components       # UI components and panels
├── src/lib              # pipeline, AI, DB, queue, TTS helpers
├── src/worker           # background job workers
├── prisma               # schema and migrations
├── public/assets/fonts  # embedded ebook fonts
├── scripts              # setup and verification helpers
├── e2e                  # Playwright tests and fixtures
├── samples              # deterministic fixture EPUBs
└── README.md            # this file
```

## Key workflows

- Upload and convert books
- Review the library and book metadata
- Read and edit chapters in the built-in reader/editor
- Detect characters and assign voices
- Generate audiobooks from chapter text and voice settings

## Related docs

- [AI_AUDIOBOOK_README.md](./AI_AUDIOBOOK_README.md) — audiobook pipeline summary
- [e2e/README.md](./e2e/README.md) — E2E suite overview
- [../../docs/README.md](../../docs/README.md) — repo-level structure and archive rules

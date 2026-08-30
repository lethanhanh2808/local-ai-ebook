# Ebook Converter & TTS Suite

AI-powered EPUB repair, conversion, and library platform with Vietnamese audiobook generation. This repository holds only the ebook-focused code; supporting tooling (oMLX model serving, OpenCode CLI, Homebrew install) lives in a separate workspace.

## What's here

```
.
|-- app/
|   |-- ebook-converter/         # Next.js 15 app — the main product
|   `-- tts-service/             # Python FastAPI — VieNeu-TTS wrapper + audiobook pipeline
|-- docs/                         # Engineering plans, audit reports, DB ops
|-- reference/                    # Vendored EPUB specs (Sigil, standardebooks, w3c)
|-- scripts/                      # start_full_app.sh, verify_changes.sh
|-- ACTION_ITEMS.md               # Voice attribution engineering history
|-- AI_CONVERSION_PROMPT_REVIEW.md
|-- CHANGELOG.md
|-- EPUB_STANDARDIZATION_AND_EDITOR_NOTES.md
|-- How_voice_recogized.md        # Reverse-engineered voice recognition report
|-- PROMPT_fix_attribution.md     # Vietnamese speaker attribution prompt
`-- README.md (this file)
```

## Quick start

See [`app/ebook-converter/README.md`](./app/ebook-converter/README.md) for the full quick-start, configuration, REST API, and project structure docs.

From the repository root:

```bash
./scripts/start_full_app.sh            # foreground
./scripts/start_full_app.sh --background
./scripts/verify_changes.sh            # lint + typecheck + tests + build + E2E smoke
```

## Dependencies (not in this repo)

These live in the parent Local-AI workspace and are referenced by configuration, not vendored here:

- **oMLX** local model server — `http://127.0.0.1:8080/v1` (Qwen/DeepSeek MLX models). Source: `lethanhanh2808/local-ai` workspace.
- **Redis** for BullMQ job queues.
- **VieNeu-TTS** Vietnamese neural TTS — vendored into `app/tts-service/VieNeu-TTS/` (git submodule pointer; working tree not tracked).

## Layout philosophy

This repo is intentionally narrow: only the ebook app, its TTS service, and the docs/scripts/reference needed to develop and run them. The oMLX runtime config, model cache, Homebrew install, and OpenCode CLI stay in the parent workspace where they're easier to manage alongside other AI tools.
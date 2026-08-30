# AI Audiobook Pipeline

This is a compact overview of the audiobook pipeline used by the app. It focuses on the current architecture and operator flow rather than long historical notes.

## Overview

The audiobook flow turns a converted book into chapter audio with voice mapping and local synthesis.

Typical steps:

1. Book is parsed and chapters are prepared.
2. Character detection identifies named roles and aliases.
3. Voices are assigned or created for each character.
4. The worker generates audio per chapter.
5. Playback is served from generated files with resume and seek support.

## Current stack

- Next.js app serves the UI and API
- Prisma stores book, chapter, and voice metadata
- Redis/BullMQ handles generation jobs
- VieNeu TTS is the active TTS backend
- oMLX is used for local AI analysis when needed

## Runtime flow

```text
UI / API
  -> queue audiobook job
  -> worker processes chapter data
  -> Python TTS service synthesizes segments
  -> MP3/WAV files are stored under the book output dir
  -> reader streams audio and records progress
```

## Key files

- app/ebook-converter/src/worker/audiobook.ts — audiobook generation worker
- app/tts-service/audiobook_generator.py — chapter synthesis logic
- app/tts-service/character_detector.py — character recognition and alias detection
- app/ebook-converter/src/lib/db — data access and voice mapping helpers

## Operational notes

- The pipeline is local-first and does not rely on a cloud TTS provider.
- Voice mapping is persisted per book and per character.
- Generated chapter audio should be treated as derived output, not the source of truth.

## Related docs

- [README.md](./README.md)
- [../../docs/README.md](../../docs/README.md)

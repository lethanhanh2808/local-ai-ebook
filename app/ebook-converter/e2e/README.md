# Playwright E2E Suite

This directory contains browser and service-level validation for the ebook app.

## Test Layers

- `00-smoke.spec.ts`: fast daily validation. Checks service APIs, supported-format UI, library page, reader, read-aloud panel, audiobook panel, voice-management panel, voice-command button presence, Settings service health, basic EPUB editor entry, and audiobook playback controls.
- `01-voice-management.spec.ts`: deeper character/voice/TTS pipeline tests. These mutate the configured test book's character/voice rows.
- `02-ui-flows.spec.ts`: reader-side voice and character UI flows.
- `03-character-detection.spec.ts`: AI character detection UI and apply flow.
- `04-model-and-services.spec.ts`: model/settings/TTS service validation.
- `09-route-quality.spec.ts`: non-mutating desktop/mobile sweep of every
  user-facing route, including console errors, HTTP 5xx responses, and
  document-level horizontal overflow.

## Commands

From `app/ebook-converter`:

```bash
npm run test:e2e:local:smoke
npm run test:e2e:local
npm run test:e2e:headed
npm run test:e2e:ui
```

From repository root:

```bash
./scripts/verify_changes.sh
./scripts/verify_changes.sh --full-e2e
```

## Preflight

`npm run test:e2e:local:*` runs `scripts/e2e-preflight.ts` before Playwright. It checks:

- Next.js/library API
- worker + Redis
- `/api/tts/health`, Unified TTS, and VieNeu
- Settings API

If preflight fails, start the full stack first:

```bash
cd /Volumes/EXT-SSD/Users/anhl/Local-AI
./scripts/start_full_app.sh --background
./scripts/start_full_app.sh --status
```

## Test Book

The existing deeper voice tests default to:

```text
ffa65ac0-4010-40ea-9239-2fcea39c848f
```

Override it when needed:

```bash
E2E_BOOK_ID=<book-id> npm run test:e2e:local
```

> **Data-safety warning:** the full suite intentionally deletes and recreates
> character/voice/conversation-state rows for `E2E_BOOK_ID`. Point it at a
> disposable test book and database. The smoke and route-quality specs are
> non-mutating and are safe to run against a normal local library.

The smoke suite can use any book in the local library. The deeper character/voice tests expect the configured book to have `chapter003` and `chapter004`.

## Development Rule

After UI, TTS, conversion, worker, or documentation-contract changes, run at least:

```bash
./scripts/verify_changes.sh
```

Run full E2E when changing character detection, voice assignment, TTS routing, audiobook generation, or reader playback:

```bash
./scripts/verify_changes.sh --full-e2e
```

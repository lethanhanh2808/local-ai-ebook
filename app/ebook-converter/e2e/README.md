# E2E Suite

This directory contains browser-level validation for the ebook app.

## Test groups

- smoke: basic happy-path validation
- voice-management: voice and character flows
- ui-flows: reader and panel interaction flows
- character-detection: detection and apply logic
- model-and-services: service health and model validation
- route-quality: desktop/mobile route health checks

## Common commands

From app/ebook-converter:

```bash
npm run test:e2e:local:smoke
npm run test:e2e:local
npm run test:e2e:headed
npm run test:e2e:ui
```

## Preflight

The local E2E flow runs a preflight before Playwright executes tests. This checks the app, worker, and TTS readiness first.

If the stack is not running:

```bash
cd /Volumes/EXT-SSD/Users/anhl/local-ai-ebook
./scripts/start_full_app.sh --background
```

## Fixture model

The suite uses deterministic fixture books where possible so E2E runs are stable and reproducible.

## Safety note

Some E2E flows mutate test data. Use a disposable local book or isolated environment for the deeper voice and character scenarios.

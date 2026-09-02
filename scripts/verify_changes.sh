#!/usr/bin/env bash
# Run the standard verification set after code changes.
#
# Usage:
#   ./scripts/verify_changes.sh              # lint + typecheck + tests + build + E2E smoke
#   ./scripts/verify_changes.sh --full-e2e   # same gate + full Playwright suite
#   SKIP_E2E=1 ./scripts/verify_changes.sh   # everything except Playwright
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/app/ebook-converter"
MODE="${1:-}"

if [[ "$MODE" != "" && "$MODE" != "--full-e2e" ]]; then
  echo "Unknown option: $MODE" >&2
  exit 2
fi

echo "[verify] shell syntax"
bash -n "$ROOT_DIR/scripts/start_full_app.sh"
bash -n "$APP_DIR/scripts/start-worker.sh"
bash -n "$ROOT_DIR/app/tts-service/scripts/start-tts.sh"
bash -n "$ROOT_DIR/app/tts-service/start_all.sh"
bash -n "$ROOT_DIR/app/tts-service/stop_all.sh"

cd "$APP_DIR"

echo "[verify] TypeScript"
npm run typecheck

echo "[verify] lint"
npm run lint

echo "[verify] unit tests"
npm test

echo "[verify] Python TTS tests"
npm run test:python

echo "[verify] production build"
npm run build

if [[ "${SKIP_E2E:-0}" == "1" ]]; then
  echo "[verify] skipping E2E because SKIP_E2E=1"
  exit 0
fi

echo "[verify] full stack status"
"$ROOT_DIR/scripts/start_full_app.sh" --status

if [[ "$MODE" == "--full-e2e" ]]; then
  echo "[verify] Playwright full E2E"
  npm run test:e2e:local
else
  echo "[verify] Playwright smoke E2E"
  npm run test:e2e:local:smoke
fi

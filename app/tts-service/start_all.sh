#!/usr/bin/env bash
# Start the local TTS stack (VieNeu on :5020).
#
# Thin wrapper around scripts/start-tts.sh — the actual supervisor. Kept
# as a top-level command so existing operator muscle memory still works:
# `bash app/tts-service/start_all.sh` does what it always did, but now the
# process is supervised and auto-restarts on crash.
#
# Usage:
#   bash start_all.sh                    # start (no-op if already running)
#   bash start_all.sh --stop             # stop
#   bash start_all.sh --status           # status
#   bash start_all.sh --restart          # restart
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Forward any sub-command through to the supervisor
exec bash "$SCRIPT_DIR/scripts/start-tts.sh" "${@:---start}"

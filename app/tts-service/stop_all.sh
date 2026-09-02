#!/usr/bin/env bash
# Stop the local TTS service (VieNeu on :5020).
#
# Thin wrapper around scripts/start-tts.sh --stop. Kept as a top-level
# command for operator muscle memory. Uses the supervisor's PID files so
# the python child is killed cleanly (SIGTERM with 10s grace, then
# SIGKILL) — much gentler than the previous `kill -9` by port.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec bash "$SCRIPT_DIR/scripts/start-tts.sh" --stop

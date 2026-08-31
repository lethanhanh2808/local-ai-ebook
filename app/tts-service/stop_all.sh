#!/usr/bin/env bash
# Stop the local TTS service. VieNeu runs on :5020.
set -uo pipefail

port="${VIENEU_PORT:-5020}"
pids=$(lsof -ti ":$port" 2>/dev/null)
if [ -n "$pids" ]; then
  echo "Killing :$port → $pids"
  kill -9 $pids 2>/dev/null
fi

# Also kill any lingering engine processes started by start_all.sh.
pkill -f "vieneu_server.py" 2>/dev/null

echo "✓ TTS stack stopped"

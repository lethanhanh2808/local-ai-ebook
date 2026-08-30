#!/usr/bin/env bash
# Stop the local TTS services.
#
# As of 2026-08-30 two engines may be running:
#   - VieNeu-TTS :5020  (vieneu_server.py)
#   - F5-TTS     :5021  (f5_server.py)
set -uo pipefail

for port in 5020 5021; do
  pids=$(lsof -ti ":$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "Killing :$port → $pids"
    kill -9 $pids 2>/dev/null
  fi
done

# Also kill any lingering engine processes started by start_all.sh.
pkill -f "vieneu_server.py" 2>/dev/null
pkill -f "f5_server.py" 2>/dev/null

echo "✓ TTS stack stopped"
#!/usr/bin/env bash
# Stop the local TTS services (VieNeu).
#
# As of 2026-07-12 the only running service is VieNeu-TTS on :5020. Piper
# (:5002) and the unified router (:5010) were removed.
set -uo pipefail

for port in 5020; do
  pids=$(lsof -ti ":$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "Killing :$port → $pids"
    kill -9 $pids 2>/dev/null
  fi
done

# Also kill any lingering VieNeu python processes started by this script.
pkill -f "vieneu_server.py" 2>/dev/null

echo "✓ TTS stack stopped"

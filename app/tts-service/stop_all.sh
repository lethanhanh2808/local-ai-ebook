#!/usr/bin/env bash
# Stop all TTS services (Piper + VieNeu + Unified)
set -uo pipefail

for port in 5002 5010 5020 18083; do
  pids=$(lsof -ti ":$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "Killing :$port → $pids"
    kill -9 $pids 2>/dev/null
  fi
done

# Also kill any lingering python processes for our servers
pkill -f "unified_server.py" 2>/dev/null
pkill -f "vieneu_server.py" 2>/dev/null
pkill -f "app/tts-service/server.py" 2>/dev/null

echo "✓ TTS stack stopped"

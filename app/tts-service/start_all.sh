#!/usr/bin/env bash
# Start the local TTS stack. Currently a single engine (VieNeu) on :5020.
#
# Usage: bash start_all.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VIENEU_PORT="${VIENEU_PORT:-5020}"

mkdir -p logs

# ── VieNeu-TTS ─────────────────────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/VieNeu-TTS/.venv" ]; then
  echo "[start] ⚠ VieNeu-TTS not installed (no .venv). Run scripts/setup_vieneu.sh to enable."
  exit 0
fi

lsof -ti ":$VIENEU_PORT" | xargs kill -9 2>/dev/null || true
echo "[start] Starting VieNeu on :$VIENEU_PORT ..."
( cd "$SCRIPT_DIR/VieNeu-TTS" && nohup .venv/bin/python ../vieneu_server.py > "$SCRIPT_DIR/logs/vieneu.log" 2>&1 & )
echo "[start]   VieNeu launched (log: logs/vieneu.log)"

# ── Wait & health-check ────────────────────────────────────────────────
sleep 6

echo ""
echo "Health check:"
status=$(curl -s -m 3 "http://127.0.0.1:$VIENEU_PORT/health" 2>/dev/null \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null || echo "✗")
echo "  VieNeu :$VIENEU_PORT → $status"

echo ""
echo "Logs:   $SCRIPT_DIR/logs/vieneu.log"
echo "Stop:   bash $SCRIPT_DIR/stop_all.sh"

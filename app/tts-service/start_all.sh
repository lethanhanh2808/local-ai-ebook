#!/usr/bin/env bash
# Start the local TTS stack.
#
# As of 2026-07-12 the stack is consolidated to a single VieNeu-TTS process
# on :5020. Piper and MOSS-TTS-Nano were removed, so there is nothing else
# to start. Re-run this script whenever the VieNeu process is unhealthy or
# after a machine reboot.
#
# Usage: bash start_all.sh [vieneu-port]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VIENEU_PORT="${1:-5020}"

mkdir -p logs

# ── VieNeu-TTS (Vietnamese-native, voices + cloning) ───────────────────
if [ ! -d "$SCRIPT_DIR/VieNeu-TTS/.venv" ]; then
  echo "[start] ✗ VieNeu-TTS not installed. Run scripts/setup_vieneu.sh first."
  exit 1
fi

lsof -ti ":$VIENEU_PORT" | xargs kill -9 2>/dev/null || true
echo "[start] Starting VieNeu-TTS on :$VIENEU_PORT ..."
cd "$SCRIPT_DIR/VieNeu-TTS"
VIENEU_PORT=$VIENEU_PORT nohup .venv/bin/python "$SCRIPT_DIR/vieneu_server.py" > "$SCRIPT_DIR/logs/vieneu.log" 2>&1 &
VIENEU_PID=$!
cd "$SCRIPT_DIR"
echo "[start]   VieNeu PID: $VIENEU_PID"

# ── Wait & health-check ────────────────────────────────────────────────
sleep 5

echo ""
echo "Health check:"
echo "  VieNeu :$(curl -s -m 3 http://127.0.0.1:$VIENEU_PORT/health 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null || echo '✗')"

echo ""
echo "✓ TTS stack running:"
echo "    VieNeu (Vietnamese-native + cloning):  http://127.0.0.1:$VIENEU_PORT"
echo ""
echo "Stop with:  bash $SCRIPT_DIR/stop_all.sh"

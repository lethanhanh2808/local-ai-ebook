#!/usr/bin/env bash
# Start the local TTS stack.
#
# As of 2026-08-30 the stack has two engines and either may be missing:
#   - VieNeu-TTS   :5020  Vietnamese-native with built-in voices + cloning
#   - F5-TTS       :5021  Vietnamese zero-shot cloning (f5-tts-mlx)
#
# Missing venvs are SKIPPED with a warning rather than fatal — the runtime
# provider switch in the app picks whichever is available.
#
# Usage: bash start_all.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VIENEU_PORT="${VIENEU_PORT:-5020}"
F5_PORT="${F5_PORT:-5021}"

mkdir -p logs

start_engine() {
  # start_engine <name> <port> <workdir> <server-py> <log-name>
  local name="$1" port="$2" workdir="$3" server="$4" logname="$5"

  if [ ! -d "$workdir/.venv" ]; then
    echo "[start] ⚠ $name: venv missing at $workdir/.venv — skipping (run scripts/setup_${name,,}.sh to install)"
    return
  fi

  lsof -ti ":$port" | xargs kill -9 2>/dev/null || true
  echo "[start] Starting $name on :$port ..."
  ( cd "$workdir" && nohup .venv/bin/python "$server" > "$SCRIPT_DIR/logs/$logname" 2>&1 & )
  echo "[start]   $name launched (log: logs/$logname)"
}

# ── VieNeu-TTS ─────────────────────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/VieNeu-TTS/.venv" ]; then
  echo "[start] ⚠ VieNeu-TTS not installed (no .venv). Run scripts/setup_vieneu.sh to enable."
else
  start_engine "VieNeu" "$VIENEU_PORT" "$SCRIPT_DIR/VieNeu-TTS" \
    "$SCRIPT_DIR/vieneu_server.py" "vieneu.log"
fi

# ── F5-TTS (Vietnamese zero-shot cloning) ──────────────────────────────
start_engine "F5" "$F5_PORT" "$SCRIPT_DIR/F5-TTS" \
  "$SCRIPT_DIR/F5-TTS/f5_server.py" "f5.log"

# ── Wait & health-check ────────────────────────────────────────────────
sleep 6

echo ""
echo "Health check:"
for pair in "VieNeu:$VIENEU_PORT" "F5:$F5_PORT"; do
  name="${pair%%:*}"; port="${pair##*:}"
  status=$(curl -s -m 3 "http://127.0.0.1:$port/health" 2>/dev/null \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null || echo "✗")
  echo "  $name :$port → $status"
done

echo ""
echo "Logs:   $SCRIPT_DIR/logs/{vieneu,f5}.log"
echo "Stop:   bash $SCRIPT_DIR/stop_all.sh"
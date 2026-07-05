#!/usr/bin/env bash
# Start the full TTS stack:
#   1. Piper TTS (port 5002) - Vietnamese fixed voices (legacy)
#   2. VieNeu-TTS (port 5020) - Vietnamese-native with built-in voices + cloning
#   3. MOSS-TTS Unified server (port 5010) - Piper + MOSS-TTS-Nano voice cloning
#
# Usage: bash start_all.sh [piper-port] [unified-port] [vieneu-port]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PIPER_PORT="${1:-5002}"
UNIFIED_PORT="${2:-5010}"
VIENEU_PORT="${3:-5020}"
PIPER_VENV="/tmp/tts-venv"

mkdir -p logs

# ── 1. Piper TTS ────────────────────────────────────────────────────────────
if [ ! -f "$PIPER_VENV/bin/python" ]; then
  echo "[start] Creating Piper venv at $PIPER_VENV ..."
  python3.11 -m venv "$PIPER_VENV"
  "$PIPER_VENV/bin/pip" install piper-tts fastapi uvicorn -q
fi

MODEL_DIR="$SCRIPT_DIR/models"
MODEL="vi_VN-vais1000-medium"
mkdir -p "$MODEL_DIR"
if [ ! -f "$MODEL_DIR/$MODEL.onnx" ]; then
  echo "[start] Downloading Vietnamese voice model ($MODEL)..."
  BASE="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/vi/vi_VN/vais1000/medium"
  curl -# -L -o "$MODEL_DIR/$MODEL.onnx"      "$BASE/$MODEL.onnx"
  curl -# -L -o "$MODEL_DIR/$MODEL.onnx.json" "$BASE/$MODEL.onnx.json"
fi

lsof -ti ":$PIPER_PORT" | xargs kill -9 2>/dev/null || true
echo "[start] Starting Piper on :$PIPER_PORT ..."
nohup "$PIPER_VENV/bin/python" "$SCRIPT_DIR/server.py" > logs/piper.log 2>&1 &
PIPER_PID=$!
echo "[start]   Piper PID: $PIPER_PID"

# ── 2. VieNeu-TTS (Vietnamese-native, voices + cloning) ────────────────────
if [ -d "$SCRIPT_DIR/VieNeu-TTS/.venv" ]; then
  lsof -ti ":$VIENEU_PORT" | xargs kill -9 2>/dev/null || true
  echo "[start] Starting VieNeu-TTS on :$VIENEU_PORT ..."
  cd "$SCRIPT_DIR/VieNeu-TTS"
  VIENEU_PORT=$VIENEU_PORT nohup .venv/bin/python "$SCRIPT_DIR/vieneu_server.py" > "$SCRIPT_DIR/logs/vieneu.log" 2>&1 &
  VIENEU_PID=$!
  cd "$SCRIPT_DIR"
  echo "[start]   VieNeu PID: $VIENEU_PID"
else
  echo "[start] ⚠ VieNeu-TTS not installed (skipping). Run scripts/setup_vieneu.sh first."
  VIENEU_PID=""
fi

# ── 3. MOSS-TTS Unified server ──────────────────────────────────────────────
VENV="$SCRIPT_DIR/.venv-moss-nano"
if [ ! -f "$VENV/bin/python" ]; then
  echo "[start] ✗ MOSS-TTS venv missing (skipping). Run scripts/setup_moss_tts.sh first."
  UNIFIED_PID=""
else
  lsof -ti ":$UNIFIED_PORT" | xargs kill -9 2>/dev/null || true
  echo "[start] Starting MOSS-TTS Unified on :$UNIFIED_PORT ..."
  PORT=$UNIFIED_PORT nohup "$VENV/bin/python" "$SCRIPT_DIR/unified_server.py" > logs/unified.log 2>&1 &
  UNIFIED_PID=$!
  echo "[start]   Unified PID: $UNIFIED_PID"
fi

# ── Wait & health-check ─────────────────────────────────────────────────────
sleep 5

echo ""
echo "Health check:"
echo "  Piper  :$(curl -s -m 3 http://127.0.0.1:$PIPER_PORT/health 2>/dev/null | head -1 || echo '✗')"
echo "  VieNeu :$(curl -s -m 3 http://127.0.0.1:$VIENEU_PORT/health 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get(\"status\",\"?\"))' 2>/dev/null || echo '✗')"
echo "  Unified:$(curl -s -m 3 http://127.0.0.1:$UNIFIED_PORT/health 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get(\"status\",\"?\"))' 2>/dev/null || echo '✗')"

echo ""
echo "✓ TTS stack running:"
echo "    Piper   (Vietnamese legacy):  http://127.0.0.1:$PIPER_PORT"
echo "    VieNeu  (Vietnamese-native):  http://127.0.0.1:$VIENEU_PORT"
echo "    Unified (Piper + cloning):    http://127.0.0.1:$UNIFIED_PORT"
echo ""
echo "Stop with:  bash $SCRIPT_DIR/stop_all.sh"

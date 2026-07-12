#!/usr/bin/env bash
# Start the Piper TTS service locally.
# Called from the ebook-converter dev environment.
# Usage: ./start_tts.sh [port]

PORT="${1:-5002}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="/tmp/tts-venv"

if [ ! -f "$VENV/bin/python" ]; then
  echo "[TTS] Creating Python 3.11 venv at $VENV ..."
  python3.11 -m venv "$VENV"
  "$VENV/bin/pip" install piper-tts fastapi uvicorn -q
fi

# Check if model exists, download if not
MODEL_DIR="$SCRIPT_DIR/models"
MODEL="vi_VN-vais1000-medium"
mkdir -p "$MODEL_DIR"
if [ ! -f "$MODEL_DIR/$MODEL.onnx" ]; then
  echo "[TTS] Downloading Vietnamese voice model ($MODEL)..."
  BASE="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/vi/vi_VN/vais1000/medium"
  curl -# -L -o "$MODEL_DIR/$MODEL.onnx"      "$BASE/$MODEL.onnx"
  curl -# -L -o "$MODEL_DIR/$MODEL.onnx.json" "$BASE/$MODEL.onnx.json"
fi

# Kill any existing server on this port
lsof -ti ":$PORT" | xargs kill -9 2>/dev/null || true

echo "[TTS] Starting Piper TTS server on port $PORT ..."
exec "$VENV/bin/python" "$SCRIPT_DIR/server.py"

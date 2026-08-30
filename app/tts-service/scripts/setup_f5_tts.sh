#!/usr/bin/env bash
# One-time setup for the F5-TTS (Vietnamese) MLX server.
#
# Creates app/tts-service/F5-TTS/.venv, installs the MLX runtime, downloads the
# hynt/F5-TTS-Vietnamese-ViVoice checkpoint from Hugging Face, and converts it
# to the safetensors layout that f5-tts-mlx expects.
#
# The model is CC-BY-NC-SA-4.0 (non-commercial). See f5_server.py header.
#
# Idempotent: re-running skips the venv and the download if they already exist.
#
# Usage: bash scripts/setup_f5_tts.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # app/tts-service
F5_DIR="$SCRIPT_DIR/F5-TTS"
MODEL_DIR="$F5_DIR/models/vietnamese"

HF_REPO="hynt/F5-TTS-Vietnamese-ViVoice"
HF_BASE="https://huggingface.co/$HF_REPO/resolve/main"

echo "[setup-f5] Target: $F5_DIR"
mkdir -p "$MODEL_DIR" "$F5_DIR/voices"

# ── venv ────────────────────────────────────────────────────────────────────
# Python 3.11: the system python3 is 3.14, which is ahead of what the MLX
# audio stack builds against. 3.11 is what TTS_PYTHON already points at.
if [ ! -d "$F5_DIR/.venv" ]; then
  echo "[setup-f5] Creating venv (python 3.11) ..."
  uv venv --python 3.11 "$F5_DIR/.venv" || { echo "[setup-f5] ✗ uv venv failed"; exit 1; }
else
  echo "[setup-f5] venv already present — skipping"
fi

PY="$F5_DIR/.venv/bin/python"

echo "[setup-f5] Installing runtime deps ..."
VIRTUAL_ENV="$F5_DIR/.venv" uv pip install --python "$PY" \
  "f5-tts-mlx==0.2.6" fastapi uvicorn soundfile numpy \
  || { echo "[setup-f5] ✗ runtime install failed"; exit 1; }

# torch is needed ONLY to read the .pt checkpoint once. CPU wheel keeps it small.
echo "[setup-f5] Installing conversion + transcription deps ..."
VIRTUAL_ENV="$F5_DIR/.venv" uv pip install --python "$PY" \
  torch safetensors mlx-whisper \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  || { echo "[setup-f5] ✗ conversion deps install failed"; exit 1; }

# ── checkpoint download ─────────────────────────────────────────────────────
# NOTE: this repo has no vocab.txt. Its `config.json` IS the character vocab
# (2566 lines), which is why Hugging Face flags it as invalid JSON. We download
# it under its real meaning and convert_ckpt.py renames it.
if [ ! -f "$MODEL_DIR/model_last.pt" ]; then
  echo "[setup-f5] Downloading model_last.pt (~1.3GB) ..."
  curl -fL --progress-bar "$HF_BASE/model_last.pt" -o "$MODEL_DIR/model_last.pt" \
    || { echo "[setup-f5] ✗ checkpoint download failed"; exit 1; }
else
  echo "[setup-f5] model_last.pt already present — skipping download"
fi

if [ ! -f "$MODEL_DIR/config.json" ]; then
  echo "[setup-f5] Downloading config.json (the vocab) ..."
  curl -fL --progress-bar "$HF_BASE/config.json" -o "$MODEL_DIR/config.json" \
    || { echo "[setup-f5] ✗ vocab download failed"; exit 1; }
fi

# ── convert ─────────────────────────────────────────────────────────────────
echo "[setup-f5] Converting checkpoint ..."
"$PY" "$F5_DIR/convert_ckpt.py" || { echo "[setup-f5] ✗ conversion failed"; exit 1; }

echo ""
echo "[setup-f5] ✓ Done."
echo "    Next: bash $SCRIPT_DIR/scripts/prepare_f5_voices.sh"

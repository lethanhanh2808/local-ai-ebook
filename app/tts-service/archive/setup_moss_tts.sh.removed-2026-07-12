#!/usr/bin/env bash
# Setup MOSS-TTS-Nano (ONNX CPU) as a secondary TTS engine
# alongside your existing Piper setup.
# Safe: does NOT touch oMLX or existing Piper install.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

VENV="$ROOT/.venv-moss-nano"
PYTHON="/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11"

if [ ! -f "$PYTHON" ]; then
  echo "❌ Expected Python 3.11 at $PYTHON"
  exit 1
fi

echo "==> Creating venv at $VENV ..."
$PYTHON -m venv "$VENV"
source "$VENV/bin/activate"
pip install --quiet --upgrade pip

echo "==> Cloning MOSS-TTS-Nano ..."
cd "$ROOT"
if [ ! -d "MOSS-TTS-Nano" ]; then
  git clone --depth 1 https://github.com/OpenMOSS/MOSS-TTS-Nano.git
fi

echo "==> Installing MOSS-TTS-Nano (ONNX CPU profile) ..."
cd MOSS-TTS-Nano
pip install --quiet -r requirements.txt
pip install --quiet -e .

echo "==> Pre-downloading ONNX weights (~400 MB) ..."
python infer_onnx.py \
  --execution-provider cpu \
  --prompt-audio-path assets/audio/zh_1.wav \
  --text "test" 2>&1 | tail -5 || echo "(weights will download on first run)"

echo ""
echo "✓ Setup complete!"
echo ""
echo "Test with:"
echo "  cd $ROOT/MOSS-TTS-Nano"
echo "  source $VENV/bin/activate"
echo "  python app_onnx.py --port 5003"
echo ""
echo "⚠️  Note: Nano does NOT support Vietnamese."
echo "    Use VieNeu-TTS (port 5020) for Vietnamese books."

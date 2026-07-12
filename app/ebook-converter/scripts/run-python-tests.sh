#!/usr/bin/env bash
# scripts/run-python-tests.sh
#
# Drive the Python TTS test suite via npm.
# Two-pass because the test set splits by env:
#
#   1. Most tests (attribution, conversation state, character detector, …)
#      only need system python3 + httpx. They import the local modules
#      `conversation_attribution`, `vncorenlp_attribution`, `vi_g2p` from
#      `app/tts-service/` directly — no extra venv required.
#
#   2. `tests/test_vieneu_server.py` imports `vieneu_server` which pulls
#      in `fastapi` + `numpy` + the VieNeu runtime. Those live in the
#      uv-managed `app/tts-service/VieNeu-TTS/.venv/` and aren't on the
#      system path — run just that one file against that interpreter.
#
# 2026-07-12 cleanup: replaces the previous hard-coded
# `../tts-service/.venv-moss-nano/bin/python` invocation that broke when
# the MOSS-Nano venv was removed alongside the MOSS-TTS-Nano backend.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TTS_DIR="$(cd "$SCRIPT_DIR/../../tts-service" && pwd)"
VIENEU_PY="$TTS_DIR/VieNeu-TTS/.venv/bin/python"

# test_vieneu_server.py imports `vieneu_server` which requires fastapi + numpy
# (only present in the VieNeu uv-managed venv). Move it aside before discovery,
# run the rest on the system interpreter, then run that one file under the
# VieNeu venv. Restore it on exit either way.
VIENEU_TEST="$TTS_DIR/tests/test_vieneu_server.py"
mv "$VIENEU_TEST" "${VIENEU_TEST}.bak"
trap 'mv -f "${VIENEU_TEST}.bak" "$VIENEU_TEST" 2>/dev/null || true' EXIT

echo "[test:python] running attribution + conversation-state + detector tests (system python3)…"
PYTHONPATH="$TTS_DIR" python3 -m unittest discover \
    -s "$TTS_DIR/tests" \
    -p 'test_*.py'

mv "${VIENEU_TEST}.bak" "$VIENEU_TEST"
trap - EXIT

echo
echo "[test:python] running vieneu_server test (VieNeu venv: $VIENEU_PY)…"
cd "$TTS_DIR"
PYTHONPATH="$TTS_DIR" "$VIENEU_PY" -m unittest \
    -v \
    tests.test_vieneu_server

echo
echo "[test:python] OK"

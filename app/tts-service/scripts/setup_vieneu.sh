#!/usr/bin/env bash
# One-time setup for the VieNeu-TTS Vietnamese engine.
#
# Clones pnnbao97/VieNeu-TTS into app/tts-service/VieNeu-TTS/, runs
# `uv sync` to create a uv-managed venv with Python 3.11 + all runtime
# deps (sea-g2p, onnxruntime, soundfile, soxr, fastapi, uvicorn, ...).
#
# The repo ships a real pyproject.toml (vieneu==3.3.0, Apache-2.0, torch-free
# ONNX runtime — runs on CPU, no GPU required). `uv sync` is exactly what
# the upstream Makefile target `setup` runs, plus we pin Python to 3.11 to
# match TTS_PYTHON (the standard interpreter the rest of app/tts-service uses).
#
# Model weights (ONNX, ~1.2 GB) are fetched on first import by the
# `huggingface_hub` cache, so this script is fast.
#
# Idempotent: re-running skips clone if .git exists and reuses the venv.
#
# Usage:
#   bash scripts/setup_vieneu.sh
#
# After setup:
#   - run on host:   cd app/tts-service/VieNeu-TTS && uv run python ../vieneu_server.py
#   - run in docker: docker compose up tts-vieneu   (compose file mounts the dir)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # app/tts-service
VIENEU_DIR="$SCRIPT_DIR/VieNeu-TTS"
VIENEU_REPO="https://github.com/pnnbao97/VieNeu-TTS.git"
VIENEU_BRANCH="${VIENEU_BRANCH:-main}"

echo "[setup-vieneu] Target: $VIENEU_DIR"

# ── uv (needed for venv + python version mgmt) ──────────────────────────────
if ! command -v uv >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/uv" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    echo "[setup-vieneu] ✗ uv not found — install from https://docs.astral.sh/uv/getting-started/installation/"
    exit 1
  fi
fi

# ── Clone repo ──────────────────────────────────────────────────────────────
# Depth 1 keeps the clone small (~30 MB). GIT_LFS_SKIP_SMUDGE=1 is a
# belt-and-braces guard in case upstream ever adds LFS-tracked files.
if [ ! -d "$VIENEU_DIR" ] || [ ! -d "$VIENEU_DIR/.git" ]; then
  echo "[setup-vieneu] Cloning $VIENEU_REPO (branch: $VIENEU_BRANCH, depth 1) ..."
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch "$VIENEU_BRANCH" "$VIENEU_REPO" "$VIENEU_DIR" \
    || { echo "[setup-vieneu] ✗ git clone failed"; exit 1; }
else
  echo "[setup-vieneu] $VIENEU_DIR already present — skipping clone"
fi

# ── uv sync (venv + pyproject deps in one step) ─────────────────────────────
# `uv sync --python 3.11` creates .venv/ (if missing) with the pinned
# Python, then installs everything in pyproject.toml [project.dependencies]
# + the local `vieneu` package in editable mode. Equivalent to what the
# upstream Makefile target `setup` does.
cd "$VIENEU_DIR"
echo "[setup-vieneu] uv sync (python 3.11) ..."
uv sync --python 3.11 \
  || { echo "[setup-vieneu] ✗ uv sync failed"; exit 1; }

# ── Make .venv/bin/python Docker-friendly ──────────────────────────────────
# uv creates .venv/bin/python as an absolute symlink to
# ~/.local/share/uv/python/cpython-3.11-linux-x86_64-gnu/bin/python3.11.
# That path is OUTSIDE the bind mount we ship to the tts-vieneu container,
# so the symlink is dangling inside the container → OCI runtime exec fails
# with ENOENT. The fix is a small wrapper script in app/tts-service/bin/
# that the tts-vieneu service is configured to call instead. It execs the
# container's /usr/local/bin/python3.11 (from python:3.11-slim) with
# PYTHONPATH pointing at the bind-mounted site-packages, so vieneu + its
# deps resolve. The host-side venv symlink is left untouched so the
# `cd $VIENEU_DIR && uv run python ...` workflow keeps working.
WRAPPER="$SCRIPT_DIR/bin/docker-python.sh"
mkdir -p "$(dirname "$WRAPPER")"
if [ ! -x "$WRAPPER" ] || [ "$WRAPPER" -ot "$0" ]; then
  cat > "$WRAPPER" <<'WRAP'
#!/bin/sh
# Wrapper used ONLY by the tts-vieneu Docker service (see
# scripts/setup_vieneu.sh and docker-compose.yml).
#
# Inside the python:3.11-slim container the venv's `bin/python` is a
# symlink to ~/.local/share/uv/python/... which lives outside our bind
# mount, so exec-ing it directly returns ENOENT. The container's
# /usr/local/bin/python3.11 IS available — exec that with PYTHONPATH
# pointing at the bind-mounted site-packages so vieneu + its deps
# resolve. pyvenv.cfg next to bin/ also drives site-packages lookup.
set -e
VENV_SITE="/app/tts-service/VieNeu-TTS/.venv/lib/python3.11/site-packages"
VENV_SRC="/app/tts-service/VieNeu-TTS"
export PYTHONPATH="${VENV_SRC}:${VENV_SITE}${PYTHONPATH:+:$PYTHONPATH}"
exec /usr/local/bin/python3.11 "$@"
WRAP
  chmod +x "$WRAPPER"
  echo "[setup-vieneu] Wrote $WRAPPER (Docker-friendly python wrapper)"
fi

# ── Sanity check ──────────────────────────────────────────────────────────
echo "[setup-vieneu] Importing vieneu (model load deferred to first inference) ..."
"$PY" -c "from vieneu import Vieneu; t = Vieneu(); print('[setup-vieneu] ✓ Vieneu ready, backend=', type(t).__name__, 'sample_rate=', getattr(t, 'sample_rate', '?'))" \
  || { echo "[setup-vieneu] ✗ Vieneu import failed"; exit 1; }

echo ""
echo "[setup-vieneu] ✓ Done."
echo "    Run: cd $SCRIPT_DIR/VieNeu-TTS && uv run python ../vieneu_server.py"
echo "    Or:  docker compose up tts-vieneu   (from app/ebook-converter)"
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

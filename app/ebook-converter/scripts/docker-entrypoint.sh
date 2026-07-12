#!/bin/sh
# docker-entrypoint.sh — prepare the container before launching the Node server.
#
# 2026-07-12 cleanup: the previous `.venv-moss-nano` venv-shim block was
# removed along with the MOSS-TTS-Nano backend (commit 252fad7a).
#
# The container now ships its own `python3` + `httpx` in the Dockerfile,
# and `character_detector.py` is spawned as the in-container system
# Python 3 — no host bind-mount shim is required.
#
# This script is retained as the entrypoint so both `app` (server.js)
# and `worker` (worker.js) continue to start cleanly. Add any future
# container-bootstrap steps here.

set -eu

exec "$@"

#!/bin/sh
# docker-entrypoint.sh — prepare the container before launching the Node server.
#
# Two responsibilities:
#   1. Fix the host-symlinked Python venv inside /app/tts-service.
#      The bind-mounted .venv-moss-nano/bin/python3.11 symlink points at
#      /Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11
#      (a host path that doesn't exist inside the container). We rewrite
#      it to the in-container /usr/bin/python3.11 (installed in the
#      Dockerfile) — keeping the bind-mount read-only while still giving
#      character_detector.py a working interpreter.
#
#   2. Export TTS_PYTHON_OVERRIDE so the Next.js route at
#      src/app/api/library/[id]/characters/detect/route.ts can locate the
#      shimmed interpreter even though it hard-codes the bind-mount path.
#
#   3. Hand off to whatever CMD was given. We keep this script as the
#      entrypoint so both app (server.js) and worker (worker.js) benefit.

set -eu

VENV_PY="/app/tts-service/.venv-moss-nano/bin/python3.11"
SHIM_BIN=""
if [ -L "$VENV_PY" ] || [ -f "$VENV_PY" ]; then
  # If the symlink target doesn't resolve, rebuild a working copy.
  if ! "$VENV_PY" --version >/dev/null 2>&1; then
    if [ -e /usr/bin/python3.11 ]; then
      VENV_BIN="$(dirname "$VENV_PY")"
      SHIM_BIN="/tmp/venv-bin-$$"
      mkdir -p "$SHIM_BIN"
      for entry in "$VENV_BIN"/*; do
        name="$(basename "$entry")"
        case "$name" in
          python3.11|python|python3)
            # Rewrite broken interpreter symlinks to the in-container python.
            ln -sf /usr/bin/python3.11 "$SHIM_BIN/$name" ;;
          *)
            if [ -L "$entry" ]; then
              cp -P "$entry" "$SHIM_BIN/$name"
            else
              cp -p "$entry" "$SHIM_BIN/$name"
            fi ;;
        esac
      done
      chmod +x "$SHIM_BIN"/* 2>/dev/null || true
      export PATH="$SHIM_BIN:$PATH"
      # The route's resolvePython() looks up the literal venv path; expose
      # a hint env var so it can fall back to the shim.
      export TTS_PYTHON_OVERRIDE="$SHIM_BIN/python"
      echo "[entrypoint] Rewrote broken venv python3.11 → /usr/bin/python3.11 (shim at $SHIM_BIN)"
    else
      echo "[entrypoint] WARNING: venv python is broken AND /usr/bin/python3.11 missing — character_detector will fail." >&2
    fi
  else
    # venv is healthy; expose its interpreter for the route.
    export TTS_PYTHON_OVERRIDE="$VENV_PY"
  fi
fi

exec "$@"
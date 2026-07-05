#!/usr/bin/env bash
# scripts/start-worker.sh
#
# Robust worker launcher — runs the BullMQ conversion worker in the
# background, auto-restarts on crash, and writes logs + PID to
# `data/worker-runtime/` so it can be stopped later.
#
# Usage:
#   ./scripts/start-worker.sh --start    # start in background (no-op if already running)
#   ./scripts/start-worker.sh            # foreground auto-restart loop (launchd-friendly)
#   ./scripts/start-worker.sh --stop     # stop a previously-started worker
#   ./scripts/start-worker.sh --status   # print "running" / "stopped" + PID
#   ./scripts/start-worker.sh --restart  # stop + start
#
# Designed to be called from:
#   1. The Next.js dashboard's "Start worker" button (POST /api/worker/start)
#   2. A macOS launchd plist at login (see scripts/install-worker-launchd.sh)
#   3. A bare `nohup ./scripts/start-worker.sh &` from a shell

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$APP_DIR/data/worker-runtime"
PID_FILE="$RUNTIME_DIR/worker.pid"
LOG_FILE="$RUNTIME_DIR/worker.log"
LAUNCH_TIME_FILE="$RUNTIME_DIR/launched-at"

mkdir -p "$RUNTIME_DIR"

# ── Helpers ─────────────────────────────────────────────────────────────
is_running() {
  if [[ ! -f "$PID_FILE" ]]; then return 1; fi
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

stop_worker() {
  if ! is_running; then
    echo "[stop] worker not running (no pid file or process gone)"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid; pid="$(cat "$PID_FILE")"
  echo "[stop] sending SIGTERM to pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true
  # Wait up to 10s for graceful shutdown
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "[stop] still alive, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "[stop] stopped"
}

start_worker() {
  if is_running; then
    echo "[start] worker already running (pid=$(cat "$PID_FILE")) — nothing to do"
    return 0
  fi
  cd "$APP_DIR"

  # Pick the tsx binary (project's node_modules/.bin)
  local tsx_bin="$APP_DIR/node_modules/.bin/tsx"
  if [[ ! -x "$tsx_bin" ]]; then
    echo "[start] ERROR: $tsx_bin not found — run 'npm install' first"
    return 1
  fi

  # Launch detached. `setsid` is available on many Linux systems but not on
  # this macOS workspace, so fall back to plain `nohup` when needed.
  echo "[start] launching tsx src/worker/index.ts (logs → $LOG_FILE)"
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$tsx_bin" src/worker/index.ts > "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup "$tsx_bin" src/worker/index.ts > "$LOG_FILE" 2>&1 < /dev/null &
  fi
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LAUNCH_TIME_FILE"

  # Sanity-check the process is actually alive after 1s (catches immediate
  # failures like "tsx not found", "DB missing", etc.)
  sleep 1
  if ! kill -0 "$new_pid" 2>/dev/null; then
    echo "[start] ERROR: worker exited immediately — tail of log:"
    tail -20 "$LOG_FILE" 2>/dev/null || true
    rm -f "$PID_FILE"
    return 1
  fi
  echo "[start] worker started (pid=$new_pid)"
  return 0
}

# ── Auto-restart loop (when run WITHOUT --stop/--status/--restart) ────
auto_restart_loop() {
  cd "$APP_DIR"
  while true; do
    # If an external launcher (launchd / API) started us, we just exec
    # the worker directly. If we crash, the loop restarts us.
    "$APP_DIR/node_modules/.bin/tsx" src/worker/index.ts
    local code=$?
    echo "[auto-restart] worker exited with code=$code at $(date) — restarting in 3s"
    sleep 3
  done
}

print_status() {
  if is_running; then
    echo "running (pid=$(cat "$PID_FILE"))"
  else
    echo "stopped"
  fi
}

# ── Entry point ────────────────────────────────────────────────────────
case "${1:-}" in
  --stop)
    stop_worker
    ;;
  --status)
    print_status
    ;;
  --restart)
    stop_worker
    sleep 1
    start_worker
    ;;
  --start)
    start_worker
    ;;
  "")
    # Default: foreground auto-restart loop. Used by launchd plist.
    auto_restart_loop
    ;;
  *)
    # Back-compat for older API callers.
    start_worker
    ;;
esac

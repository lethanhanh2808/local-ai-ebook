#!/usr/bin/env bash
# scripts/start-worker.sh
#
# Background supervisor for the BullMQ conversion worker.
#
# Why this exists:
#   The earlier pattern ran `tsx src/worker/index.ts` directly inside a
#   tmux/terminal window. That meant:
#     • Killing the terminal killed the worker silently.
#     • Restarting required re-running the command by hand.
#     • A crash mid-runtime left DB rows in `processing` with no recovery
#       until the next manual start.
#
# This script fills that gap: it supervises the worker with PID-tracking,
# writes structured logs, and auto-restarts after a crash. It's the same
# shape as `start_full_app.sh` uses for Next.js.
#
# Usage:
#   bash scripts/start-worker.sh --start    Start (or no-op if already running)
#   bash scripts/start-worker.sh --stop     Send SIGTERM (graceful)
#   bash scripts/start-worker.sh --status   Report PID + liveness
#   bash scripts/start-worker.sh --restart   Stop + start
#
# Files:
#   data/worker-runtime/worker.pid           PID of the worker (or supervisor wrapper)
#   data/worker-runtime/supervisor.pid       PID of THIS supervisor process
#   data/worker-runtime/worker.log           stdout/stderr of the worker
#   data/worker-runtime/supervisor.log       stdout/stderr of THIS script

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/data/worker-runtime"
WORKER_PID_FILE="$RUNTIME_DIR/worker.pid"
SUP_PID_FILE="$RUNTIME_DIR/supervisor.pid"
WORKER_LOG="$RUNTIME_DIR/worker.log"
SUP_LOG="$RUNTIME_DIR/supervisor.log"

mkdir -p "$RUNTIME_DIR"

# How long to wait between death of the worker and supervisor restart
RESTART_DELAY_SEC=3
# Max restarts in a rolling 60-second window — guards against a broken
# worker crashing in a tight loop that prevents any other recovery.
RESTART_BURST_LIMIT=5
RESTART_BURST_WINDOW_SEC=60

cd "$ROOT_DIR"

is_pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid_file() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null | tr -d '[:space:]')"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  echo "$pid"
}

prune_if_dead() {
  local f="$1"
  local pid
  pid="$(read_pid_file "$f" || true)"
  if [[ -n "$pid" ]] && ! is_pid_alive "$pid"; then
    rm -f "$f"
  fi
}

# ── supervisor_loop ───────────────────────────────────────────────────────
# Runs in the background. Monitors worker.pid; restarts the worker when it
# dies. Killed by --stop.
supervisor_loop() {
  local burst=0
  local first_restart_ts=0
  while true; do
    prune_if_dead "$WORKER_PID_FILE"

    if [[ ! -f "$WORKER_PID_FILE" ]]; then
      # ── Worker is not running. Spawn one.
      local now
      now="$(date +%s)"
      if (( now - first_restart_ts > RESTART_BURST_WINDOW_SEC )); then
        burst=0
        first_restart_ts="$now"
      fi
      burst=$((burst + 1))
      if (( burst > RESTART_BURST_LIMIT )); then
        echo "[supervisor $(date -u +%FT%TZ)] burst limit hit ($burst restarts in ${RESTART_BURST_WINDOW_SEC}s); pausing for ${RESTART_BURST_WINDOW_SEC}s"
        sleep "$RESTART_BURST_WINDOW_SEC"
        burst=0
        first_restart_ts="$(date +%s)"
        continue
      fi

      if (( burst > 1 )); then
        echo "[supervisor $(date -u +%FT%TZ)] worker died; restart attempt #$burst in ${RESTART_DELAY_SEC}s (see $WORKER_LOG)"
        sleep "$RESTART_DELAY_SEC"
      else
        echo "[supervisor $(date -u +%FT%TZ)] starting worker (see $WORKER_LOG)"
      fi

      # Make sure node_modules/.bin is reachable
      if [[ ! -x "$ROOT_DIR/node_modules/.bin/tsx" ]]; then
        echo "[supervisor] tsx not found at node_modules/.bin/tsx — run \`npm install\` first"
        sleep 30
        continue
      fi

      # Spawn the actual worker detached. macOS lacks setsid(1), so we use
      # a nohup-with-stdin-redirect + disown trick that gives us the same
      # semantics (the worker ignores SIGHUP from this shell exiting and
      # does not receive a SIGTERM when the supervisor exits cleanly —
      # the supervisor's stop path is the only way to take it down).
      nohup ./node_modules/.bin/tsx src/worker/index.ts \
        > "$WORKER_LOG" 2>&1 < /dev/null &
      local new_pid=$!
      disown "$new_pid" 2>/dev/null || true
      echo "$new_pid" > "$WORKER_PID_FILE"
      echo "[supervisor $(date -u +%FT%TZ)] spawned worker pid=$new_pid"
    fi

    # Poll every 5s — fast enough for snappy recovery, slow enough to
    # cost basically zero CPU.
    sleep 5
  done
}

start_command() {
  # Already running? No-op so repeated calls don't double-spawn.
  prune_if_dead "$WORKER_PID_FILE"
  if [[ -f "$WORKER_PID_FILE" ]]; then
    local pid
    pid="$(cat "$WORKER_PID_FILE")"
    echo "[ok] worker already running (pid=$pid)"
    return 0
  fi

  # Make sure a previous supervisor wasn't left behind.
  local sup_pid
  sup_pid="$(read_pid_file "$SUP_PID_FILE" || true)"
  if [[ -n "$sup_pid" ]] && is_pid_alive "$sup_pid"; then
    echo "[ok] supervisor already running (pid=$sup_pid); it will spawn the worker"
    # Force-spawn immediately so the API doesn't lie about readiness.
    rm -f "$WORKER_PID_FILE"
    return 0
  fi

  # Start the supervisor in the background, detached from this shell.
  # Mac lacks setsid; nohup + stdio-redirect + disown gives us the same
  # detachment (PID stays alive after the API request exits).
  nohup bash -c 'cd "'"$ROOT_DIR"'" && exec bash "'"$0"'" __supervisor' \
    -- "$0" >> "$SUP_LOG" 2>&1 < /dev/null &
  local sup_new_pid=$!
  echo "$sup_new_pid" > "$SUP_PID_FILE"
  disown "$sup_new_pid" 2>/dev/null || true

  # Wait up to 30 half-second ticks for the worker to actually come up.
  local tick=0
  while (( tick < 30 )); do
    prune_if_dead "$WORKER_PID_FILE"
    if [[ -f "$WORKER_PID_FILE" ]]; then
      local pid
      pid="$(cat "$WORKER_PID_FILE")"
      if is_pid_alive "$pid"; then
        echo "[ok] worker started (pid=$pid); supervisor pid=$sup_new_pid"
        return 0
      fi
    fi
    sleep 0.5
    tick=$((tick + 1))
  done

  echo "[error] worker did not start within 15s; see $SUP_LOG" >&2
  return 1
}

stop_command() {
  prune_if_dead "$WORKER_PID_FILE"
  local sup_pruned=0
  local work_pruned=0

  local sup_pid
  sup_pid="$(read_pid_file "$SUP_PID_FILE" || true)"
  if [[ -n "$sup_pid" ]] && is_pid_alive "$sup_pid"; then
    echo "[stop] supervisor pid=$sup_pid"
    kill -TERM "$sup_pid" 2>/dev/null || true
    rm -f "$SUP_PID_FILE"
    sup_pruned=1
  fi

  local work_pid
  work_pid="$(read_pid_file "$WORKER_PID_FILE" || true)"
  if [[ -n "$work_pid" ]] && is_pid_alive "$work_pid"; then
    echo "[stop] worker pid=$work_pid"
    kill -TERM "$work_pid" 2>/dev/null || true
    # Give it 10s to shut down gracefully, then SIGKILL.
    local waited=0
    while (( waited < 10 )) && is_pid_alive "$work_pid"; do
      sleep 1
      waited=$((waited + 1))
    done
    if is_pid_alive "$work_pid"; then
      echo "[stop] worker did not exit gracefully; sending SIGKILL"
      kill -KILL "$work_pid" 2>/dev/null || true
    fi
    rm -f "$WORKER_PID_FILE"
    work_pruned=1
  fi

  if (( sup_pruned == 0 && work_pruned == 0 )); then
    echo "[ok] worker already stopped"
  fi
}

status_command() {
  local work_pid sup_pid
  work_pid="$(read_pid_file "$WORKER_PID_FILE" || true)"
  sup_pid="$(read_pid_file "$SUP_PID_FILE" || true)"

  local alive_token="down"
  if [[ -n "$work_pid" ]] && is_pid_alive "$work_pid"; then
    alive_token="up (pid=$work_pid)"
  fi
  local sup_token="none"
  if [[ -n "$sup_pid" ]] && is_pid_alive "$sup_pid"; then
    sup_token="up (pid=$sup_pid)"
  fi

  echo "worker=$alive_token supervisor=$sup_token log=$WORKER_LOG"
}

restart_command() {
  stop_command || true
  # Brief grace period before respawn
  sleep 1
  start_command
}

# ── Mode dispatch ─────────────────────────────────────────────────────────
case "${1:-}" in
  __supervisor)
    supervisor_loop
    ;;
  --start)
    start_command
    ;;
  --stop)
    stop_command
    ;;
  --status)
    status_command
    ;;
  --restart)
    stop_command
    sleep 1
    start_command
    ;;
  *)
    echo "Usage: $0 --start|--stop|--status|--restart" >&2
    exit 2
    ;;
esac

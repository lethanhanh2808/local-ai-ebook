#!/usr/bin/env bash
# scripts/start-tts.sh
#
# Background supervisor for the local TTS service (vieneu_server.py on :5020).
#
# Why this exists:
#   The previous start_all.sh did `nohup .venv/bin/python ../vieneu_server.py &`
#   with no PID tracking and no auto-restart. If the Python process died
#   (OOM, segfault, model load failure, port conflict after a restart), the
#   Next.js reader & audiobook pipeline would silently fail. The user saw
#   "TTS offline" in the UI but had to SSH in to restart.
#
# This script mirrors scripts/start-worker.sh:
#   • PID-tracking
#   • Graceful SIGTERM with SIGKILL backstop
#   • Auto-restart on death (3s cooldown, 5-per-60s burst cap)
#   • Health-check before declaring "started"
#
# Usage:
#   bash scripts/start-tts.sh --start    Start (or no-op if already running)
#   bash scripts/start-tts.sh --stop     SIGTERM (10s grace, then SIGKILL)
#   bash scripts/start-tts.sh --status   Report PID + liveness
#   bash scripts/start-tts.sh --restart  Stop + start
#
# Files:
#   logs/vieneu.pid                       PID of the python process
#   logs/supervisor.pid                   PID of THIS supervisor script
#   logs/vieneu.log                       stdout/stderr of the TTS server
#   logs/supervisor.log                   stdout/stderr of THIS script
#
# Env overrides (read from .env.local / process env):
#   VIENEU_PORT                           Default 5020
#   VIENEU_VENV_PYTHON                    Default ./VieNeu-TTS/.venv/bin/python

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$TTS_DIR/logs"
WORKER_PID_FILE="$RUNTIME_DIR/vieneu.pid"
SUP_PID_FILE="$RUNTIME_DIR/supervisor.pid"
WORKER_LOG="$RUNTIME_DIR/vieneu.log"
SUP_LOG="$RUNTIME_DIR/supervisor.log"

mkdir -p "$RUNTIME_DIR"

RESTART_DELAY_SEC=3
RESTART_BURST_LIMIT=5
RESTART_BURST_WINDOW_SEC=60

# ── helpers ──────────────────────────────────────────────────────────────
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

# Best-effort: is the service actually listening on its port?
# macOS bash 3.2 doesn't support /dev/tcp/host/port. Use `nc -zG 1` if
# available (BSD nc on macOS), or fall back to lsof which is always
# installed on macOS. The lsof path is slow but reliable.
is_healthy() {
  local port="${VIENEU_PORT:-5020}"
  if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$port" 2>/dev/null; then
    return 0
  fi
  # lsof -tiTCP returns the PID(s) listening on the port. Any output = healthy.
  [ -n "$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1)" ]
}

# ── supervisor_loop ──────────────────────────────────────────────────────
supervisor_loop() {
  local burst=0
  local first_restart_ts=0
  while true; do
    prune_if_dead "$WORKER_PID_FILE"

    if [[ ! -f "$WORKER_PID_FILE" ]]; then
      local now
      now="$(date +%s)"
      if (( now - first_restart_ts > RESTART_BURST_WINDOW_SEC )); then
        burst=0
        first_restart_ts="$now"
      fi
      burst=$((burst + 1))
      if (( burst > RESTART_BURST_LIMIT )); then
        echo "[supervisor $(date -u +%FT%TZ)] burst limit hit ($burst restarts in ${RESTART_BURST_WINDOW_SEC}s); pausing"
        sleep "$RESTART_BURST_WINDOW_SEC"
        burst=0
        first_restart_ts="$(date +%s)"
        continue
      fi

      if (( burst > 1 )); then
        echo "[supervisor $(date -u +%FT%TZ)] TTS died; restart attempt #$burst in ${RESTART_DELAY_SEC}s (see $WORKER_LOG)"
        sleep "$RESTART_DELAY_SEC"
      else
        echo "[supervisor $(date -u +%FT%TZ)] starting TTS (see $WORKER_LOG)"
      fi

      # Determine which Python interpreter to use. Prefer the project's
      # venv, fall back to system python3.
      local py="${VIENEU_VENV_PYTHON:-}"
      if [[ -z "$py" || ! -x "$py" ]]; then
        py="$TTS_DIR/VieNeu-TTS/.venv/bin/python"
      fi
      if [[ ! -x "$py" ]]; then
        py="$(command -v python3 || true)"
      fi
      if [[ -z "$py" || ! -x "$py" ]]; then
        echo "[supervisor $(date -u +%FT%TZ)] no python interpreter found (venv missing and python3 not on PATH)"
        sleep 30
        continue
      fi

      # Spawn detached. The python process is launched from VieNeu-TTS/
      # because vieneu_server.py adds its own dir to sys.path and resolves
      # model paths relative to CWD — matching the original start_all.sh.
      ( cd "$TTS_DIR/VieNeu-TTS" && \
        nohup "$py" ../vieneu_server.py \
          > "$WORKER_LOG" 2>&1 < /dev/null &
        echo "$!" > "$WORKER_PID_FILE" ) &
      wait $! 2>/dev/null || true
      # The wait above lets the subshell finish its & + echo so the PID file
      # is written before we proceed. The actual python child is now its own
      # process group detached from this supervisor.

      if [[ -f "$WORKER_PID_FILE" ]]; then
        local new_pid
        new_pid="$(cat "$WORKER_PID_FILE")"
        echo "[supervisor $(date -u +%FT%TZ)] spawned TTS pid=$new_pid"
      else
        echo "[supervisor $(date -u +%FT%TZ)] spawn failed; no PID file written"
      fi
    fi

    sleep 5
  done
}

start_command() {
  prune_if_dead "$WORKER_PID_FILE"
  if [[ -f "$WORKER_PID_FILE" ]]; then
    local pid
    pid="$(cat "$WORKER_PID_FILE")"
    echo "[ok] TTS already running (pid=$pid)"
    return 0
  fi

  local sup_pid
  sup_pid="$(read_pid_file "$SUP_PID_FILE" || true)"
  if [[ -n "$sup_pid" ]] && is_pid_alive "$sup_pid"; then
    echo "[ok] supervisor already running (pid=$sup_pid); it will spawn TTS"
    rm -f "$WORKER_PID_FILE"
    return 0
  fi

  nohup bash -c 'cd "'"$TTS_DIR"'" && exec bash "'"$0"'" __supervisor' \
    -- "$0" >> "$SUP_LOG" 2>&1 < /dev/null &
  local sup_new_pid=$!
  echo "$sup_new_pid" > "$SUP_PID_FILE"
  disown "$sup_new_pid" 2>/dev/null || true

  # Wait up to 30 ticks for TTS to be both alive AND listening on its port.
  local tick=0
  while (( tick < 30 )); do
    prune_if_dead "$WORKER_PID_FILE"
    if [[ -f "$WORKER_PID_FILE" ]]; then
      local pid
      pid="$(cat "$WORKER_PID_FILE")"
      if is_pid_alive "$pid"; then
        if is_healthy; then
          echo "[ok] TTS started (pid=$pid, port=${VIENEU_PORT:-5020}); supervisor pid=$sup_new_pid"
          return 0
        fi
      fi
    fi
    sleep 1
    tick=$((tick + 1))
  done

  echo "[error] TTS did not become healthy within 30s; see $WORKER_LOG" >&2
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
    echo "[stop] TTS pid=$work_pid"
    kill -TERM "$work_pid" 2>/dev/null || true
    local waited=0
    while (( waited < 10 )) && is_pid_alive "$work_pid"; do
      sleep 1
      waited=$((waited + 1))
    done
    if is_pid_alive "$work_pid"; then
      echo "[stop] TTS did not exit gracefully; sending SIGKILL"
      kill -KILL "$work_pid" 2>/dev/null || true
    fi
    rm -f "$WORKER_PID_FILE"
    work_pruned=1
  fi

  if (( sup_pruned == 0 && work_pruned == 0 )); then
    echo "[ok] TTS already stopped"
  fi
}

status_command() {
  # Drop stale pid files first so the report reflects actual liveness.
  prune_if_dead "$WORKER_PID_FILE"
  prune_if_dead "$SUP_PID_FILE"

  local work_pid sup_pid
  work_pid="$(read_pid_file "$WORKER_PID_FILE" || true)"
  sup_pid="$(read_pid_file "$SUP_PID_FILE" || true)"

  local alive_token="down"
  if [[ -n "$work_pid" ]] && is_pid_alive "$work_pid"; then
    if is_healthy; then
      alive_token="up (pid=$work_pid, port=${VIENEU_PORT:-5020} ok)"
    else
      alive_token="alive-but-not-listening (pid=$work_pid)"
    fi
  fi
  local sup_token="none"
  if [[ -n "$sup_pid" ]] && is_pid_alive "$sup_pid"; then
    sup_token="up (pid=$sup_pid)"
  fi

  echo "tts=$alive_token supervisor=$sup_token log=$WORKER_LOG"
}

restart_command() {
  stop_command || true
  sleep 1
  start_command
}

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

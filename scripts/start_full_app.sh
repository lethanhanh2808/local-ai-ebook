#!/usr/bin/env bash
# Start the Local-AI ebook application stack from one command.
#
# Usage:
#   ./scripts/start_full_app.sh              # start services, run Next.js in foreground
#   ./scripts/start_full_app.sh --background # start services and Next.js in background
#   ./scripts/start_full_app.sh --status     # print local service status
#   ./scripts/start_full_app.sh --stop       # stop Next.js + worker started by this workspace
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/app/ebook-converter"
TTS_DIR="$ROOT_DIR/app/tts-service"
RUNTIME_DIR="$APP_DIR/data/full-runtime"
NEXT_PID_FILE="$RUNTIME_DIR/next.pid"
NEXT_LOG_FILE="$RUNTIME_DIR/next.log"

mkdir -p "$RUNTIME_DIR" "$APP_DIR/data/redis" "$APP_DIR/data/uploads" "$APP_DIR/data/outputs" "$APP_DIR/data/job-logs"

if [[ -f "$APP_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_DIR/.env.local"
  set +a
fi

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
APP_PORT="${APP_PORT:-3100}"
OMLX_HEALTH_URL="${OMLX_HEALTH_URL:-http://127.0.0.1:8080/health}"
UNIFIED_TTS_HEALTH_URL="${UNIFIED_TTS_HEALTH_URL:-http://127.0.0.1:5010/health}"

http_ok() {
  curl -fsS -m 2 "$1" >/dev/null 2>&1
}

port_pid() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

redis_ok() {
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG
  else
    [[ -n "$(port_pid "$REDIS_PORT")" ]]
  fi
}

start_redis() {
  if redis_ok; then
    echo "[ok] Redis is running on $REDIS_HOST:$REDIS_PORT"
    return
  fi
  if [[ "$REDIS_HOST" != "127.0.0.1" && "$REDIS_HOST" != "localhost" ]]; then
    echo "[warn] Redis is not local ($REDIS_HOST:$REDIS_PORT); start it manually."
    return
  fi
  if ! command -v redis-server >/dev/null 2>&1; then
    echo "[warn] redis-server not found. Install Redis or run docker-compose redis."
    return
  fi
  echo "[start] Redis on :$REDIS_PORT"
  redis-server --daemonize yes \
    --port "$REDIS_PORT" \
    --dir "$APP_DIR/data/redis" \
    --logfile "$APP_DIR/data/redis/redis.log"
}

start_omlx() {
  if http_ok "$OMLX_HEALTH_URL"; then
    echo "[ok] oMLX is healthy"
    return
  fi
  if [[ -x "$ROOT_DIR/scripts/restart_omlx.sh" ]]; then
    echo "[start] oMLX via scripts/restart_omlx.sh"
    "$ROOT_DIR/scripts/restart_omlx.sh" || echo "[warn] oMLX did not become healthy"
  else
    echo "[warn] oMLX is not healthy and restart_omlx.sh is missing"
  fi
}

start_tts() {
  if http_ok "$UNIFIED_TTS_HEALTH_URL"; then
    echo "[ok] Unified TTS is healthy"
    return
  fi
  if [[ -x "$TTS_DIR/start_all.sh" ]]; then
    echo "[start] TTS stack"
    bash "$TTS_DIR/start_all.sh" || echo "[warn] TTS stack did not fully start"
  else
    echo "[warn] TTS start script not found at $TTS_DIR/start_all.sh"
  fi
}

prepare_app() {
  cd "$APP_DIR"
  if [[ ! -d node_modules || ! -x node_modules/.bin/next ]]; then
    echo "[setup] npm install"
    npm install
  fi
  echo "[setup] Prisma client/schema"
  npx prisma generate >/dev/null
  npx prisma db push >/dev/null
}

start_worker() {
  echo "[start] ebook worker"
  bash "$APP_DIR/scripts/start-worker.sh" --start
}

start_next_background() {
  local pid
  pid="$(cat "$NEXT_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[ok] Next.js already running (pid=$pid)"
    return
  fi
  if [[ -n "$(port_pid "$APP_PORT")" ]]; then
    echo "[ok] Port $APP_PORT is already in use; assuming the app is running"
    return
  fi
  cd "$APP_DIR"
  echo "[start] Next.js in background on :$APP_PORT"
  nohup npm run dev > "$NEXT_LOG_FILE" 2>&1 < /dev/null &
  echo "$!" > "$NEXT_PID_FILE"
  echo "[log] $NEXT_LOG_FILE"
}

start_next_foreground() {
  if [[ -n "$(port_pid "$APP_PORT")" ]]; then
    echo "[ok] Port $APP_PORT is already in use; open http://localhost:$APP_PORT"
    return
  fi
  cd "$APP_DIR"
  echo "[start] Next.js on http://localhost:$APP_PORT"
  npm run dev
}

print_status() {
  echo "Local-AI application status"
  echo "  oMLX       : $(http_ok "$OMLX_HEALTH_URL" && echo ok || echo down)"
  echo "  Unified TTS: $(http_ok "$UNIFIED_TTS_HEALTH_URL" && echo ok || echo down)"
  echo "  Redis      : $(redis_ok && echo ok || echo down)"
  echo "  Next.js    : $([[ -n "$(port_pid "$APP_PORT")" ]] && echo "listening on :$APP_PORT" || echo down)"
  echo "  Worker     : $(bash "$APP_DIR/scripts/start-worker.sh" --status 2>/dev/null || echo unknown)"
}

stop_stack() {
  echo "[stop] worker"
  bash "$APP_DIR/scripts/start-worker.sh" --stop || true
  if [[ -f "$NEXT_PID_FILE" ]]; then
    local pid
    pid="$(cat "$NEXT_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[stop] Next.js pid=$pid"
      kill -TERM "$pid" 2>/dev/null || true
    fi
    rm -f "$NEXT_PID_FILE"
  fi
  if [[ -x "$TTS_DIR/stop_all.sh" ]]; then
    echo "[stop] TTS stack"
    bash "$TTS_DIR/stop_all.sh" || true
  fi
}

case "${1:-}" in
  --status)
    print_status
    ;;
  --stop)
    stop_stack
    ;;
  --background)
    start_redis
    start_omlx
    start_tts
    prepare_app
    start_worker
    start_next_background
    print_status
    echo "Open http://localhost:$APP_PORT"
    ;;
  "")
    start_redis
    start_omlx
    start_tts
    prepare_app
    start_worker
    start_next_foreground
    ;;
  *)
    echo "Unknown option: $1" >&2
    exit 2
    ;;
esac

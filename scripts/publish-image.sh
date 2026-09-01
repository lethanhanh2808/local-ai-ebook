#!/usr/bin/env bash
# Build the ebook-converter images on the Mac and push them to a LOCAL docker
# registry so the Proxmox VM can `docker pull` the exact same artifact.
#
# This implements the "build once, ship the image" model: the VM no longer
# runs `docker compose build` from source — it only pulls and runs.
#
# IMPORTANT — architecture: the Mac is Apple Silicon (arm64) but the VM is
# x86_64 (amd64). The build override (docker-compose.build.yml) pins
# `platform: linux/amd64` so the produced image actually runs on the VM.
# Building without that override yields an arm64 image that crashes the VM with
# "exec format error". Always build through this script (which uses the
# override) — never a bare `docker build`.
#
# What it does:
#   1. Ensures a local registry is running on :5005 (starts `registry:2` if not).
#   2. Builds `app` + `worker` via the build override (tags them with the
#      registry host + a `:latest` and a `:git-<sha>` immutable tag).
#   3. Pushes both tags.
#   4. Prints the exact pull/run command for the VM.
#
# Usage:
#   ./scripts/publish-image.sh                 # registry on localhost:5005
#   REGISTRY=172.16.99.61:5005 ./scripts/publish-image.sh   # VM-reachable host IP
#   REGISTRY=172.16.125.51:5005 ./scripts/publish-image.sh   # push to a registry ON the VM
#
# The registry host defaults to localhost:5005. (macOS reserves :5000 for the
# Control Center / AirPlay receiver, so we avoid it.) For the VM to pull, it
# must be reachable from 172.16.125.51 — use the Mac's LAN IP
# (172.16.99.61:5005) or a registry running on the VM itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$SCRIPT_DIR/app/ebook-converter"

# Registry the image is tagged/pushed to AND pulled from by the VM.
REGISTRY="${REGISTRY:-localhost:5005}"
APP_IMAGE="$REGISTRY/ebook-converter-app"
WORKER_IMAGE="$REGISTRY/ebook-converter-worker"

# Immutable tag = current git sha (short). Lets the VM pin a known-good build.
GIT_SHA="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ── 1. Ensure local registry is up ──────────────────────────────────────────
REG_PORT="${REGISTRY##*:}"
REG_HOST="${REGISTRY%%:*}"
REG_NAME="local-ebook-registry"

if ! docker ps --format '{{.Names}}' | grep -qx "$REG_NAME"; then
  yellow "[registry] starting $REG_NAME on :$REG_PORT …"
  # Remove any stale container on that port first.
  docker rm -f "$REG_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$REG_NAME" --restart=unless-stopped \
    -p "$REG_PORT:5000" \
    registry:2 >/dev/null
  # Wait for it to answer.
  for i in $(seq 1 20); do
    if curl -fsS -m 2 "http://$REG_HOST:$REG_PORT/v2/" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  curl -fsS -m 2 "http://$REG_HOST:$REG_PORT/v2/" >/dev/null 2>&1 \
    && green "[registry] up at http://$REGISTRY" \
    || red "[registry] did not come up — check 'docker logs $REG_NAME'"
else
  green "[registry] already running at http://$REGISTRY"
fi

# ── 2. Build ───────────────────────────────────────────────────────────────
yellow "[build] building app + worker (git $GIT_SHA) …"
( cd "$APP_DIR" && \
  docker compose -f docker-compose.yml -f docker-compose.build.yml build )

# ── 3. Tag + push (latest + immutable git sha) ─────────────────────────────
yellow "[push] tagging + pushing to $REGISTRY …"
SRC_APP="${REGISTRY}/ebook-converter-app:latest"       # what the build produced
SRC_WORKER="${REGISTRY}/ebook-converter-worker:latest"
docker tag "$SRC_APP"    "${APP_IMAGE}:latest"
docker tag "$SRC_APP"    "${APP_IMAGE}:git-${GIT_SHA}"
docker tag "$SRC_WORKER" "${WORKER_IMAGE}:latest"
docker tag "$SRC_WORKER" "${WORKER_IMAGE}:git-${GIT_SHA}"
docker push "${APP_IMAGE}:latest"
docker push "${APP_IMAGE}:git-${GIT_SHA}"
docker push "${WORKER_IMAGE}:latest"
docker push "${WORKER_IMAGE}:git-${GIT_SHA}"

# ── 4. Summary ──────────────────────────────────────────────────────────────
green "[done] images published:"
echo "  $APP_IMAGE:latest"
echo "  $APP_IMAGE:git-$GIT_SHA"
echo "  $WORKER_IMAGE:latest"
echo "  $WORKER_IMAGE:git-$GIT_SHA"
echo ""
yellow "On the VM, run:"
echo "  REGISTRY=$REGISTRY bash ~/ebook-converter/scripts/deploy-vm.sh code"
echo ""
echo "(deploy-vm.sh 'code' now pulls these images instead of building from source.)"

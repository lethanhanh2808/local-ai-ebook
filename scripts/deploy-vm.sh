#!/usr/bin/env bash
# Deploy the latest published image to the Proxmox VM (172.16.125.51) and
# restart the docker stack.
#
# Run this ON THE VM. From the Mac, build + push first:
#     ./scripts/publish-image.sh
# then:
#     ssh -i ~/.../mgmt-admin-ed25519 mgmt-admin@172.16.125.51 \
#       REGISTRY=172.16.99.61:5005 \
#       bash /home/mgmt-admin/ebook-converter/scripts/deploy-vm.sh <subcommand>
#
# Why a separate VM-side script: the docker-compose stack is bound to the VM's
# filesystem, but the VM does NOT build from source. The Mac builds the image
# once (for linux/amd64) and pushes it to a local registry; this script only
# PULLS that artifact and runs it. This guarantees the running image matches
# what was tested on the Mac and avoids the arm64(Mac) vs amd64(VM) mismatch.
#
# Subcommands:
#   verify   report how far behind origin/main the VM is and what would change
#   full     backup + fresh-clone + restore + pull images + restart (slow; rare)
#   code     pull published images + restart (default; ~30 s; no source build)
#   tts      restart the host VieNeu TTS service (for Python-only changes; ~10 s)
#   voices   re-run the voice enrollment encoder + restart host TTS
#   status   print container + service health
#
# Images are built on the Mac and pushed to a local registry (see
# scripts/publish-image.sh). This script only PULLS them — it never builds
# from source on the VM. Set REGISTRY to match what publish-image.sh used.
#
# All subcommands are idempotent.
#
# Why no `--push` flag: the agent's auto mode is blocked from `git push` to
# origin/main (data-exfiltration classifier). Push is always manual on the Mac.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/app/ebook-converter"
TTS_DIR="$ROOT_DIR/app/tts-service"

# ── Config (override via env if needed) ──
VM_HOST="${VM_HOST:-172.16.125.51}"
SSH_KEY="${SSH_KEY:-/Volumes/EXT-SSD/Users/anhl/local-ai-ebook/reference/sshkey/mgmt-admin-ed25519}"
SSH_TARGET="${SSH_USER:-mgmt-admin}@${VM_HOST}"

# Reference audio lives on the VM at the same path as on the Mac so the
# encoder script (which has Mac/VM path candidates in
# AUDIO_DIR_CANDIDATES) can find it. If you change this on one side, change
# both.
REFERENCE_AUDIO_DIR="${REFERENCE_AUDIO_DIR:-/home/mgmt-admin/reference/audio-voice-sample}"

# The tts-vieneu container reads voices_v3_turbo.json from the
# non-editable site-packages copy (.venv/lib/python3.11/site-packages/...).
# The encoder script patches every copy on disk; this env var tells it where
# the source tree lives.
VIENEU_DIR="$TTS_DIR/VieNeu-TTS"

# Compose project name (must match the `name:` line in docker-compose.yml).
COMPOSE_PROJECT="ebook-converter"

# ── Helpers ──
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

ssh_run() {
  # `-o IdentitiesOnly=yes` prevents the SSH agent from offering other keys
  # (which can trigger the VM to deny us based on `authorized_keys` ordering).
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes \
    "$SSH_TARGET" "$@"
}

require_clean_worktree() {
  local status
  status="$(ssh_run 'git status --porcelain')"
  if [[ -n "$status" ]]; then
    red "VM has uncommitted changes — refusing to deploy." >&2
    echo "$status" >&2
    echo "" >&2
    echo "Resolve on VM first (commit, stash, or reset), then re-run." >&2
    exit 1
  fi
}

check_origin() {
  ssh_run '
    if [ ! -d .git ]; then
      echo "(VM is a snapshot copy — skipping origin/main divergence check)"
      exit 0
    fi
    git fetch origin --quiet 2>&1 || { echo "fetch failed"; exit 0; }
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/main)
    BASE=$(git merge-base HEAD origin/main)
    if [[ "$LOCAL" == "$REMOTE" ]]; then
      echo "VM is up-to-date with origin/main ($LOCAL)"
    elif [[ "$LOCAL" == "$BASE" ]]; then
      AHEAD=$(git rev-list --left-right --count origin/main...HEAD | awk "{print \$1}")
      echo "VM is $AHEAD commit(s) BEHIND origin/main"
    else
      echo "VM has diverged from origin/main (rebase/merge required)"
      git log --oneline "$LOCAL..origin/main"
      git log --oneline "$REMOTE..HEAD"
      exit 0
    fi
  '
}

docker_compose() {
  ( cd "$APP_DIR" && docker compose -p "$COMPOSE_PROJECT" "$@" )
}

# ── Subcommands ──
cmd_verify() {
  echo "─── VM state ───"
  # The VM may be a git checkout OR a snapshot copy (no .git). Treat git as
  # best-effort so verify/status work in both layouts.
  ssh_run 'if [ -d .git ]; then pwd && git log --oneline -1 && git rev-parse --abbrev-ref HEAD; else echo "(VM is a snapshot copy — no git repo; skipping git checks)"; fi'
  echo ""
  echo "─── Divergence from origin/main ───"
  check_origin || true
  echo ""
  echo "─── Container health ───"
  docker_compose ps 2>/dev/null || echo "(docker compose ps failed)"
}

cmd_status() {
  cmd_verify
  echo ""
  echo "─── Service health ───"
  ssh_run '
    APP=http://127.0.0.1:13100
    for path in /api/health /api/tts/health /api/tts/voices; do
      code=$(curl -s -o /tmp/_resp -w "%{http_code}" -m 3 "$APP$path" || echo "ERR")
      echo "  $code  $path"
    done
  '
}

cmd_tts() {
  yellow "[tts] restarting host VieNeu TTS service (~10 s)"
  # VieNeu runs on the host (Mac) at :5020 (app/tts-service/start_all.sh),
  # not as a container. Restart it there.
  ssh_run 'bash ~/ebook-converter/app/tts-service/stop_all.sh; bash ~/ebook-converter/app/tts-service/start_all.sh'
  sleep 5
  ssh_run 'curl -s -m 5 http://host.docker.internal:5020/health || curl -s -m 5 http://127.0.0.1:5020/health || echo "(health check failed — check TTS logs)"'
  green "[tts] done"
}

cmd_voices() {
  yellow "[voices] running enroll_vieneu_presets.py + restarting host TTS"

  # The encoder has AUDIO_DIR_CANDIDATES covering Mac + VM paths. It will
  # find the WAVs automatically as long as REFERENCE_AUDIO_DIR exists and
  # contains the named stems.
  if ! ssh_run "[[ -d '$REFERENCE_AUDIO_DIR' ]]"; then
    red "Reference audio dir not found on VM: $REFERENCE_AUDIO_DIR"
    echo ""
    echo "Copy from Mac (one-time):"
    echo "  rsync -avz --delete \\"
    echo "    /Volumes/EXT-SSD/Users/anhl/local-ai-ebook/reference/audio-voice-sample/ \\"
    echo "    ${SSH_TARGET}:~/reference/audio-voice-sample/"
    exit 1
  fi

  ssh_run "cd '$VIENEU_DIR' && ./.venv/bin/python ../scripts/enroll_vieneu_presets.py"
  ssh_run 'bash ~/ebook-converter/app/tts-service/stop_all.sh; bash ~/ebook-converter/app/tts-service/start_all.sh'
  sleep 5
  green "[voices] done — verify with:"
  echo "  curl http://localhost:13100/api/tts/voices | jq '.voices | length'"
}

cmd_code() {
  yellow "[code] pull published images + restart (~30 s)"
  # The VM may be a git checkout OR a snapshot copy (no .git). Treat git as
  # best-effort so `code` works in both layouts.
  ssh_run 'if [ -d .git ]; then git pull --ff-only origin main; else echo "(VM is a snapshot copy — skipping git pull)"; fi'
  # Images are built on the Mac and pushed to the local registry
  # (scripts/publish-image.sh). We only pull + run here — no source build.
  # REGISTRY must be exported so the pull override's ${REGISTRY:-localhost:5005}
  # resolves to the Mac's LAN IP (172.16.99.61:5005), which the VM trusts as
  # an insecure registry.
  REGISTRY="${REGISTRY:-localhost:5005}" \
    docker_compose -f docker-compose.yml -f docker-compose.pull.yml pull app worker
  REGISTRY="${REGISTRY:-localhost:5005}" \
    docker_compose -f docker-compose.yml -f docker-compose.pull.yml up -d --no-deps app worker
  sleep 5
  cmd_status
  green "[code] done"
}

cmd_full() {
  yellow "[full] backup + fresh clone + restore + rebuild + restart"
  echo "        (this replaces ~/ebook-converter and ~/tts-service — large; rare)"
  require_clean_worktree

  TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP_ROOT="/home/mgmt-admin/.deploy-backups/$TIMESTAMP"
  ssh_run "mkdir -p '$BACKUP_ROOT'"

  # What we preserve across a fresh clone:
  #   - app/ebook-converter/.env.local          (VM-specific config)
  #   - app/ebook-converter/data/                (SQLite + uploads + outputs)
  #   - app/tts-service/VieNeu-TTS/              (gitignored, ~1.1 GB)
  #   - app/tts-service/logs/                    (operational logs)
  ssh_run "
    set -e
    cd '$ROOT_DIR'
    [[ -f app/ebook-converter/.env.local ]] && cp -a app/ebook-converter/.env.local '$BACKUP_ROOT/env.local'
    [[ -d app/ebook-converter/data       ]] && cp -a app/ebook-converter/data       '$BACKUP_ROOT/data'
    [[ -d app/tts-service/VieNeu-TTS     ]] && cp -a app/tts-service/VieNeu-TTS     '$BACKUP_ROOT/VieNeu-TTS'
    [[ -d app/tts-service/logs           ]] && cp -a app/tts-service/logs           '$BACKUP_ROOT/logs'
    echo '[full] backup complete: $BACKUP_ROOT'
  "

  # Wipe tracked files (keep gitignored dirs by moving them aside).
  ssh_run "
    set -e
    cd '$ROOT_DIR'
    mv app/ebook-converter app/ebook-converter.__stage
    mv app/tts-service     app/tts-service.__stage
    git checkout HEAD -- app/ebook-converter app/tts-service
    rm -rf app/ebook-converter.__stage app/tts-service.__stage
  "
  ssh_run 'git clean -fd'
  ssh_run 'git pull --ff-only origin main'

  ssh_run "
    set -e
    cd '$ROOT_DIR'
    [[ -d '$BACKUP_ROOT/env.local'   ]] && mkdir -p app/ebook-converter && cp -a '$BACKUP_ROOT/env.local'   app/ebook-converter/.env.local
    [[ -d '$BACKUP_ROOT/data'        ]] && cp -a '$BACKUP_ROOT/data'        app/ebook-converter/data
    [[ -d '$BACKUP_ROOT/VieNeu-TTS'  ]] && cp -a '$BACKUP_ROOT/VieNeu-TTS'  app/tts-service/VieNeu-TTS
    [[ -d '$BACKUP_ROOT/logs'        ]] && cp -a '$BACKUP_ROOT/logs'        app/tts-service/logs
    echo '[full] restore complete'
  "

  # ── Gotcha: data/ ownership ──
  # The app container runs as nextjs (uid 1001, gid 1001). mgmt-admin is uid
  # 1000. `cp -a` preserves ownership as mgmt-admin, which makes the SQLite
  # bind-mount read-only for the nextjs process (worker crashloops with
  # "attempt to write a readonly database"). Always re-chown after restore.
  yellow "[full] fixing data/ ownership to 1001:1001"
  ssh_run "sudo chown -R 1001:1001 '$APP_DIR/data/'" || {
    red "sudo chown failed. Re-run manually: ssh $SSH_TARGET 'sudo chown -R 1001:1001 ~/ebook-converter/app/ebook-converter/data/'"
    exit 1
  }

  docker_compose -f docker-compose.yml -f docker-compose.pull.yml pull app worker
  docker_compose -f docker-compose.yml -f docker-compose.pull.yml up -d --no-deps app worker

  echo ""
  cmd_status
  green "[full] done — backup is at $BACKUP_ROOT"
}

# ── Entry point ──
case "${1:-}" in
  verify)  cmd_verify ;;
  status)  cmd_status ;;
  tts)     cmd_tts ;;
  voices)  cmd_voices ;;
  code)    cmd_code ;;
  full)    cmd_full ;;
  "")
    echo "Usage: $0 {verify|status|code|tts|voices|full}" >&2
    echo "" >&2
    echo "Common workflow:" >&2
    echo "  Mac:  git push origin main" >&2
    echo "  Mac:  ssh $SSH_TARGET 'bash $ROOT_DIR/scripts/deploy-vm.sh code'" >&2
    exit 2
    ;;
  *)
    echo "Unknown subcommand: $1" >&2
    exit 2
    ;;
esac

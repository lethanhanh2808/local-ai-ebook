# AGENTS.md — Local AI Ebook Platform

Guidance for AI coding agents working in this repository. Read this before
making changes, especially anything touching deployment, Docker, or the TTS
service.

## What this repo is

A local-first ebook conversion + audiobook system:

- **`app/ebook-converter`** — Next.js 15 (App Router) + TypeScript web app.
  EPUB/HTML/TXT conversion, library/reader UI, Prisma + SQLite, BullMQ + Redis
  background worker, AI enhancement, and audiobook generation.
- **`app/tts-service`** — Python TTS + voice-attribution pipeline (VieNeu-TTS
  engine, `vieneu-v3-turbo`). Runs on the **host**, not in a container.
- **`scripts/`** — startup, verification, and the deploy/publish helpers.
- **`docs/`** — repo-level docs. `docs/dev-workflow.md` is the source of truth
  for operations/deployment. `docs/archive/` holds historical/expired notes.
- **`reference/`** — standards, sample books, and SSH keys (do NOT commit keys).

## Layout & key paths

| Path | Purpose |
|---|---|
| `app/ebook-converter/src` | app source (routes, components, lib, worker) |
| `app/ebook-converter/prisma` | schema + migrations (SQLite) |
| `app/ebook-converter/docker-compose.{yml,build.yml,pull.yml}` | compose stack |
| `app/tts-service/VieNeu-TTS` | TTS engine (gitignored, ~1.1 GB) |
| `scripts/publish-image.sh` | **Mac** — build + push images to local registry |
| `scripts/deploy-vm.sh` | **VM** — pull + run published images |

## CRITICAL deploy rules (easy to get wrong)

The deployment model is **build-once on the Mac, pull on the VM**. The VM
(`172.16.125.51`, user `mgmt-admin`) does **NOT** build from source.

1. **Mac is arm64, VM is amd64.** The published image MUST be `linux/amd64`.
   `docker-compose.build.yml` pins `platform: linux/amd64` for this reason.
   Never remove that line, and never build the published image with a bare
   `docker build` / `docker compose build` that bypasses the build override —
   an arm64 image crashes the VM with `exec format error`.
2. **To ship app/worker changes:** on the Mac run `./scripts/publish-image.sh`
   (builds amd64, tags `:latest` + `:git-<sha>`, pushes to the local registry
   on `:5005`). Then on the VM run
   `REGISTRY=172.16.99.61:5005 bash ~/ebook-converter/scripts/deploy-vm.sh code`.
3. **TTS-only changes** under `app/tts-service/` do NOT need an image rebuild —
   restart the host TTS instead (`deploy-vm.sh tts` or `voices`). The TTS
   engine runs on the host at `:5020` and is reached from containers via
   `host.docker.internal:5020`.
4. **Compose overrides:** base `docker-compose.yml` has NO `build:`/`image:` on
   `app`/`worker`. `docker-compose.build.yml` (Mac) adds `build:` + `image:` +
   `platform: linux/amd64` and drops the `../tts-service` mount.
   `docker-compose.pull.yml` (VM) supplies `image:` + `pull_policy: always` +
   re-adds the `../tts-service` mount. The pull override has **no `build:` key**
   (older Compose rejects `build: null`/`build: false`).
5. **VM is a snapshot, not a git repo.** `deploy-vm.sh` is git-tolerant; do not
   assume `git pull` works there. The Mac is the only place with `origin`.

## Git rules

- **Push is manual** — the agent must not `git push origin main` (auto-mode is
  blocked as data exfiltration). Always ask the user to push, or have them run
  it.
- Commit small, focused changes. Update `CHANGELOG.md` (Unreleased) for
  user-facing or operational changes.
- Do not commit SSH keys (`reference/sshkey/`) or large generated data.

## Local dev on the Mac

- App: `cd app/ebook-converter && npm install && npm run dev` (serves `:3100`).
- TTS: `cd app/tts-service/VieNeu-TTS && uv run python ../vieneu_server.py`
  (serves `:5020`).
- Verify before committing: `./scripts/verify_changes.sh` (lint/typecheck/build).

## Where to look before changing things

- Deployment / VM ops → `docs/dev-workflow.md` (read the "Gotchas" section).
- App features / API → `app/ebook-converter/README.md`.
- Audiobook pipeline → `app/ebook-converter/AI_AUDIOBOOK_README.md`.
- Historical context only → `docs/archive/`.

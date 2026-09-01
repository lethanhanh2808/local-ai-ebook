# Development workflow — Mac + Proxmox VM

The ebook app runs as a Docker Compose stack on a Proxmox VM (172.16.125.51).
The Mac (172.16.99.61) is the development workstation. This document covers how
to keep the VM up-to-date as you change code on the Mac.

> One sentence: **commit + push on the Mac, then run `deploy-vm.sh` on the VM**.
> The agent cannot push for you (auto-mode is blocked) — push is always manual.

## Topology

```
┌──────────────────┐     git push origin main     ┌──────────────────────────┐
│   Mac (work)     │ ───────────────────────────► │   GitHub (origin/main)   │
│  172.16.99.61    │                              └──────────────────────────┘
│  uid=501 anhl    │                                           │
└──────────────────┘                                           │ git pull
        │                                                      ▼
        │ ssh (mgmt-admin)                       ┌──────────────────────────┐
        └───────────────────────────────────────► │   Proxmox VM             │
                                                 │   172.16.125.51          │
                                                 │   uid=1000 mgmt-admin    │
                                                 │                          │
                                                 │   ~/ebook-converter/     │
                                                 │   ├─ app/ebook-converter │ ─ docker compose
                                                 │   └─ app/tts-service     │ ─ bind mount
                                                 │                          │
                                                 │   docker compose:        │
                                                 │   • app (Next.js)        │
                                                 │   • worker (audiobook)   │
                                                 │   • redis                │
                                                 │                         │
                                                 │   TTS (VieNeu) runs on  │
                                                 │   the HOST at :5020     │
                                                 │   (start_all.sh), not   │
                                                 │   as a container.       │
                                                 └──────────────────────────┘
```

## SSH access

The VM uses the `mgmt-admin` user, not `anhl`. The active SSH key is:

```
/Volumes/EXT-SSD/Users/anhl/local-ai-ebook/reference/sshkey/mgmt-admin-ed25519
```

Convenience alias (drop into `~/.zshrc`/`~/.ssh/config`):

```bash
# ~/.ssh/config
Host vm-mgmt
  HostName 172.16.125.51
  User mgmt-admin
  IdentityFile /Volumes/EXT-SSD/Users/anhl/local-ai-ebook/reference/sshkey/mgmt-admin-ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
```

```bash
ssh vm-mgmt    # shell
scp ./file vm-mgmt:~/   # one-off copy
```

## Standard loop

```bash
# On Mac
$EDITOR <file>            # edit
./scripts/verify_changes.sh   # optional: local gate (lint/typecheck/build)
git add -A && git commit -m "..."
git push origin main       # ALWAYS manual — auto-mode is blocked

# On VM
ssh vm-mgmt
vm$ bash ~/ebook-converter/scripts/deploy-vm.sh code
```

`deploy-vm.sh code` does: `git pull` → rebuild `app` + `worker` containers →
print health. ~1–2 min on a fresh rebuild, ~30 s if
nothing under `app/ebook-converter/` actually changed (Docker layer cache).
The VieNeu TTS engine runs on the host (Mac) at `:5020` via
`app/tts-service/start_all.sh` — it is not a container, so it is not part of
the compose rebuild.

## Subcommands

| Subcommand | When to use | What it does | Time |
|---|---|---|---|
| `verify` | "Am I behind?" | prints commits ahead/behind, no changes | < 5 s |
| `status` | "Is the VM healthy?" | verify + container status + service health | < 10 s |
| `code` | default — most iterations | pull + rebuild app/worker + restart | 30 s – 2 min |
| `tts` | Python-only change under `app/tts-service/` | restart the host VieNeu TTS service (start_all.sh) | 10 s |
| `voices` | added a new built-in voice | run `enroll_vieneu_presets.py` + restart host TTS | 30 s |
| `full` | `code` is broken / first deploy / data corruption | backup → wipe tracked → fresh clone → restore → rebuild → restart | 5–10 min |

For routine development, `code` covers everything. `tts` and `voices` are
shortcuts for changes that don't need a full image rebuild. `full` is the
nuclear option — only when something in `code` refuses to take.

## First-time bootstrap

When setting up a fresh VM (or after a `full` redeploy with no `data/`
backup), the VM needs:

```bash
# On Mac — copy reference audio once (large, rarely changes)
rsync -avz --delete \
  /Volumes/EXT-SSD/Users/anhl/local-ai-ebook/reference/audio-voice-sample/ \
  vm-mgmt:~/reference/audio-voice-sample/

# On VM
vm$ bash ~/ebook-converter/scripts/deploy-vm.sh full
vm$ bash ~/ebook-converter/scripts/deploy-vm.sh voices   # only if you have ref audio
```

## What lives where (and what survives a redeploy)

| Path | In git? | Survives `code` deploy? | Survives `full` deploy? |
|---|---|---|---|
| `app/ebook-converter/src/` | yes | no (overwritten by pull) | no |
| `app/ebook-converter/.env.local` | **no** (.gitignored) | yes | **yes — backed up + restored** |
| `app/ebook-converter/data/` | **no** (gitignored) | yes | **yes — backed up + restored, then chowned 1001:1001** |
| `app/tts-service/VieNeu-TTS/` | **no** (gitignored, ~1.1 GB) | yes | **yes — backed up + restored** |
| `app/tts-service/logs/` | **no** (gitignored) | yes | yes |
| `~/reference/audio-voice-sample/` | **no** (outside repo) | yes | yes (independent of repo) |

A `full` deploy preserves everything above via `cp -a` to
`~/.deploy-backups/<timestamp>/`. Roll back manually by copying back.

## Gotchas (read these before your first deploy)

### 1. `data/` ownership after restore

The app container runs as `nextjs` (uid 1001, gid 1001). `mgmt-admin` is uid
1000. When you copy `data/` to the VM, the files end up owned by 1000:1000 and
the SQLite bind-mount becomes read-only for the container → worker crashloops
with:

```
attempt to write a readonly database
```

`deploy-vm.sh full` runs `sudo chown -R 1001:1001 ~/ebook-converter/app/ebook-converter/data/`
after restore. If you ever restore `data/` manually, do the same.

### 2. `voices_v3_turbo.json` lives in 3 places

The host TTS service (started via `app/tts-service/start_all.sh`) reads from
its installed package:

```
$ cd app/tts-service/VieNeu-TTS && ./.venv/bin/python -c "import vieneu, os; print(os.path.dirname(vieneu.__file__))"
.../VieNeu-TTS/.venv/lib/python3.11/site-packages/vieneu
```

That copy is **not** the source-tree file at
`app/tts-service/VieNeu-TTS/src/vieneu/assets/voices_v3_turbo.json`. Editing
just the source tree silently fails — the running server keeps the old
catalog and `/api/tts/voices` returns the upstream 20 presets, not your new
ones.

`app/tts-service/scripts/enroll_vieneu_presets.py` finds every copy on disk
(via `find_all_voices_jsons()`) and patches all of them. Always use that
script — never edit the JSON by hand. After running it, restart the host TTS
(`stop_all.sh && start_all.sh`, or `deploy-vm.sh voices`).

### 3. Mac is editable install, VM is non-editable

On the Mac, `uv sync` runs with `editable = true` (the default), so
`vieneu` resolves from the source tree. On the VM, `uv sync` runs
non-editable, so it copies `vieneu/` into `.venv/lib/python3.11/site-packages/`.

This means a code change under `app/tts-service/VieNeu-TTS/src/vieneu/` is
picked up on Mac without any rebuild — but on the VM you must restart the host
TTS service for it to take effect. (`deploy-vm.sh code` does not touch TTS;
use `deploy-vm.sh tts` or `voices`.)

### 4. Reference audio paths

`enroll_vieneu_presets.py` looks for WAVs in three candidate dirs (in order):

1. `~/reference/audio-voice-sample/` (VM-side convention)
2. `~/Documents/local-ai-ebook/reference/audio-voice-sample/` (Mac alt)
3. `/Volumes/EXT-SSD/Users/anhl/local-ai-ebook/reference/audio-voice-sample/` (Mac primary)

The first existing one wins. The convention is to keep the same directory on
both sides — see `rsync` in "First-time bootstrap".

### 5. Prisma schema changes need migrations

`package.json` has `prisma generate` + `prisma db push` as part of the
Dockerfile, so a rebuilt `app` container picks up new schema. But for
existing databases, `db push` applies non-destructively — review the diff
before deploying schema changes. For destructive schema changes, write a
migration (`npx prisma migrate dev`) and commit it.

### 6. The "manual push" rule

The agent cannot `git push origin main` for you (the auto-mode classifier
treats it as data exfiltration). Push is always manual on the Mac. If
`deploy-vm.sh` reports "VM is N commits BEHIND origin/main" but you haven't
pushed yet, **push first**.

## Build-once / ship-the-image model

The VM does **not** build from source. You build the images once on the Mac,
push them to a **local Docker registry**, and the VM `docker pull`s the exact
same artifact. This keeps the VM's build environment out of the equation and
guarantees the running image matches what you tested locally.

### Flow

```
 Mac (dev)                              Local registry            Proxmox VM
 ┌──────────────────┐   push            ┌──────────────┐  pull    ┌────────────────┐
 │ publish-image.sh │ ───────────────►  │ :5005 (reg)  │ ───────► │ deploy-vm.sh   │
 │  build app+worker│   app:latest      │              │  app:latest│  code → up -d  │
 │  tag+push        │   app:git-<sha>   │              │  worker:…  │                │
 └──────────────────┘   worker:…        └──────────────┘           └────────────────┘
```

### On the Mac (build + publish)

```bash
# 1. Develop + test locally (npm run dev on :3100, or docker compose up -d).
# 2. Build + push to the local registry (auto-starts registry:2 on :5005
#    — macOS reserves :5000 for Control Center, so we use :5005).
./scripts/publish-image.sh
# → builds app+worker, tags :latest + :git-<sha>, pushes to localhost:5005,
#   prints the VM pull command.
```

The registry host is configurable: `REGISTRY=172.16.99.61:5005` (VM-reachable
Mac IP) or `REGISTRY=172.16.125.51:5005` (a registry running on the VM). The
default `localhost:5005` only works for local testing.

### On the VM (pull + run)

```bash
# deploy-vm.sh 'code' now PULLS the published images instead of building:
REGISTRY=172.16.99.61:5005 bash ~/ebook-converter/scripts/deploy-vm.sh code
```

The VM's Docker daemon must trust the registry as **insecure** (plain HTTP).
This is already configured in `/etc/docker/daemon.json`:

```json
{ "insecure-registries": ["172.16.99.61:5005", "localhost:5005"] }
```

### Compose override files

| File | Used on | Purpose |
|------|---------|---------|
| `docker-compose.yml` | both | base services (redis, app, worker) |
| `docker-compose.build.yml` | Mac | adds `image:` tags, **drops** the `../tts-service` mount (image must be self-contained) |
| `docker-compose.pull.yml` | VM | `build: null` + `pull_policy: always` + re-adds `../tts-service` mount |

`character_detector.py` lives in the sibling `app/tts-service` repo and is
**bind-mounted at runtime** (not baked into the image) — both the build
override (dropped) and pull override (re-added) handle this deliberately.

## Verifying a deploy

```bash
# Voice catalog (should match VIENEU_PROFILES in vieneu-voices.ts count)
curl -s http://localhost:13100/api/tts/voices | jq '.voices | length'

# Synth a short clip and check it returns 200 with valid audio
curl -X POST http://localhost:13100/api/tts \
  -H 'content-type: application/json' \
  -d '{"text":"Xin chào.","voice":"Ngọc Ngạn"}' \
  --output /tmp/test.wav
file /tmp/test.wav   # should report "RIFF WAVE audio"
```

For a fuller functional check, use the in-app "Read aloud" panel — it surfaces
any provider/catalog/voice mismatch with a clear error.

## When `deploy-vm.sh` isn't enough

- **Infra changes** (docker-compose.yml, Traefik, DNS): do them manually on the
  VM and commit the compose file afterwards so the next `deploy-vm.sh code`
  is consistent.
- **VM-level OS changes** (new apt packages, kernel update, docker upgrade):
  outside the scope of this workflow.
- **Switching branches**: don't. The VM tracks `origin/main`; feature
  branches should be tested locally on the Mac, merged to `main`, then
  deployed.

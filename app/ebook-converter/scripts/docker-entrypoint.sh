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
# 2026-07-24: Added `prisma migrate deploy` step. The bind-mounted
# /app/data/ebook-converter.db can outlive the container image — when a
# new image with new Prisma migrations ships, the running container's
# schema falls behind and queries fail with "The table `main.X` does not
# exist in the current database" surfaced as the cryptic
# "The string did not match the expected pattern" toast in the UI
# (Prisma's regex catch for unknown model references). `migrate deploy`
# walks prisma/migrations/ in order, applies any un-applied SQL, and
# records each in _prisma_migrations so subsequent boots are no-ops.
# This step is intentionally idempotent.

set -eu

echo "[entrypoint] Applying pending Prisma migrations…"
node ./node_modules/prisma/build/index.js migrate deploy --schema ./prisma/schema.prisma
echo "[entrypoint] Migrations up to date."

exec "$@"
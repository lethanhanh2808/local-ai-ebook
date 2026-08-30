# Database Operations

Operational guide for the SQLite database that backs `app/ebook-converter`.
Read this before changing the schema, troubleshooting corruption, or doing
any maintenance on `data/ebook-converter.db`.

## TL;DR — The Golden Rules

1. **Never run `prisma db push` directly.** Use `npm run db:migrate:create -- --name=<x>`.
   Direct `db push` was the cause of the 2026-07-12 corruption incident.
2. **Containers must be stopped before any schema-touching command.**
   `scripts/db-migrate.sh` enforces this; never bypass it.
3. **Always have a snapshot before any risky operation.** The migrate
   wrapper snapshots automatically. Manual maintenance: `npm run db:snapshot`.
4. **Trust the integrity check.** If `db-verify` reports corruption,
   don't try to "just fix it" — restore from the most recent good
   snapshot. See [Recovery procedure](#recovery-procedure).
5. **Migrations live in git** under `app/ebook-converter/prisma/migrations/`.
   Every schema change ships with a new timestamped directory.
6. **The DB is in WAL journal mode.** Readers don't block writers,
   and a crash mid-write leaves the WAL rather than a torn main file.
   Both `.db-wal` and `.db-shm` sidecar files are normal — they're
   runtime artifacts (gitignored).

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Docker containers (app, worker)                      │
│                                                       │
│  ENTRYPOINT docker-entrypoint.sh                     │
│     ├─ 1. PRAGMA integrity_check  ─► fail-fast if bad │
│     └─ 2. PRAGMA journal_mode = wal (idempotent)      │
│                                                       │
│  Prisma client  ─►  SQLite via better-sqlite3         │
└────────────┬─────────────────────────────────────────┘
             │ bind-mount ./data:/app/data
             ▼
┌──────────────────────────────────────────────────────┐
│ Host filesystem                                       │
│                                                       │
│  data/ebook-converter.db         ← main file         │
│  data/ebook-converter.db-wal     ← WAL sidecar       │
│  data/ebook-converter.db-shm     ← shared memory     │
│  data/backups/snapshot-*.db      ← rollback points    │
└──────────────────────────────────────────────────────┘
```

## Defence-in-depth controls

These are layered so that even if one fails, the others catch the problem.

### Control 1 — Migration wrapper stops containers first

`scripts/db-migrate.sh` checks `docker compose ps` for running `app`/`worker`
services and runs `docker compose stop app worker` before any DDL. This
prevents the 2026-07-12 class of bug — schema changes racing with the live
SQLite writer.

### Control 2 — Pre-migration snapshot

Before any DDL, the wrapper copies `data/ebook-converter.db` to
`data/backups/snapshot-<UTC>-pre-migrate.db`. If the migration fails or
corrupts the DB, restore with:

```bash
# stop containers, copy, restart
docker compose stop app worker
cp data/backups/snapshot-<UTC>-pre-migrate.db data/ebook-converter.db
docker compose up -d app worker
```

Snapshots are auto-pruned at 30 days.

### Control 3 — Post-migration integrity check

After DDL, the wrapper runs `scripts/db-verify.sh` which executes:

- `PRAGMA integrity_check` — full B-tree + schema validation
- `PRAGMA quick_check` — cheap critical-only sanity check
- `PRAGMA foreign_key_check` — orphan rows (catches partial-write debris)
- `PRAGMA journal_mode` — must report `wal`
- Row counts for every Prisma model

If any check fails, the wrapper auto-restores the pre-migration snapshot
and exits non-zero. Migration never silently leaves the DB broken.

### Control 4 — Container entrypoint integrity check

`scripts/docker-entrypoint.sh` (wired via `ENTRYPOINT` in `Dockerfile`)
runs `PRAGMA integrity_check` on every container start. If the DB is
corrupt, the container exits with a clear recovery message instead of
serving traffic against a broken file.

The entrypoint also enables WAL journal mode idempotently (sticky in the
DB header, so it's a no-op after the first run).

### Control 5 — Graceful shutdown

`docker-compose.yml` sets `stop_grace_period: 30s` + `stop_signal: SIGTERM`
on both `app` and `worker`. The default 10s `SIGKILL` would lose the
last in-flight SQLite write; 30s is generous for the Next.js server and
worker to flush.

### Control 6 — Gitignored runtime files

`.gitignore` excludes `*.db`, `*.db-wal`, `*.db-shm`, and `data/backups/`.
The schema lives in `prisma/schema.prisma`; migration history lives in
`prisma/migrations/`. The runtime DB files are never committed.

## Day-to-day operations

### Apply pending migrations

```bash
npm run db:migrate
```

This:
1. Stops `app` and `worker`.
2. Snapshots the DB.
3. Runs `prisma migrate deploy`.
4. Runs the integrity check.
5. Restarts containers.

If integrity check fails, the snapshot is restored automatically.

### Add a schema change

```bash
# 1. Edit prisma/schema.prisma
# 2. Generate + apply the migration:
npm run db:migrate:create -- --name=add_xyz_field
```

The wrapper:
1. Stops containers.
2. Snapshots.
3. Generates `prisma/migrations/<UTC>_<name>/migration.sql` via
   `prisma migrate diff --from-empty --to-schema-datamodel`.
4. Applies via `prisma migrate deploy` (or `migrate resolve --applied`
   on a fresh/empty `_prisma_migrations` table).
5. Integrity-checks.
6. Restarts containers.

Commit `prisma/migrations/<UTC>_<name>/migration.sql` with your schema
change. Review the generated SQL before committing — Prisma's diff is
usually right but column renames look like drop+add.

### Manual snapshot before risky work

```bash
npm run db:snapshot -- --label=before-experiment
# → data/backups/snapshot-20260712T120000Z-before-experiment.db
```

Snapshots without `--label` are auto-named with the UTC timestamp.

### Verify current DB health

```bash
npm run db:verify
```

Should print all `OK` lines. If anything fails, jump to [Recovery procedure](#recovery-procedure).

### Open Prisma Studio

```bash
# First, stop the containers so Studio has exclusive access:
docker compose stop app worker
npm run db:studio
# Remember to restart:
docker compose up -d app worker
```

## Recovery procedure

If the DB is corrupt despite all controls, do this:

### Step 1 — Confirm corruption

```bash
npm run db:verify
```

If `integrity_check` returns anything other than `ok`, the DB is corrupt.

### Step 2 — Find the most recent good snapshot

```bash
ls -lt data/backups/ | head -20
```

Pick the most recent snapshot that you know is good. If you don't have one,
or the snapshots are too old, jump to [Wipe and rebuild](#wipe-and-rebuild).

### Step 3 — Restore from snapshot

```bash
docker compose stop app worker
cp data/backups/<best-snapshot>.db data/ebook-converter.db
# also copy any -wal/-shm sidecars if they exist
docker compose up -d app worker
```

Verify:
```bash
npm run db:verify
curl http://localhost:13100/api/tts/health
```

### Step 4 — If the snapshot also fails integrity check

Try SQLite's built-in recovery (last resort — loses some data):

```bash
sqlite3 data/ebook-converter.db ".recover" > recovered.sql
# Inspect recovered.sql — it should have CREATE TABLE + INSERT statements.
sqlite3 recovered.db < recovered.sql
# Verify recovered.db, then swap it in:
docker compose stop app worker
cp recovered.db data/ebook-converter.db
docker compose up -d app worker
```

`sqlite3 .recover` does its best to salvage rows from the corrupt file but
loses anything in pages that were mid-write when the file was corrupted.

### Wipe and rebuild

If recovery isn't possible:

```bash
docker compose stop app worker
rm -f data/ebook-converter.db data/ebook-converter.db-wal data/ebook-converter.db-shm
npm run db:migrate:create -- --name=init  # regenerates the schema + marks applied
docker compose up -d app worker
```

This wipes all books, characters, settings, attribution history. Only do this
if you have no good snapshots AND `.recover` doesn't help.

## Why not Postgres?

Sticking with SQLite (decided 2026-07-12 after the corruption post-mortem):

- **One file = trivial backup.** Copy and you're done. Postgres needs
  pg_dump or physical backup tooling.
- **Zero ops.** No separate process to manage, no port conflicts, no
  user/role to provision.
- **Local-first.** The whole app + DB lives in the docker-compose stack;
  moving to Postgres would add a fourth service.
- **Adequate write volume.** Our writes are book metadata + settings;
  SQLite easily handles thousands of writes/sec.
- **WAL mode gives us concurrent reads.** Not concurrent writes, but
  the app is read-heavy (one writer per request, mostly idempotent
  upserts), so this is fine.

The 2026-07-12 incident was NOT a SQLite limitation. It was caused by
running `prisma db push` against a live DB — a class of bug that any
DB engine would have failed on. The fix is the discipline documented here,
not a migration to Postgres.

## Files reference

| Path | Purpose |
|------|---------|
| `app/ebook-converter/prisma/schema.prisma` | Source of truth for schema |
| `app/ebook-converter/prisma/migrations/<UTC>_<name>/migration.sql` | Per-change migration |
| `app/ebook-converter/scripts/db-snapshot.sh` | Snapshot the DB |
| `app/ebook-converter/scripts/db-verify.sh` | Integrity check |
| `app/ebook-converter/scripts/db-migrate.sh` | The wrapper. Stop/snapshot/migrate/verify/restart. |
| `app/ebook-converter/scripts/docker-entrypoint.sh` | Per-container startup integrity check + WAL enable |
| `app/ebook-converter/data/ebook-converter.db` | The live DB |
| `app/ebook-converter/data/backups/` | Auto-rotating snapshots (30 days) |

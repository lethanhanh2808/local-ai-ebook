# Ebook Converter

The main Next.js application for local ebook conversion, library management, reading, and audiobook generation.

## Stack

- Next.js 15 + App Router + TypeScript
- Prisma + SQLite
- BullMQ + Redis
- Local AI through oMLX
- VieNeu TTS as the active TTS backend

## Features

- EPUB, HTML, and TXT conversion
- Repair and normalization for messy source files
- Chapter extraction and EPUB packaging
- Reader with library, shelves, metadata, and editor workflows
- Character and voice management for audiobook generation
- AI enhancement, watermark cleanup, and image handling

## Quick start

From the repo root:

```bash
./scripts/start_full_app.sh
```

Or run directly in the app:

```bash
cd app/ebook-converter
npm install
cp .env.example .env.local
npm run dev
```

## Useful commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e:local:smoke
```

## Database / deployment note

If you deploy a fresh build to an existing Docker VM or a pre-existing SQLite database, make sure the Prisma schema is applied before starting the app. Two migrations were added by the auth refactor and the insecure-TLS feature:

| Migration | What it does | Why it matters |
|---|---|---|
| `20260829000000_create_user_and_user_settings` | `CREATE TABLE IF NOT EXISTS` for `User`, `UserSettings`, `AuditLog` | Backfills the auth tables the refactor added to `schema.prisma` without a migration. `IF NOT EXISTS` makes it a no-op on DBs that already have the tables. |
| `20260830000000_add_ai_allow_insecure_tls` | `ALTER TABLE Settings` / `UserSettings ADD COLUMN aiAllowInsecureTls` | Adds the per-gateway TLS-override flag. |

If you see:

```text
PrismaClientKnownRequestError: Invalid `prisma.settings.upsert()` invocation:
The column `main.Settings.aiAllowInsecureTls` does not exist in the current database.
```

then the database is stale and needs the migrations applied.

The container entrypoint runs `prisma migrate deploy` on every start, so a normal `docker compose up -d` is enough **as long as the migration files are visible to the container**. The compose file bind-mounts `./prisma/migrations` into the container, so simply pulling the latest commits and restarting brings the DB back in sync:

```bash
cd /home/mgmt-admin/ebook-converter
git pull
docker compose up -d app worker
docker compose logs app | grep -E "migrat|All migrations"   # confirm
```

If the bind-mount is missing in an older compose file, the recovery on the VM is:

```bash
cd /home/mgmt-admin/ebook-converter
docker compose down app worker
npx prisma migrate deploy --schema ./prisma/schema.prisma
docker compose up -d app worker
```

This is required even when the app code is already updated, because the existing SQLite file on disk may not yet have the new column.

## App structure

```text
app/ebook-converter/
├── src/app              # routes and UI pages
├── src/components       # UI components and panels
├── src/lib              # pipeline, AI, DB, queue, TTS helpers
├── src/worker           # background job workers
├── prisma               # schema and migrations
├── public/assets/fonts  # embedded ebook fonts
├── scripts              # setup and verification helpers
├── e2e                  # Playwright tests and fixtures
├── samples              # deterministic fixture EPUBs
└── README.md            # this file
```

## Key workflows

- Upload and convert books
- Review the library and book metadata
- Read and edit chapters in the built-in reader/editor
- Detect characters and assign voices
- Generate audiobooks from chapter text and voice settings

## Related docs

- [AI_AUDIOBOOK_README.md](./AI_AUDIOBOOK_README.md) — audiobook pipeline summary
- [e2e/README.md](./e2e/README.md) — E2E suite overview
- [../../docs/README.md](../../docs/README.md) — repo-level structure and archive rules

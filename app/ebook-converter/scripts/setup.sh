#!/usr/bin/env bash
# scripts/setup.sh – first-time setup
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Installing dependencies…"
npm install

echo "==> Copying .env.example → .env.local (if not present)…"
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "    Edit .env.local with your OMLX_API_KEY and other settings."
fi

echo "==> Generating Prisma client…"
npx prisma generate

echo "==> Pushing DB schema…"
npx prisma db push

echo "==> Creating data directories…"
mkdir -p data/uploads data/outputs

echo ""
echo "✓ Setup complete!"
echo "  1. Start Redis:   redis-server"
echo "  2. Start worker:  ./scripts/start-worker.sh --start"
echo "  3. Start Next.js: npm run dev"
echo "  Open: http://localhost:3100"

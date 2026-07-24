# ── Stage 1: deps ─────────────────────────────────────────────────────────────
# Use Debian Bookworm-slim (libssl 3 by default).
# Why not Alpine: Prisma 5.22's runtime on Linux hard-codes the engine filename
# libquery_engine-linux-arm64-openssl-1.1.x.so.node (and the musl variant on
# Alpine). Alpine 3.20+ and Debian Bookworm both dropped libssl.so.1.1, so the
# dlopen always fails. We satisfy it in the runner by sideloading the Bullseye
# libssl1.1 deb.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ── Stage 2: build ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Generate Prisma client for the targets pinned in schema.prisma
# (native + debian-openssl-3.0.x — backup openssl-3 engine, kept around but
# not used by the runtime on glibc).
RUN npx prisma generate
# Build Next.js standalone app
RUN npm run build
# Bundle the BullMQ worker using esbuild JS API (avoids shell wrapper compat issues)
RUN node -e " \
  const e = require('esbuild'); \
  e.build({ \
    entryPoints: ['src/worker/index.ts'], \
    bundle: true, \
    platform: 'node', \
    target: 'node20', \
    outfile: 'dist/worker.js', \
    external: ['.prisma', 'bufferutil', 'utf-8-validate'], \
  }).then(r => { if (r.errors.length) { process.stderr.write(JSON.stringify(r.errors)); process.exit(1); } else process.stdout.write('Worker bundled OK\n'); }).catch(e => { process.stderr.write(e.message); process.exit(1); })" \
  || (echo 'esbuild API failed, trying CLI...' && npx --yes esbuild src/worker/index.ts --bundle --platform=node --target=node20 --outfile=dist/worker.js --external:.prisma --external:bufferutil --external:utf-8-validate)

# ── Stage 3: runner ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Sideload libssl1.1 from Debian Bullseye security pool.
# Prisma 5.x dlopens libquery_engine-linux-<arch>-openssl-1.1.x.so.node on
# glibc Linux; that engine references libssl.so.1.1 which Bookworm no longer
# ships. Pull the same library Bullseye used (libc6 is forward-compatible with
# Bookworm), install it, then clean up the apt cache and the .deb.
ARG TARGETARCH
RUN set -eux; \
  case "$TARGETARCH" in \
    arm64|aarch64) DEB="libssl1.1_1.1.1w-0+deb11u8_arm64.deb" ;; \
    amd64|x86_64)  DEB="libssl1.1_1.1.1w-0+deb11u8_amd64.deb" ;; \
    *) echo "Unsupported arch: $TARGETARCH" && exit 1 ;; \
  esac; \
  apt-get update; \
  apt-get install -y --no-install-recommends wget ca-certificates; \
  wget -q -O /tmp/libssl1.1.deb \
    "http://security.debian.org/debian-security/pool/updates/main/o/openssl/${DEB}"; \
  dpkg -i /tmp/libssl1.1.deb; \
  rm -f /tmp/libssl1.1.deb; \
  ldconfig; \
  apt-get purge -y --auto-remove wget; \
  rm -rf /var/lib/apt/lists/*; \
  ldconfig -p | grep -E "libssl\\.so\\.1\\.1|libcrypto\\.so\\.1\\.1" | head -4

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --create-home --shell /bin/bash nextjs

# Next.js standalone app
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma schema + native engine (required by @prisma/client at runtime)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Bundled worker (self-contained except for .prisma native binary above)
COPY --from=builder --chown=nextjs:nodejs /app/dist/worker.js ./worker.js

RUN mkdir -p data/uploads data/outputs && chown -R nextjs:nodejs data

# Ship a fontconfig config so sharp/libvips can render SVG text with full
# Vietnamese + Latin coverage. The static libvips inside @img/sharp-libvips-*
# has fontconfig built in but ships with no default config; without this,
# diacritic-bearing characters render as tofu boxes.
COPY fonts.conf /app/fonts.conf
ENV FONTCONFIG_FILE=/app/fonts.conf
ENV FONTCONFIG_PATH=/app

# Python + httpx for AI Character Detection. `character_detector.py`
# (mounted at runtime into /app/tts-service from the sibling
# ../tts-service directory on the host) runs in-process here via
# `child_process.spawn('python3', …)`. We do NOT install vi_g2p — the
# detector treats it as an optional dep and falls back to a trivial
# lowercase-comparison matcher when missing, which is fine for the
# initial detection call (suggestions, not bible persistence).
#
# sqlite3 is also installed here so the entrypoint integrity check
# (docker-entrypoint.sh) can run PRAGMA integrity_check at boot.
# Without this, a corrupt DB would only be discovered when Prisma
# throws — by which point traffic has already hit it.
#
# ffmpeg is required by:
#   1. src/worker/audiobook.ts:convertToMp3 — per-chapter WAV → MP3 for the
#      audiobook worker. Without ffmpeg in-container, every chapter silently
#      stays as WAV (the worker logs "ffmpeg not available (spawn ffmpeg
#      ENOENT); keeping WAV"). The host has ffmpeg; the container doesn't.
#   2. src/lib/tools/m4b.ts:exportM4B — concatenates chapter audio + embeds
#      chapter markers + cover art into the .m4b. Phase 4.5. The route
#      surfaces `M4BExportError{code:'ENOENT'}` → 503 install hint when this
#      binary is missing; user shouldn't hit that path in production.
#   3. scripts/ffmpeg_* (not present, future-proofing).
#
# All three require the same binary so install once in the runner stage.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends python3 python3-pip sqlite3 ffmpeg; \
  pip3 install --no-cache-dir --break-system-packages httpx; \
  apt-get purge -y --auto-remove pip; \
  rm -rf /var/lib/apt/lists/*; \
  python3 -c "import httpx; print('httpx', httpx.__version__)"; \
  sqlite3 --version; \
  ffmpeg -version | head -1; \
  ffprobe -version | head -1

# Container entrypoint runs SQLite integrity check + enables WAL journal
# mode before either server.js or worker.js starts. See
# scripts/docker-entrypoint.sh for the full logic.
COPY --chown=nextjs:nodejs scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER nextjs
EXPOSE 3100
ENV PORT=3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]

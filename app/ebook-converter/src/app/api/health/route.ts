// src/app/api/health/route.ts
//
// Liveness/readiness probe (Production Hardening 2026-07-06 — quick win #5).
//
// The previous container healthcheck called `/api/tts/health`, which
// probed external VieNeu-TTS. That conflated "is the Next.js process
// alive?" with "is the external TTS service reachable?" — if the host's
// VieNeu restarted, Docker would kill a perfectly-healthy ebook-converter
// container. Decouple them: /api/health reports only on the Next.js
// process + database, never on external dependencies.
//
// Exempt from /api/* auth in src/middleware.ts so orchestrators don't
// need a token to probe.
//
// Returns:
//   { status: 'ok', checks: { db: 'ok', uptimeSec: N, timestamp: ISO } }
// on success (HTTP 200), or:
//   { status: 'degraded', checks: { db: 'fail', ... } }
// on DB failure (HTTP 503). Process always 200s if it can answer.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const START_TS = Date.now();

export async function GET() {
  const uptimeSec = Math.round((Date.now() - START_TS) / 1000);
  const checkedAt = new Date().toISOString();

  let db: 'ok' | 'fail' = 'ok';
  let dbError: string | null = null;
  try {
    // $queryRaw`SELECT 1` would be ideal but we use a no-op pragma to
    // also verify the connection is functional (not just a cached handle).
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch (e) {
    db = 'fail';
    dbError = e instanceof Error ? e.message : String(e);
  }

  const body = {
    status: db === 'ok' ? 'ok' : 'degraded',
    checkedAt,
    uptimeSec,
    checks: {
      db,
      dbError,
      process: 'ok',
    },
  };
  return NextResponse.json(body, { status: db === 'ok' ? 200 : 503 });
}

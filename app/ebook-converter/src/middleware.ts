// src/middleware.ts
//
// Next.js root middleware — runs at the edge before every request.
//
// Authentication model (Production Hardening 2026-07-06):
//
//   • If the env var `INTERNAL_API_TOKEN` is set (and non-empty), every
//     `/api/*` request must carry a matching `X-Internal-Token` header.
//     The comparison is constant-time (timingSafeEqual) to defeat timing
//     oracles. Missing/empty env var means the app is in LOCAL-ONLY mode
//     and middleware is a no-op — matching the project's existing
//     single-user-local semantics.
//
//   • `/api/health` is intentionally public so Docker / Kubernetes
//     liveness probes don't require a token. The route only reports
//     "process up + DB queryable", no secrets, so exposing it is safe.
//
//   • Everything under `/api/*` is gated. Static / page routes (`/`,
//     `/_next/*`, etc.) are untouched — auth is at the API surface.
//
// Audited against the Production Hardening audit report (issues
// C1 — "no authentication on any of 47 API routes" — and C2/C7 which
// share the same root cause).

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const TOKEN_HEADER = 'x-internal-token';

// Routes that must remain reachable without a token. Keep this list
// short and explicit; every entry needs a security justification.
const PUBLIC_PATHS = new Set<string>([
  '/api/health', // liveness probe for orchestrators
]);

function isPathPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Next.js may include trailing slashes from rewrites; normalise.
  if (pathname.endsWith('/') && PUBLIC_PATHS.has(pathname.slice(0, -1))) return true;
  return false;
}

function safeEqual(a: string, b: string): boolean {
  // crypto.timingSafeEqual requires equal-length buffers.
  // Pad both sides to a fixed max length so a partial-token guess
  // also takes ~the same time as a full-token guess.
  const MAX = 512;
  const bufA = Buffer.alloc(MAX);
  const bufB = Buffer.alloc(MAX);
  Buffer.from(a).copy(bufA);
  Buffer.from(b).copy(bufB);
  // Same-length compare, but also verify lengths match up-front (the
  // timing-safe compare itself would early-out on length mismatch but
  // we still leak length, which is fine since token length is public).
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Return a 401 with a machine-readable error. The `WWW-Authenticate`
 *  header hints to clients that this route requires bearer-like auth. */
function unauthorized(reason: string): NextResponse {
  return new NextResponse(
    JSON.stringify({
      error: 'Unauthorized',
      reason,
      hint: 'Set the X-Internal-Token header to the value of INTERNAL_API_TOKEN.',
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="ebook-converter", error="invalid_token"`,
        // Discourage caching of the auth challenge itself.
        'Cache-Control': 'no-store',
      },
    },
  );
}

export function middleware(req: NextRequest): NextResponse {
  const expected = process.env.INTERNAL_API_TOKEN?.trim();

  // No token configured → service runs in open / local-only mode.
  // (This preserves the project's existing single-user-local usage where
  // the operator trusts every client on the network.)
  if (!expected) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  // Only gate /api/* — page routes have their own auth model (or none).
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Allow explicitly public paths (currently only /api/health).
  if (isPathPublic(pathname)) {
    return NextResponse.next();
  }

  const provided = req.headers.get(TOKEN_HEADER);
  if (!provided) {
    return unauthorized('Missing X-Internal-Token header');
  }

  if (!safeEqual(provided, expected)) {
    // Log the failure (server-side only — nothing user-identifying here).
    // Use console.warn so it surfaces in Docker logs.
    console.warn(
      `[auth] Rejected ${req.method} ${pathname} from ${req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'}: invalid X-Internal-Token`,
    );
    return unauthorized('Invalid X-Internal-Token');
  }

  return NextResponse.next();
}

// Only run the middleware for /api/* — Next.js otherwise fires it for
// every request including images, fonts, and pages, which would add
// latency to static-asset loads.
export const config = {
  matcher: ['/api/:path*'],
};

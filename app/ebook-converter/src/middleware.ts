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

async function safeEqual(a: string, b: string): Promise<boolean> {
  // Middleware runs in the Edge runtime, where Node's `crypto`/`Buffer`
  // modules are unavailable. Compare fixed-length SHA-256 digests with a
  // full byte sweep to retain constant-work token validation.
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let difference = a.length ^ b.length;
  for (let i = 0; i < bytesA.length; i++) difference |= bytesA[i] ^ bytesB[i];
  return difference === 0;
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

export async function middleware(req: NextRequest): Promise<NextResponse> {
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

  if (!(await safeEqual(provided, expected))) {
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

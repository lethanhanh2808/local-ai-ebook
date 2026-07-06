// src/lib/utils/rate-limit.ts
//
// Simple in-process token-bucket rate limiter (Production Hardening 2026-07-06).
//
// Why in-process and not Redis?
//   • The endpoints this protects (file upload, expensive mutations) sit
//     behind a single Next.js process in production. Multi-process
//     coordination would require a shared store and is overkill for the
//     audit-driven threat model (single-process is what the operator
//     runs).
//   • If the operator moves to a multi-process / multi-pod deployment,
//     swap this implementation for one backed by Redis (the public
//     shape — `consume(key)` — stays the same).
//
// Memory bound: the `buckets` Map is pruned lazily inside `consume()`.
// Worst-case size is `(unique_keys) * (some bytes per entry)` — bounded
// by incoming request cardinality. In practice well under 1k entries for
// a single-user local app.

export interface RateLimitOptions {
  /** Maximum tokens (== requests) per window. */
  capacity: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

interface Bucket {
  /** Tokens currently available. */
  tokens: number;
  /** Timestamp of the last refill (ms). */
  lastRefillMs: number;
  /** Last time this bucket was touched (ms) — used for TTL pruning. */
  lastSeenMs: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000; // hard cap — extra entries fall through

/**
 * Try to consume a single token for `key`. Returns `allowed=true` on
 * success and `allowed=false` when the caller should be rejected with
 * 429 (along with `retryAfterMs` so clients can back off).
 *
 * Implementation: classic token-bucket — refill proportionally to
 * elapsed time, capped at `capacity`. Avoids the "fixed window"
 * problem where a burst at the window boundary doubles the allowed
 * rate.
 */
export function consume(
  key: string,
  opts: RateLimitOptions,
): { allowed: true } | { allowed: false; retryAfterMs: number; limit: number; remaining: number } {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      // Defensive — refuse new keys when the table grows past the cap.
      // In practice, this only matters under attack, in which case
      // blocking all new keys is preferable to leaking memory.
      return { allowed: false, retryAfterMs: opts.windowMs, limit: opts.capacity, remaining: 0 };
    }
    bucket = { tokens: opts.capacity, lastRefillMs: now, lastSeenMs: now };
    buckets.set(key, bucket);
  }

  // Refill: add (elapsed/windowMs) * capacity tokens, capped at capacity.
  const elapsed = now - bucket.lastRefillMs;
  if (elapsed > 0) {
    const refill = (elapsed / opts.windowMs) * opts.capacity;
    bucket.tokens = Math.min(opts.capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    bucket.lastSeenMs = now;
    return { allowed: true };
  }

  // Reject. Compute when the bucket will have ≥ 1 token.
  const need = 1 - bucket.tokens;
  const retryAfterMs = Math.max(50, Math.ceil((need / opts.capacity) * opts.windowMs));
  bucket.lastSeenMs = now;
  return { allowed: false, retryAfterMs, limit: opts.capacity, remaining: 0 };
}

/** Periodically prune dead buckets (older than 2× the longest window we
 *  expect to support). Runs unref'd so it never blocks process exit. */
function pruneBuckets(): void {
  const cutoff = Date.now() - 10 * 60 * 1000; // 10 min idle eviction
  for (const [key, b] of buckets) {
    if (b.lastSeenMs < cutoff) buckets.delete(key);
  }
}
const pruneTimer = setInterval(pruneBuckets, 60_000);
// Unref so the timer doesn't keep the event loop alive.
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

/** Best-effort extraction of the originating client IP for rate-limit
 *  keying. Trusts XFF only if `TRUST_PROXY` is set, otherwise uses
 *  x-real-ip / falls back to "unknown". The result is intentionally
 *  coarse-grained; we never have *certain* knowledge of the caller's IP
 *  in a Node-only stack without a trusted ingress. */
export function clientIp(req: { headers: Headers }): string {
  const trust = process.env.TRUST_PROXY === '1';
  if (trust) {
    const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (xff) return xff;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Build the standard rate-limit response with `Retry-After` header. */
export function rateLimitResponse(opts: {
  retryAfterMs: number;
  limit: number;
  remaining: number;
}): Response {
  return new Response(
    JSON.stringify({ error: 'Too many requests', retryAfterMs: opts.retryAfterMs }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(opts.retryAfterMs / 1000)),
        'X-RateLimit-Limit': String(opts.limit),
        'X-RateLimit-Remaining': String(opts.remaining),
        'Cache-Control': 'no-store',
      },
    },
  );
}

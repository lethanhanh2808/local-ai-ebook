import crypto from 'crypto';
import type { NextRequest } from 'next/server';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.replace(/^\[|\]$/g, '').toLowerCase());
}

function safeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Authorize the host-process worker controls.
 *
 * An internal token is authoritative when configured. In zero-config local
 * mode, require a same-origin browser request whose URL and Origin are both
 * loopback. We deliberately do not treat a missing forwarding header as
 * 127.0.0.1—the previous fallback let any network caller appear local.
 */
export function workerControlAuthorized(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_API_TOKEN?.trim();
  if (expected) {
    const provided = req.headers.get('x-internal-token');
    return !!provided && safeTokenEqual(provided, expected);
  }

  if (!isLocalHost(req.nextUrl.hostname)) return false;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (!isLocalHost(parsed.hostname) || parsed.origin !== req.nextUrl.origin) return false;
  } catch {
    return false;
  }

  // When a trusted reverse proxy is explicitly configured, also require its
  // claimed client address to be loopback. Without TRUST_PROXY, ignore XFF.
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (!forwarded || !isLocalHost(forwarded.replace(/^::ffff:/, ''))) return false;
  }
  return true;
}

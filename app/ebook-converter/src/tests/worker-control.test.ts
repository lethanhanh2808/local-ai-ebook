import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { workerControlAuthorized } from '@/lib/utils/worker-control';

const originalToken = process.env.INTERNAL_API_TOKEN;
const originalTrustProxy = process.env.TRUST_PROXY;

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = originalTrustProxy;
});

function request(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: 'POST', headers });
}

describe('workerControlAuthorized', () => {
  it('requires and validates the internal token when configured', () => {
    process.env.INTERNAL_API_TOKEN = 'correct-secret';
    expect(workerControlAuthorized(request('http://example.test/api/worker/start', {
      'x-internal-token': 'correct-secret',
    }))).toBe(true);
    expect(workerControlAuthorized(request('http://localhost/api/worker/start', {
      origin: 'http://localhost',
      'x-internal-token': 'wrong-secret',
    }))).toBe(false);
  });

  it('allows an exact loopback same-origin request in local mode', () => {
    delete process.env.INTERNAL_API_TOKEN;
    expect(workerControlAuthorized(request('http://localhost:3100/api/worker/start', {
      origin: 'http://localhost:3100',
    }))).toBe(true);
  });

  it('rejects absent, cross-origin, and non-loopback origins', () => {
    delete process.env.INTERNAL_API_TOKEN;
    expect(workerControlAuthorized(request('http://localhost:3100/api/worker/start'))).toBe(false);
    expect(workerControlAuthorized(request('http://localhost:3100/api/worker/start', {
      origin: 'http://evil.test',
    }))).toBe(false);
    expect(workerControlAuthorized(request('http://192.168.1.5:3100/api/worker/start', {
      origin: 'http://192.168.1.5:3100',
    }))).toBe(false);
  });

  it('validates forwarded addresses only when proxy trust is explicit', () => {
    delete process.env.INTERNAL_API_TOKEN;
    process.env.TRUST_PROXY = '1';
    const base = {
      origin: 'http://localhost:3100',
      'x-forwarded-for': '203.0.113.9',
    };
    expect(workerControlAuthorized(request('http://localhost:3100/api/worker/start', base))).toBe(false);
    expect(workerControlAuthorized(request('http://localhost:3100/api/worker/start', {
      ...base,
      'x-forwarded-for': '127.0.0.1',
    }))).toBe(true);
  });
});

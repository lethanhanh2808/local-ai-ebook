// src/tests/is-transient-gateway-error.test.ts
//
// Unit tests for the retry classifier used inside the bible worker's
// outer retry loop. The pre-fix regression was undici (and other
// modern HTTP clients) surfacing 502 as a numeric `.statusCode` field
// rather than embedding the status text in `error.message`, which the
// regex backstop silently missed.

import { describe, expect, it } from 'vitest';
import { isTransientGatewayError } from '@/lib/ai/character-bible';

describe('isTransientGatewayError', () => {
  it('classifies a rawChat-style "AI 502" message as transient', () => {
    expect(isTransientGatewayError(new Error('AI 502: Bad Gateway')))
      .toBe(true);
    expect(isTransientGatewayError(new Error('AI 503: Service Unavailable')))
      .toBe(true);
    expect(isTransientGatewayError(new Error('AI 504: Gateway Timeout')))
      .toBe(true);
    expect(isTransientGatewayError(new Error('AI 408: Request Timeout')))
      .toBe(true);
    expect(isTransientGatewayError(new Error('AI 429: Too Many Requests')))
      .toBe(true);
  });

  it('classifies structured statusCode 5xx as transient (#8 fix)', () => {
    // The undici-style error that the pre-fix regex backstop missed:
    // { message: 'fetch failed', statusCode: 502 }.
    const err = new Error('fetch failed') as Error & { statusCode?: number };
    err.statusCode = 502;
    expect(isTransientGatewayError(err)).toBe(true);
    err.statusCode = 503;
    expect(isTransientGatewayError(err)).toBe(true);
    err.statusCode = 504;
    expect(isTransientGatewayError(err)).toBe(true);
    err.statusCode = 408;
    expect(isTransientGatewayError(err)).toBe(true);
    err.statusCode = 429;
    expect(isTransientGatewayError(err)).toBe(true);
  });

  it('reads statusCode off the .cause when present', () => {
    const cause = new Error('socket hang up') as Error & { statusCode?: number };
    cause.statusCode = 502;
    const outer = new Error('Failed to fetch') as Error & { cause?: unknown };
    outer.cause = cause;
    expect(isTransientGatewayError(outer)).toBe(true);
  });

  it('reads .status (HTTP response wrapper) as a fallback property name', () => {
    // Some wrappers expose the status as `.status` instead of `.statusCode`.
    const err = new Error('Request failed') as Error & { status?: number };
    err.status = 504;
    expect(isTransientGatewayError(err)).toBe(true);
  });

  it('classifies 4xx other than 408/429 as non-transient', () => {
    expect(isTransientGatewayError(new Error('AI 401: Unauthorized')))
      .toBe(false);
    expect(isTransientGatewayError(new Error('AI 403: Forbidden')))
      .toBe(false);
    expect(isTransientGatewayError(new Error('AI 400: Bad Request')))
      .toBe(false);
    const err401 = new Error('fetch failed') as Error & { statusCode?: number };
    err401.statusCode = 401;
    expect(isTransientGatewayError(err401)).toBe(false);
  });

  it('classifies "AI returned empty response" as transient', () => {
    expect(isTransientGatewayError(new Error('AI returned empty response')))
      .toBe(true);
  });

  it('classifies AbortError / network drops as transient', () => {
    expect(isTransientGatewayError(new Error('AbortError: aborted')))
      .toBe(true);
    expect(isTransientGatewayError(new Error('fetch failed'))).toBe(true);
    expect(isTransientGatewayError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientGatewayError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isTransientGatewayError(new Error('socket hang up'))).toBe(true);
  });

  it('classifies raw 504 HTML page leakage as transient', () => {
    expect(isTransientGatewayError(new Error(
      '<html><head><title>504 Gateway Time-out</title></head></html>',
    ))).toBe(true);
  });

  it('refuses to retry JsonChatError (model-side parse failure)', () => {
    // Workaround for the JsonChatError class — TS class check is
    // awkward so we just attach `name` to a plain Error instance.
    const jce = new Error('Got non-JSON response') as Error & { name: string };
    jce.name = 'JsonChatError';
    expect(isTransientGatewayError(jce)).toBe(false);
  });

  it('returns false for an unknown error shape', () => {
    expect(isTransientGatewayError(new Error('Some business-logic failure')))
      .toBe(false);
    expect(isTransientGatewayError('string error')).toBe(false);
    expect(isTransientGatewayError(null)).toBe(false);
    expect(isTransientGatewayError(undefined)).toBe(false);
  });
});

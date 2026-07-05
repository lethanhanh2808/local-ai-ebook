// src/app/api/settings/test-ai/route.ts
// POST /api/settings/test-ai
// Pings the configured AI provider with a trivial prompt and returns the
// response + latency. Used by the /settings page to verify configuration.
import { NextRequest, NextResponse } from 'next/server';
import { chat } from '@/lib/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { message?: string };
  const t0 = Date.now();
  try {
    const text = await chat({
      messages: [
        { role: 'user', content: body.message ?? 'Reply with the single word: pong' },
      ],
      temperature: 0,
      max_tokens: 32,
      timeoutMs: 30_000,
    });
    return NextResponse.json({
      ok: true,
      ms: Date.now() - t0,
      response: text.slice(0, 200),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 502 });
  }
}
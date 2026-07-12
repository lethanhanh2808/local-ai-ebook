// src/app/api/tts/health/route.ts
// Health summary for the local TTS stack used by reader/audiobook features.
// 2026-07-12: VieNeu is the sole backend. The route talks to the VieNeu
// FastAPI server on :5020 and synthesizes the same shape the reader +
// ServiceHealth components expect (with `services.vieneu` + `services.piper`
// + `services.mossNano` left in place for backward compatibility with any
// cached UI consumers).
import { NextResponse } from 'next/server';

const VIENEU_BASE_URL = (
  process.env.VIENEU_BASE_URL ??
  process.env.UNIFIED_TTS_URL ??
  process.env.TTS_SERVICE_URL ??
  'http://127.0.0.1:5020'
).replace(/\/$/, '');

interface Backend {
  id: string;
  name: string;
  ready: boolean;
  languages?: string[];
}

async function fetchJson<T>(path: string, timeoutMs = 3_000): Promise<T> {
  const r = await fetch(`${VIENEU_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function GET(): Promise<NextResponse> {
  const checkedAt = new Date().toISOString();
  try {
    const health = await fetchJson<{ status?: string; vieneu?: string; vieneu_alive?: boolean }>('/health');
    const vieneuReady = health.status === 'ok';
    const inferredBackends: Backend[] = vieneuReady
      ? [{ id: 'vieneu', name: 'VieNeu', ready: true, languages: ['vi'] }]
      : [];

    return NextResponse.json({
      ok: vieneuReady,
      checkedAt,
      unified: {
        ok: vieneuReady,
        url: VIENEU_BASE_URL,
        status: health.status ?? 'unknown',
      },
      services: {
        vieneu: vieneuReady || !!health.vieneu_alive,
        // Piper and MOSS-TTS-Nano are removed (2026-07-12). Kept in the
        // response as `false` so old UI consumers don't crash when reading
        // `services.piper` / `services.mossNano`.
        piper: false,
        mossNano: false,
      },
      backends: inferredBackends,
      defaultBackend: vieneuReady ? 'vieneu' : null,
      recommendation: vieneuReady
        ? null
        : 'Start the local TTS service: bash app/tts-service/start_all.sh, then re-check TTS health.',
      errors: { health: null, backends: null },
    }, { status: vieneuReady ? 200 : 503 });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      checkedAt,
      unified: { ok: false, url: VIENEU_BASE_URL, status: 'down' },
      services: { vieneu: false, piper: false, mossNano: false },
      backends: [],
      defaultBackend: null,
      recommendation: 'Start the local TTS service: bash app/tts-service/start_all.sh, then re-check TTS health.',
      error: err instanceof Error ? err.message : String(err),
    }, { status: 503 });
  }
}

// src/app/api/tts/health/route.ts
// Health summary for the local TTS stack used by reader/audiobook features.
import { NextResponse } from 'next/server';

const UNIFIED_TTS_URL = (process.env.UNIFIED_TTS_URL ?? process.env.TTS_SERVICE_URL ?? 'http://127.0.0.1:5010').replace(/\/$/, '');

interface Backend {
  id: string;
  name: string;
  ready: boolean;
  languages?: string[];
}

async function fetchJson<T>(path: string, timeoutMs = 3_000): Promise<T> {
  const r = await fetch(`${UNIFIED_TTS_URL}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function GET(): Promise<NextResponse> {
  const checkedAt = new Date().toISOString();
  try {
    const [health, backendsData] = await Promise.allSettled([
      fetchJson<{ status?: string; piper?: string; vieneu_alive?: boolean; nano_installed?: boolean }>('/health'),
      fetchJson<{ backends?: Backend[]; default_backend?: string }>('/backends'),
    ]);

    const healthValue = health.status === 'fulfilled' ? health.value : null;
    const backends = backendsData.status === 'fulfilled' ? (backendsData.value.backends ?? []) : [];
    const vieneu = backends.find((b) => b.id === 'vieneu');
    const piper = backends.find((b) => b.id === 'piper');
    const moss = backends.find((b) => b.id === 'moss-nano');
    const unifiedOk = health.status === 'fulfilled' && (healthValue?.status === 'ok' || backends.length > 0);
    const ok = unifiedOk && !!vieneu?.ready;

    return NextResponse.json({
      ok,
      checkedAt,
      unified: {
        ok: unifiedOk,
        url: UNIFIED_TTS_URL,
        status: healthValue?.status ?? (unifiedOk ? 'ok' : 'unknown'),
      },
      services: {
        vieneu: !!vieneu?.ready || !!healthValue?.vieneu_alive,
        piper: !!piper?.ready || !!healthValue?.piper,
        mossNano: !!moss?.ready || !!healthValue?.nano_installed,
      },
      backends,
      defaultBackend: backendsData.status === 'fulfilled' ? backendsData.value.default_backend : null,
      recommendation: ok
        ? null
        : 'Start the full local stack with ./scripts/start_full_app.sh --background, then re-check TTS health.',
      errors: {
        health: health.status === 'rejected' ? String(health.reason) : null,
        backends: backendsData.status === 'rejected' ? String(backendsData.reason) : null,
      },
    }, { status: ok ? 200 : 503 });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      checkedAt,
      unified: { ok: false, url: UNIFIED_TTS_URL, status: 'down' },
      services: { vieneu: false, piper: false, mossNano: false },
      backends: [],
      defaultBackend: null,
      recommendation: 'Start the full local stack with ./scripts/start_full_app.sh --background, then re-check TTS health.',
      error: err instanceof Error ? err.message : String(err),
    }, { status: 503 });
  }
}


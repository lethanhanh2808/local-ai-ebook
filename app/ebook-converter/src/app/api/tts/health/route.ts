// src/app/api/tts/health/route.ts
// Health summary for the local TTS stack used by reader/audiobook features.
// 2026-07-12: VieNeu is the sole backend. The `listEngines()` probe still
// drives `backends[]` so a future engine swap is one line in provider.ts.
import { NextResponse } from 'next/server';
import { getActiveTTSEngine, listEngines } from '@/lib/tts/provider';

interface Backend {
  id: string;
  name: string;
  ready: boolean;
  languages?: string[];
}

async function probeEngine(baseUrl: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  const checkedAt = new Date().toISOString();
  const activeEngine = await getActiveTTSEngine();
  const registered = listEngines();
  const probed = await Promise.all(
    registered.map(async (e) => ({
      ...e,
      ready: await probeEngine(e.baseUrl),
    })),
  );
  const backends: Backend[] = probed.map((e) => ({
    id: e.id,
    name: e.label,
    ready: e.ready,
    languages: ['vi'],
  }));
  const activeReady = probed.find((p) => p.id === activeEngine.headerTag)?.ready
    ?? backends.find((b) => b.id === 'vieneu')?.ready
    ?? false;

  return NextResponse.json({
    ok: activeReady,
    checkedAt,
    unified: {
      ok: activeReady,
      url: activeEngine.baseUrl(),
      status: activeReady ? 'ok' : 'down',
      engine: activeEngine.headerTag,
    },
    services: {
      // Legacy field — the health UI still reads it. Derived from the
      // VieNeu probe so the boolean stays honest.
      vieneu: backends.find((b) => b.id === 'vieneu')?.ready ?? false,
    },
    backends,
    defaultBackend: activeEngine.headerTag,
    recommendation: activeReady
      ? null
      : 'Start the local TTS service: bash app/tts-service/start_all.sh, then re-check TTS health.',
    errors: { health: null, backends: null },
  }, { status: activeReady ? 200 : 503 });
}

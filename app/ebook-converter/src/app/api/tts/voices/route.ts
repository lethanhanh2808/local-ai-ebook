// src/app/api/tts/voices/route.ts
//
// GET /api/tts/voices — returns the active backend's voice catalog.
//
// Why a dedicated endpoint? The reader UI's "Default voice" dropdown
// (VoicePanel, ReadAloudPanel, EbookReader) reads from `@/lib/tts/vieneu-voices`
// via this endpoint, so a future engine swap is one place to change. We
// also fetch `/voices` from the engine's own FastAPI server and merge
// any extra entries — the TS-side catalog stays the authority on
// attributes (gender/age/tone), but a Python-side change can surface new
// built-ins without a TS redeploy.
import { NextResponse } from 'next/server';
import {
  getActiveTTSEngine,
  voicesForEngine,
  type VoiceListItem,
} from '@/lib/tts/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const engine = await getActiveTTSEngine();
  const local = voicesForEngine(engine);

  // Optional proxy of the engine's own /voices. If the server is down or
  // returns something we don't expect, fall back to the TS catalog
  // silently — the local list is always the source of truth.
  let serverVoices: VoiceListItem[] = [];
  try {
    const r = await fetch(`${engine.baseUrl()}/voices`, {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    if (r.ok) {
      const body = await r.json().catch(() => ({})) as { voices?: unknown };
      if (Array.isArray(body?.voices)) {
        // The server shape is loose; we only accept entries with an id +
        // label so we never expose something malformed to the UI.
        serverVoices = body.voices
          .filter((v): v is { id: unknown; label: unknown } =>
            typeof v === 'object' && v !== null
              && typeof (v as { id?: unknown }).id === 'string'
              && typeof (v as { label?: unknown }).label === 'string',
          )
          .map((v) => ({
            id: v.id as string,
            label: v.label as string,
            builtin: true,
          }));
      }
    }
  } catch {
    // Network failure or timeout — ignore. The TS catalog is enough.
  }

  // Merge by id; the local catalog wins on attributes. Any server-only
  // entries are appended so a server-side update lands in the UI.
  const byId = new Map<string, VoiceListItem>();
  for (const v of local) byId.set(v.id, v);
  for (const v of serverVoices) {
    if (!byId.has(v.id)) byId.set(v.id, v);
  }
  const voices = Array.from(byId.values());

  return NextResponse.json({
    backend: engine.headerTag,
    label: engine.label,
    isCloningOnly: engine.isCloningOnly,
    voices,
  });
}

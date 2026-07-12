// src/lib/tts/client.ts
// VieNeu-only TTS client – talks to the local VieNeu FastAPI server.
//
// Use:
//   const wav = await synthesizeTTS({ text, voice: { refAudioPath, language } })
//   const buf = await synthesizeVoiceSample({ voiceId, text })  // for test-voice UI
//
// 2026-07-12: Piper and MOSS-TTS-Nano backends were removed. The only
// running TTS service is VieNeu-TTS on :5020.
'use server';

const VIENEU_BASE_URL =
  process.env.VIENEU_BASE_URL ??
  process.env.UNIFIED_TTS_URL ??   // back-compat alias
  process.env.TTS_SERVICE_URL ??
  'http://127.0.0.1:5020';

export interface SynthesizeOptions {
  text: string;
  language?: string;            // 'vi' | 'en' | ...
  speed?: number;               // 0.5 - 2.0
  voiceRefPath?: string;        // absolute path to reference WAV
  voiceName?: string;
  expressiveness?: number;      // Piper-compatible noise_scale/noise_w
}

export async function synthesizeTTS(opts: SynthesizeOptions): Promise<{ audio: Buffer; backend: string }> {
  const isVi = (opts.language ?? '').toLowerCase().startsWith('vi') || hasVietnameseDiacritics(opts.text);
  // 2026-07-12: VieNeu is the sole TTS backend. Pin backend='vieneu'.
  const backend = 'vieneu';
  const expressiveness = Math.min(1.0, Math.max(0.2, opts.expressiveness ?? 0.667));

  const r = await fetch(`${VIENEU_BASE_URL}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: opts.text,
      backend,
      language: opts.language ?? 'vi',
      speed: opts.speed ?? 1.0,
      voice: opts.voiceName,
      reference_path: opts.voiceRefPath,
      noise_scale: expressiveness,
      noise_w: expressiveness,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`TTS ${r.status}: ${detail.slice(0, 200)}`);
  }
  const audio = Buffer.from(await r.arrayBuffer());
  return { audio, backend: r.headers.get('X-TTS-Backend') ?? backend };
}

function hasVietnameseDiacritics(s: string): boolean {
  return /[\u0100-\u017f\u1e00-\u1eff\u0300-\u036f]/.test(s);
}

export async function listAvailableBackends(): Promise<Array<{ id: string; name: string; ready: boolean; languages: string[] }>> {
  // 2026-07-12: only VieNeu is exposed. The /backends endpoint is no longer
  // guaranteed by the server, so return a single static entry on demand.
  return [
    { id: 'vieneu', name: 'VieNeu-TTS', ready: true, languages: ['vi', 'en'] },
  ];
}

export async function checkTTSHealth(): Promise<{ ok: boolean; backends: string[]; vieneu: string }> {
  try {
    const r = await fetch(`${VIENEU_BASE_URL}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return { ok: false, backends: [], vieneu: '' };
    const data = await r.json() as { status: string; vieneu?: string; vieneu_alive?: boolean };
    const backends = data.vieneu_alive ? ['vieneu'] : [];
    return { ok: data.status === 'ok', backends, vieneu: data.vieneu ?? '' };
  } catch {
    return { ok: false, backends: [], vieneu: '' };
  }
}

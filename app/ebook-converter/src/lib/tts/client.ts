// src/lib/tts/client.ts
// Unified TTS client – talks to the unified FastAPI server (VieNeu + Piper + MOSS-TTS-Nano).
//
// Use:
//   const wav = await synthesizeTTS({ text, voice: { refAudioPath, language } })
//   const buf = await synthesizeVoiceSample({ voiceId, text })  // for test-voice UI
'use server';

const UNIFIED_TTS_URL = process.env.UNIFIED_TTS_URL ?? process.env.TTS_SERVICE_URL ?? 'http://127.0.0.1:5010';

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
  // 2026-07-06: only VieNeu runs locally — Piper + MOSS-Nano removed.
  // Pin backend='vieneu' for Vietnamese; let the server pick otherwise (it
  // defaults to vieneu anyway when no other backends are registered).
  const backend: string | undefined = isVi ? 'vieneu' : undefined;
  const expressiveness = Math.min(1.0, Math.max(0.2, opts.expressiveness ?? 0.667));

  const r = await fetch(`${UNIFIED_TTS_URL}/synthesize`, {
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
  return { audio, backend: r.headers.get('X-TTS-Backend') ?? backend ?? 'auto' };
}

function hasVietnameseDiacritics(s: string): boolean {
  return /[\u0100-\u017f\u1e00-\u1eff\u0300-\u036f]/.test(s);
}

export async function listAvailableBackends(): Promise<Array<{ id: string; name: string; ready: boolean; languages: string[] }>> {
  try {
    const r = await fetch(`${UNIFIED_TTS_URL}/backends`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return [];
    const data = await r.json() as { backends: Array<{ id: string; name: string; ready: boolean; languages: string[] }> };
    return data.backends;
  } catch {
    return [];
  }
}

export async function checkTTSHealth(): Promise<{ ok: boolean; backends: string[]; piper: string }> {
  try {
    const r = await fetch(`${UNIFIED_TTS_URL}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return { ok: false, backends: [], piper: '' };
    const data = await r.json() as { status: string; piper: string; vieneu_alive?: boolean; nano_installed: boolean };
    const backends = [
      ...(data.vieneu_alive ? ['vieneu'] : []),
      'piper',
      ...(data.nano_installed ? ['moss-nano'] : []),
    ];
    return { ok: data.status === 'ok', backends, piper: data.piper };
  } catch {
    return { ok: false, backends: [], piper: '' };
  }
}

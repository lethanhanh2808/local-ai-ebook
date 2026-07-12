// src/app/api/tts/preview/route.ts
// POST /api/tts/preview
//
// Preview any voice (built-in VieNeu OR custom uploaded) with a short text.
// Used by the CharacterDetection panel's "nghe thử" button so users can
// audition a voice before assigning it to a character.
//
// Body: { voice: "Xuân Vĩnh", text?: string, language?: "vi"|"en", speed?: number }
//   - "voice" can be either a built-in VieNeu voice name OR a Voice row ID
//     (UUID). If it looks like a UUID we look it up and use its refAudioPath
//     for voice cloning.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getVoice } from '@/lib/db/voices';
import { BUILTIN_VIENEU_NAMES } from '@/lib/tts/vieneu-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUILTIN_VIENEU = new Set(BUILTIN_VIENEU_NAMES);

const VIENEU_BASE_URL = process.env.VIENEU_BASE_URL ?? process.env.UNIFIED_TTS_URL ?? process.env.TTS_SERVICE_URL ?? 'http://127.0.0.1:5020';
const DEFAULT_PREVIEW = 'Xin chào bạn đọc, đây là giọng của tôi.';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    voice?: string;
    text?: string;
    language?: string;
    speed?: number;
  };

  const voice = body.voice?.trim();
  if (!voice) {
    return NextResponse.json({ error: 'voice required' }, { status: 400 });
  }
  const text = (body.text?.trim() || DEFAULT_PREVIEW).slice(0, 1_000);
  const rawSpeed = body.speed ?? 1.0;
  const speed = typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
    ? Math.min(2, Math.max(0.5, rawSpeed))
    : 1.0;

  let refPath: string | undefined;
  let language = body.language ?? 'vi';
  let useBuiltIn = BUILTIN_VIENEU.has(voice);

  // If it looks like a UUID, look up the custom voice
  if (!useBuiltIn && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voice)) {
    const v = await getVoice(voice);
    if (!v || !v.refAudioPath || !fs.existsSync(v.refAudioPath)) {
      return NextResponse.json({ error: 'voice not found or no reference audio' }, { status: 404 });
    }
    refPath = v.refAudioPath;
    language = v.language || 'vi';
  } else if (!useBuiltIn) {
    return NextResponse.json({ error: `unknown voice: ${voice}` }, { status: 400 });
  }

  // Synthesize via unified server
  const payload: Record<string, unknown> = {
    text,
    speed,
    language,
  };
  if (useBuiltIn) {
    payload["voice"] = voice;
    payload["backend"] = "vieneu";
  } else {
    // Custom voice → voice cloning (unified server routes to appropriate backend)
    payload["backend"] = "vieneu";
    payload["reference_path"] = refPath;
  }

  try {
    const r = await fetch(`${VIENEU_BASE_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return NextResponse.json({ error: `TTS ${r.status}: ${detail.slice(0, 200)}` }, { status: 502 });
    }
    const audio = await r.arrayBuffer();
    return new NextResponse(audio, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.byteLength),
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `TTS service unreachable: ${String(err)}` }, { status: 503 });
  }
}

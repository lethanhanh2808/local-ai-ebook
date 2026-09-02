// src/app/api/tts/preview/route.ts
// POST /api/tts/preview
//
// Preview any voice (built-in VieNeu OR custom uploaded) with a short text.
// Used by the CharacterDetection panel's "nghe thử" button so users can
// audition a voice before assigning it to a character.
//
// Body: { voice: "Xuân Vĩnh", text?: string, language?: "vi"|"en", speed?: number, emotion?: string }
//   - "voice" can be either a built-in VieNeu voice name OR a Voice row ID
//     (UUID). If it looks like a UUID we look it up and use its refAudioPath
//     for voice cloning.
//   - "emotion" (optional) is mapped to the engine's inline marker (e.g.
//     [cười] / [thở dài] / [hắng giọng]) so the preview matches the
//     per-voice "sắc thái" the user set on the character card.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getVoice } from '@/lib/db/voices';
import { BUILTIN_VIENEU_NAMES, isBuiltinVieNeuVoice } from '@/lib/tts/vieneu-voices';
import { clampSpeechSpeed } from '@/lib/tts/speech-helpers';
import {
  getActiveTTSEngine,
  isBuiltinVoiceForEngine,
  sanitizeTextForEngine,
  buildPayloadForEngine,
} from '@/lib/tts/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUILTIN_VIENEU = new Set(BUILTIN_VIENEU_NAMES);

const DEFAULT_PREVIEW = 'Xin chào bạn đọc, đây là giọng của tôi.';

// Mirror of the helper in /api/tts/route.ts: prepend the engine's inline
// emotion marker (e.g. [cười] / [thở dài] / [hắng giọng]) so the preview
// reflects the per-voice "sắc thái" the user picked on the character card.
function applyEmotionMarker(text: string, emotion?: string | null): string {
  const marker = engine_emotionMarker(emotion);
  if (!marker) return text;
  if (/^\s*\[(?:cười|thở dài|hắng giọng)\]/i.test(text)) return text;
  if (marker === '[cười]') {
    const lc = text.toLowerCase();
    const hasLaughEvidence =
      /\b(?:haha|ha ha|hehe|hihi|hê hê|cười lớn|phá lên cười|cười khanh khách|cười khúc khích|cười ha hả|cười hô hố|cười rúc rích|cười gằn)\b/.test(lc)
      || /\*?(?:khanh khách|khúc khích|hô hố|ha hả|khẽ cười|nhếch mép cười|cười gượng)\*?/.test(lc)
      || /\(\s*(?:cười gằn|cười khổ)\s*\)/.test(lc);
    if (!hasLaughEvidence) return text;
  }
  return `${marker} ${text}`;
}

// Resolved lazily inside the handler (engine is async); declared here so the
// helper above can reference it.
let engine_emotionMarker: (e: string | null | undefined) => string = () => '';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    voice?: string;
    text?: string;
    language?: string;
    speed?: number;
      emotion?: string;
    };

    const voice = body.voice?.trim();
    if (!voice) {
      return NextResponse.json({ error: 'voice required' }, { status: 400 });
    }
    const text = (body.text?.trim() || DEFAULT_PREVIEW).slice(0, 1_000);
    const speed = clampSpeechSpeed(body.speed ?? 1.0);
    const emotion = body.emotion?.trim() || null;

    // Resolve the active engine once. The payload builder owns the
    // differences between engine JSON shapes so this route stays single-
    // backend with the current VieNeu-only setup.
    const engine = await getActiveTTSEngine();
    engine_emotionMarker = (e) => engine.emotionMarker(e);
    const isBuiltin = (n: string) =>
      isBuiltinVoiceForEngine(engine, n) || isBuiltinVieNeuVoice(n);

  let refPath: string | undefined;
  let language = body.language ?? 'vi';
  let useBuiltIn = isBuiltin(voice);

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

const marked = applyEmotionMarker(text, emotion);
    const cleanText = sanitizeTextForEngine(engine, marked);
    const payload = buildPayloadForEngine(engine, {
      text: cleanText,
      voice: useBuiltIn ? voice : null,
      refAudio: refPath,
      refText: null,
      speed,
      language,
      emotion,
  });

  try {
    const r = await fetch(`${engine.baseUrl()}/synthesize`, {
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
        // The Python server sets `X-TTS-Engine`; we rebrand at the proxy so
        // the browser always sees `X-TTS-Backend`.
        'X-TTS-Backend': r.headers.get('X-TTS-Engine') ?? r.headers.get('X-TTS-Backend') ?? engine.headerTag,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `TTS service unreachable: ${String(err)}` }, { status: 503 });
  }
}

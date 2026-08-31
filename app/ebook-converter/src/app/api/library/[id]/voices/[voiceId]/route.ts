// src/app/api/library/[id]/voices/[voiceId]/route.ts
// PATCH  /api/library/[id]/voices/[voiceId] – update name/desc/default
// DELETE /api/library/[id]/voices/[voiceId] – delete voice
// POST   /api/library/[id]/voices/[voiceId]?action=test – synthesize test sample
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getBook } from '@/lib/db/books';
import { getVoice, updateVoice, deleteVoice } from '@/lib/db/voices';
import { setBookAudiobookStatus } from '@/lib/db/audiobook';
import { isBuiltinVieNeuVoice } from '@/lib/tts/vieneu-voices';
import { buildVoiceHeader, clampSpeechSpeed } from '@/lib/tts/speech-helpers';
import {
  getActiveTTSEngine,
  isBuiltinVoiceForEngine,
  sanitizeTextForEngine,
  buildPayloadForEngine,
} from '@/lib/tts/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; voiceId: string }> }
) {
  const params = await props.params;
  const voice = await getVoice(params.voiceId);
  if (!voice || voice.bookId !== params.id) return NextResponse.json({ error: 'Voice not found' }, { status: 404 });

  let body: {
    name?: string;
    description?: string;
    language?: string;
    isDefault?: boolean;
    defaultSpeed?: number;
    defaultEmotion?: string;
  };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const data: Parameters<typeof updateVoice>[1] = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
    }
    data.name = body.name.trim().slice(0, 120);
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return NextResponse.json({ error: 'description must be a string' }, { status: 400 });
    data.description = body.description.trim().slice(0, 500);
  }
  if (body.language !== undefined) {
    if (typeof body.language !== 'string' || !body.language.trim()) return NextResponse.json({ error: 'language must be a non-empty string' }, { status: 400 });
    data.language = body.language.trim().slice(0, 16);
  }
  if (body.isDefault !== undefined) {
    if (typeof body.isDefault !== 'boolean') return NextResponse.json({ error: 'isDefault must be boolean' }, { status: 400 });
    data.isDefault = body.isDefault;
  }
  if (body.defaultSpeed !== undefined) {
    if (typeof body.defaultSpeed !== 'number' || !Number.isFinite(body.defaultSpeed)) {
      return NextResponse.json({ error: 'defaultSpeed must be a finite number' }, { status: 400 });
    }
    data.defaultSpeed = clampSpeechSpeed(body.defaultSpeed);
  }
  if (body.defaultEmotion !== undefined) {
    if (typeof body.defaultEmotion !== 'string') return NextResponse.json({ error: 'defaultEmotion must be a string' }, { status: 400 });
    data.defaultEmotion = body.defaultEmotion.trim().slice(0, 40);
  }

  const updated = await updateVoice(params.voiceId, data);
  await setBookAudiobookStatus(params.id, 'none');
  return NextResponse.json({ voice: updated });
}

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ id: string; voiceId: string }> }
) {
  const params = await props.params;
  const voice = await getVoice(params.voiceId);
  if (!voice || voice.bookId !== params.id) return NextResponse.json({ error: 'Voice not found' }, { status: 404 });

  try { if (fs.existsSync(voice.refAudioPath)) fs.unlinkSync(voice.refAudioPath); } catch {}
  await deleteVoice(params.voiceId);
  await setBookAudiobookStatus(params.id, 'none');
  return NextResponse.json({ ok: true });
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; voiceId: string }> }
) {
  const params = await props.params;
  const voice = await getVoice(params.voiceId);
  if (!voice || voice.bookId !== params.id) return NextResponse.json({ error: 'Voice not found' }, { status: 404 });
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const action = req.nextUrl.searchParams.get('action');
  if (action !== 'test') return NextResponse.json({ error: 'unknown action' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as { text?: string; speed?: number };
  const text = (body.text?.trim() || 'Xin chào, đây là giọng đọc thử nghiệm của tôi.').slice(0, 1_000);
  const speed = clampSpeechSpeed(body.speed ?? voice.defaultSpeed ?? 1.0);

  // Route the test synthesis through the engine registry. VieNeu takes
  // `reference_path` (legacy — kept for back-compat). The registry owns
  // that distinction, plus any backend-specific text sanitization.
  const engine = await getActiveTTSEngine();
  const baseUrl = engine.baseUrl();

  // Prefer the explicit builtinName stored on the row; fall back to the
  // display name only when it IS a preset for the active engine. We
  // still OR with the legacy VieNeu catalog so a row saved before the
  // registry landed doesn't 400 here.
  const isBuiltin = (n: string) =>
    isBuiltinVoiceForEngine(engine, n) || isBuiltinVieNeuVoice(n);
  const preset = voice.builtinName ?? (isBuiltin(voice.name) ? voice.name : null);

  let payload: Record<string, unknown>;
  if (preset) {
    payload = buildPayloadForEngine(engine, {
      text,
      voice: preset,
      speed,
      language: book.language ?? 'vi',
      emotion: voice.defaultEmotion ?? null,
    });
  } else if (voice.refAudioPath && fs.existsSync(voice.refAudioPath)) {
    // Cloned voice — pass the file path.
    payload = buildPayloadForEngine(engine, {
      text,
      voice: null,
      refAudio: voice.refAudioPath,
      refText: null,
      speed,
      language: book.language ?? 'vi',
      emotion: voice.defaultEmotion ?? null,
    });
  } else {
    return NextResponse.json(
      { error: `Voice "${voice.name}" has no reference audio and is not a known preset for ${engine.label}. Upload a sample or pick a built-in.` },
      { status: 400 },
    );
  }
  // Belt-and-suspenders: drop any engine-incompatible bits.
  if (typeof payload.text === 'string') {
    payload.text = sanitizeTextForEngine(engine, payload.text);
  }

  try {
    const bodyStr = JSON.stringify(payload);
    const bodyBytes = new TextEncoder().encode(bodyStr);
    const r = await fetch(`${baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: bodyBytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const errText = await r.text();
      return NextResponse.json({ error: `TTS failed: ${errText.slice(0, 200)}` }, { status: 502 });
    }
    const audio = await r.arrayBuffer();
    // Sanitize the voice name for headers (HTTP requires Latin-1).
    // Vietnamese names like "Nguyễn Ngọc Ngạn" (with diacritics) crash Node's HTTP layer.
    const voiceHeader = buildVoiceHeader(voice.name);
    return new NextResponse(audio, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.byteLength),
        'X-Voice-Name': voiceHeader,
        // Echo which engine served this.
        'X-TTS-Backend': engine.headerTag,
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `TTS service unreachable: ${String(err)}` }, { status: 503 });
  }
}

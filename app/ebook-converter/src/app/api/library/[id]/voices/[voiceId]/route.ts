// src/app/api/library/[id]/voices/[voiceId]/route.ts
// PATCH  /api/library/[id]/voices/[voiceId] – update name/desc/default
// DELETE /api/library/[id]/voices/[voiceId] – delete voice
// POST   /api/library/[id]/voices/[voiceId]?action=test – synthesize test sample
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getBook } from '@/lib/db/books';
import { getVoice, updateVoice, deleteVoice } from '@/lib/db/voices';
import { setBookAudiobookStatus } from '@/lib/db/audiobook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNIFIED_TTS_URL = process.env.UNIFIED_TTS_URL ?? 'http://127.0.0.1:5010';

export async function PATCH(req: NextRequest, { params }: { params: { id: string; voiceId: string } }) {
  const voice = await getVoice(params.voiceId);
  if (!voice || voice.bookId !== params.id) return NextResponse.json({ error: 'Voice not found' }, { status: 404 });

  const body = await req.json() as {
    name?: string;
    description?: string;
    language?: string;
    isDefault?: boolean;
    defaultSpeed?: number;
    defaultEmotion?: string;
  };

  const updated = await updateVoice(params.voiceId, body);
  if (body.isDefault !== undefined) {
    await setBookAudiobookStatus(params.id, 'none');
  }
  return NextResponse.json({ voice: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string; voiceId: string } }) {
  const voice = await getVoice(params.voiceId);
  if (!voice || voice.bookId !== params.id) return NextResponse.json({ error: 'Voice not found' }, { status: 404 });

  try { if (fs.existsSync(voice.refAudioPath)) fs.unlinkSync(voice.refAudioPath); } catch {}
  await deleteVoice(params.voiceId);
  await setBookAudiobookStatus(params.id, 'none');
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, { params }: { params: { id: string; voiceId: string } }) {
  const voice = await getVoice(params.voiceId);
  if (!voice || voice.bookId !== params.id) return NextResponse.json({ error: 'Voice not found' }, { status: 404 });
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const action = req.nextUrl.searchParams.get('action');
  if (action !== 'test') return NextResponse.json({ error: 'unknown action' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as { text?: string; speed?: number };
  const text = body.text?.trim() || 'Xin chào, đây là giọng đọc thử nghiệm của tôi.';
  const speed = body.speed ?? voice.defaultSpeed ?? 1.0;

  // Pick the right backend based on whether we have a reference audio (cloned
  // voice) or just a built-in VieNeu voice name.
  //   - Built-in VieNeu voice (e.g. "Thái Sơn", "Đức Trí"): pass the
  //     builtinName (NOT voice.name) to the unified server — VieNeu only
  //     recognises the 10 preset names. For common-pool voices the user's
  //     display name is "Giọng chung #1..4" but the underlying preset is
  //     "Mỹ Duyên"/"Gia Bảo"/"Trúc Ly"/"Đức Trí".
  //   - Custom cloned voice (has refAudioPath): pass `reference_path` for
  //     voice cloning. Backend = vieneu (cloning) or moss-nano (non-VI).
  // The previous version hardcoded `piper` for Vietnamese — but Piper has
  // only ONE voice, so all built-in voices sounded identical.
  const isVi = (book.language ?? 'vi') === 'vi';
  const hasRef = !!voice.refAudioPath && fs.existsSync(voice.refAudioPath);
  const backend = isVi ? 'vieneu' : 'moss-nano';
  const BUILTIN_VIENEU = new Set([
    'Ngọc Lan', 'Gia Bảo', 'Thái Sơn', 'Đức Trí', 'Mỹ Duyên',
    'Trúc Ly', 'Xuân Vĩnh', 'Trọng Hữu', 'Bình An', 'Ngọc Linh',
  ]);
  const payload: Record<string, unknown> = {
    text,
    backend,
    language: book.language ?? 'vi',
    speed,
  };
  if (hasRef) {
    payload['reference_path'] = voice.refAudioPath;
  } else {
    // Built-in VieNeu voice — resolve the preset name. The display name
    // may differ from the preset (e.g. "Giọng chung #2" → "Gia Bảo"),
    // so prefer builtinName when set, then fall back to display name
    // only if it IS a builtin preset.
    const preset = voice.builtinName
      ?? (BUILTIN_VIENEU.has(voice.name) ? voice.name : null);
    if (preset) {
      payload['voice'] = preset;
    } else {
      // No preset and no ref audio — there's nothing the backend can use.
      return NextResponse.json(
        { error: `Voice "${voice.name}" has no reference audio and is not a known VieNeu preset. Upload a sample or pick a built-in.` },
        { status: 400 },
      );
    }
  }

  try {
    const bodyStr = JSON.stringify(payload);
    const bodyBytes = new TextEncoder().encode(bodyStr);
    const r = await fetch(`${UNIFIED_TTS_URL}/synthesize`, {
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
    // Vietnamese names like "Đức Trí" (with diacritics) crash Node's HTTP layer.
    const voiceHeader = encodeURIComponent(voice.name);
    return new NextResponse(audio, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.byteLength),
        'X-Voice-Name': voiceHeader,
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `TTS service unreachable: ${String(err)}` }, { status: 503 });
  }
}

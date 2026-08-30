// src/app/api/tts/route.ts
//
// Read-aloud endpoint — used by the reader's "Đọc to" (Read aloud) feature.
// Speaks a chunk of text using the assigned character's voice (if known) or
// the book's default voice.
//
// 2026-07-12: VieNeu was the only TTS backend (Piper + MOSS-TTS-Nano removed).
// 2026-08-30: routed through the engine registry — F5-TTS added as a second
// backend. See lib/tts/provider.ts for the contract.
//
// GET  /api/tts/models      — list available engines (legacy compat shape)
// POST /api/tts/speak       — { text, chapterId?, character?, speed?, language?, callIdx? } → audio/wav
import { NextRequest, NextResponse } from 'next/server';
import { resolveVoiceForCharacter } from '@/lib/ai/voice-selector';
import { getVoice } from '@/lib/db/voices';
import { isBuiltinVieNeuVoice } from '@/lib/tts/vieneu-voices';
import {
  getActiveTTSEngine,
  isBuiltinVoiceForEngine,
  listEngines,
  sanitizeTextForEngine,
  buildPayloadForEngine,
} from '@/lib/tts/provider';

/** GET /api/tts/models — return the engine list. The legacy `/backends`
 *  aggregator endpoint was retired when the unified router was removed on
 *  2026-07-05; this endpoint now reports every engine registered in
 *  lib/tts/provider.ts so a UI toggle can render the full set. We probe
 *  each base URL with a 1s timeout so `ready` is honest — a stale URL
 *  doesn't pretend to be available. */
export async function GET(): Promise<NextResponse> {
  const engines = listEngines();
  const probed = await Promise.all(
    engines.map(async (e) => {
      try {
        const r = await fetch(`${e.baseUrl}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        return { id: e.id, name: e.label, ready: r.ok, languages: ['vi'] };
      } catch {
        return { id: e.id, name: e.label, ready: false, languages: ['vi'] };
      }
    }),
  );
  return NextResponse.json({
    backends: probed,
    default_backend: probed.find((b) => b.ready)?.id ?? probed[0]?.id ?? 'vieneu',
  });
}

interface SpeakBody {
  text?: string;
  bookId?: string;
  character?: string;
  /** Optional explicit voice name (UI default selector). */
  voice?: string;
  speed?: number;
  language?: string;
  /** Optional emotion hint from the reader UI or voice assignment. */
  emotion?: string;
  /** Expressiveness/noise value for Piper-compatible backends. */
  expressiveness?: number;
  noiseScale?: number;
  noiseW?: number;
  /** Per-call index — used to derive deterministic jitter for crowd voices
   *  so successive appearances of the same generic character feel natural. */
  callIdx?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Map a detected emotion label → a VieNeu inline marker.
 *
 * Bug history: an earlier version mapped `lãng mạn`, `hành động`, `excited`,
 * `cheerful` etc. ALL to `[cười]`. That's wrong — a romance paragraph or an
 * action paragraph shouldn't inject a forced laugh; it makes every sentence
 * sound like the narrator is giggling. The fix is to restrict `[cười]` to
 * the explicit "laugh / amused" labels, and require content evidence in the
 * paragraph itself (handled by `applyEmotionMarker` below) so the marker
 * never fires on a paragraph that doesn't actually contain a laugh.
 */
function emotionMarker(emotion?: string | null): string {
  const e = (emotion ?? '').toLowerCase().trim();
  if (!e || e === 'neutral') return '';
  // Only the explicit laugh / amusement labels produce [cười].
  if (e === 'laugh' || e === 'amused') return '[cười]';
  // Sadness / resignation / regret → sigh.
  if (['sad', 'sigh', 'regret', 'buồn'].includes(e)) return '[thở dài]';
  // Anger / tension / serious / cold → throat-clear.
  // (Was previously `căng thẳng` only; broadened so any tense delivery gets
  // the [hắng giọng] marker instead of a stray [cười].)
  if (['angry', 'rage', 'tense', 'serious', 'cold', 'sneer', 'tức giận', 'căng thẳng'].includes(e)) return '[hắng giọng]';
  // Action, romance, cheerful, happy, joy, excited → NO marker.
  // The paragraph's speed/noise adjustments (already applied via
  // detectEmotion in EbookReader.tsx) carry the tone; a forced laugh or
  // sigh in the middle of "Cô mỉm cười nhẹ nhàng" or "Hắn chém ngang" sounds
  // absurd.
  return '';
}

/**
 * Inject the emotion marker ONLY if the paragraph actually contains
 * evidence of that emotion.
 *
 * Why this guard? Even with the tightened marker table above, we'd still
 * get stray `[cười]`s on every paragraph that the LLM classified as
 * "cheerful" — including serious dialogue like "Chết tiệt, cậu tốt nhất
 * nên có chuyện gì quan trọng" (the cheerful default tone misleads the
 * classifier). The guard requires laugh-keyword evidence IN THE TEXT
 * before injecting `[cười]`. Sad/angry markers still apply unconditionally
 * to their respective labels because speed/noise changes alone wouldn't
 * be enough to convey those emotions.
 */
function applyEmotionMarker(text: string, emotion?: string | null): string {
  const marker = emotionMarker(emotion);
  if (!marker) return text;
  // If the caller already injected a marker, don't double up.
  if (/^\s*\[(?:cười|thở dài|hắng giọng)\]/i.test(text)) return text;
  // Require content evidence for [cười] — explicit laugh patterns only.
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SpeakBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const text = (body.text ?? '').trim();
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }
  if (text.length > 10_000) {
    return NextResponse.json({ error: 'text is too long (maximum 10000 characters)' }, { status: 413 });
  }

  // Resolve the active TTS engine once. Used for base URL, text
  // sanitization, payload shape, and the response header tag.
  const engine = await getActiveTTSEngine();

  // Resolve which voice to use, with this priority:
  //   1. If `body.character` is provided → per-character lookup
  //      (`resolveVoiceForCharacter` does alias-aware matching, common-
  //      pool routing, deterministic jitter for crowd voices).
  //   2. Else if `body.voice` is provided → user UI choice for narration
  //      (the Read-aloud panel's "Default voice" selector).
  //   3. Else if `body.bookId` is set → book default (legacy fallback).
  //   4. Undefined → backend picks its own default.
  let voiceName: string | undefined;
  let referencePath: string | undefined;
  let voiceSpeed = 1.0;
  let voiceEmotion = 'neutral';
  // Backend-aware membership check, with a fallback to the static
  // VieNeu catalog so a stale builtin name from before the F5 switch
  // doesn't 400 here.
  const isBuiltin = (n: string) =>
    isBuiltinVoiceForEngine(engine, n) || isBuiltinVieNeuVoice(n);
  if (body.character) {
    const v = await resolveVoiceForCharacter(body.bookId ?? '', body.character, body.callIdx ?? 0);
    if (v) {
      // Character has a stored voice assignment — use it.
      if (v.builtinName) voiceName = v.builtinName;
      if (v.refAudioPath) referencePath = v.refAudioPath;
      voiceSpeed = v.speed ?? 1.0;
      voiceEmotion = v.emotion ?? 'neutral';
    } else if (!body.voice) {
      // No character row AND no explicit UI voice — bail with a clear 400
      // rather than silently POSTing an empty payload (which the F5 server
      // then rejects as "either `voice` or `ref_audio`+`ref_text` is
      // required" → 502). The client treats 400 as a recoverable user
      // error and shows a helpful message; 502 looks like a server fault.
      return NextResponse.json(
        { error: 'No voice assigned for this character and no default voice provided. Set a Default voice in the Read aloud panel, or run character detection to assign voices.' },
        { status: 400 },
      );
    }
    // else: character row missing BUT the client also passed an explicit
    // `voice` — fall through to the body.voice branch below instead of
    // throwing the request away.
  }
  if (!voiceName && !referencePath && body.voice) {
    if (UUID_RE.test(body.voice)) {
      const voice = await getVoice(body.voice);
      if (voice && (!body.bookId || voice.bookId === body.bookId)) {
        const builtin = voice.builtinName ?? (isBuiltin(voice.name) ? voice.name : null);
        if (builtin) voiceName = builtin;
        else if (voice.refAudioPath) referencePath = voice.refAudioPath;
        voiceSpeed = voice.defaultSpeed ?? voiceSpeed;
        voiceEmotion = voice.defaultEmotion ?? voiceEmotion;
      }
    } else {
      voiceName = body.voice;
    }
  } else if (!voiceName && !referencePath && body.bookId) {
    const v = await resolveVoiceForCharacter(body.bookId, undefined, body.callIdx ?? 0);
    if (v?.builtinName) voiceName = v.builtinName;
    if (v?.refAudioPath) referencePath = v.refAudioPath;
    voiceSpeed = v?.speed ?? 1.0;
    voiceEmotion = v?.emotion ?? 'neutral';
  }

  // Build the engine-specific payload. `buildPayloadForEngine` owns the
  // difference between VieNeu's `reference_path` (legacy back-compat)
  // and F5's `ref_audio`/`ref_text` — and knows which keys each engine
  // expects, so adding a third backend only touches provider.ts.
  const speed = Math.min(3.0, Math.max(0.5, body.speed ?? voiceSpeed));
  const emotion = body.emotion ?? voiceEmotion;
  // Apply the inline emotion marker ONLY for engines that understand it.
  // F5 would otherwise read "[cười]" aloud as Vietnamese words. The
  // engine's `sanitizeText` strips anything it can't render.
  const marked = applyEmotionMarker(text, emotion);
  const cleanText = sanitizeTextForEngine(engine, marked);
  const payload = buildPayloadForEngine(engine, {
    text: cleanText,
    voice: voiceName ?? null,
    refAudio: referencePath ?? null,
    refText: null,
    speed,
    language: body.language ?? 'vi',
    emotion,
  });
  // VieNeu-only noise params — left out for engines that don't read them.
  // Adding noise_scale / noise_w to the F5 payload would be a no-op, but
  // the registry shape stays clean.
  if (engine.headerTag === 'vieneu') {
    const expressiveness = clampNumber(body.expressiveness ?? body.noiseScale, 0.667, 0.2, 1.0);
    payload['noise_scale'] = expressiveness;
    payload['noise_w'] = clampNumber(body.noiseW ?? expressiveness, 0.8, 0.2, 1.0);
  }

  try {
    let r: Response;
    // Build body as UTF-8 bytes to be safe with Vietnamese diacritics
    const bodyStr = JSON.stringify(payload);
    const bodyBytes = new TextEncoder().encode(bodyStr);
    r = await fetch(`${engine.baseUrl()}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: bodyBytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return NextResponse.json(
        { error: `TTS failed: ${detail.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const audio = await r.arrayBuffer();
    // Sanitize the voice name for headers (HTTP requires Latin-1).
    // We percent-encode UTF-8 bytes so the client can decode back.
    const voiceHeader = voiceName ? encodeURIComponent(voiceName) : 'default';
    // BUGFIX 2026-08-30: the server sets `X-TTS-Engine` (not `X-TTS-Backend`).
    // The old code read the wrong header and always reported `unknown`.
    // The client expects `X-TTS-Backend`, so we rebrand here at the proxy.
    const engineTag = r.headers.get('X-TTS-Engine') ?? r.headers.get('X-TTS-Backend') ?? engine.headerTag;
    return new NextResponse(audio, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.byteLength),
        'Cache-Control': 'no-cache',
        'X-Voice-Used': voiceHeader,
        'X-TTS-Backend': engineTag,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `TTS service unreachable: ${String(err)}` }, { status: 503 });
  }
}

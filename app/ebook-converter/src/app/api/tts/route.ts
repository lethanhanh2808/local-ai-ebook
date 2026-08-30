// src/app/api/tts/route.ts
//
// Read-aloud endpoint — used by the reader's "Đọc to" (Read aloud) feature.
// Speaks a chunk of text using the assigned character's voice (if known) or
// the book's default voice. 2026-07-12: VieNeu is the only TTS backend —
// Piper + MOSS-TTS-Nano were removed.
//
// GET  /api/tts/models      — list available built-in voices
// POST /api/tts/speak      — { text, chapterId?, character?, speed?, language?, callIdx? } → audio/wav
import { NextRequest, NextResponse } from 'next/server';
import { resolveVoiceForCharacter } from '@/lib/ai/voice-selector';
import { getVoice } from '@/lib/db/voices';
import { isBuiltinVieNeuVoice } from '@/lib/tts/vieneu-voices';

const VIENEU_BASE_URL = (
  process.env.VIENEU_BASE_URL ??
  process.env.UNIFIED_TTS_URL ??   // back-compat alias
  process.env.TTS_SERVICE_URL ??
  'http://127.0.0.1:5020'
).replace(/\/$/, '');

/** GET /api/tts/models — return the synthetic VieNeu backend list.
 *  The old `/backends` aggregator endpoint was retired when the unified
 *  router was removed on 2026-07-05. We always report a single ready
 *  VieNeu backend so existing UI / e2e consumers don't have to special-case
 *  this.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    backends: [{ id: 'vieneu', name: 'VieNeu', ready: true, languages: ['vi'] }],
    default_backend: 'vieneu',
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

  // Resolve which voice to use, with this priority:
  //   1. If `body.character` is provided → per-character lookup
  //      (`resolveVoiceForCharacter` does alias-aware matching, common-
  //      pool routing, deterministic jitter for crowd voices).
  //   2. Else if `body.voice` is provided → user UI choice for narration
  //      (the Read-aloud panel's "Default voice" selector). This is what
  //      was silently broken before: the old code skipped this branch
  //      whenever a `bookId` was set, because resolveVoiceForCharacter
  //      always returned the book's isDefault voice for narration and
  //      shadowed body.voice. Now body.voice wins for narration.
  //   3. Else if `body.bookId` is set → book default (legacy fallback).
  //   4. Undefined → unified server picks its own default.
  let voiceName: string | undefined;
  let referencePath: string | undefined;
  let voiceSpeed = 1.0;
  let voiceEmotion = 'neutral';
  if (body.character) {
    const v = await resolveVoiceForCharacter(body.bookId ?? '', body.character, body.callIdx ?? 0);
    if (v?.builtinName) voiceName = v.builtinName;
    if (v?.refAudioPath) referencePath = v.refAudioPath;
    voiceSpeed = v?.speed ?? 1.0;
    voiceEmotion = v?.emotion ?? 'neutral';
  } else if (body.voice) {
    if (UUID_RE.test(body.voice)) {
      const voice = await getVoice(body.voice);
      if (voice && (!body.bookId || voice.bookId === body.bookId)) {
        const builtin = voice.builtinName ?? (isBuiltinVieNeuVoice(voice.name) ? voice.name : null);
        if (builtin) voiceName = builtin;
        else if (voice.refAudioPath) referencePath = voice.refAudioPath;
        voiceSpeed = voice.defaultSpeed ?? voiceSpeed;
        voiceEmotion = voice.defaultEmotion ?? voiceEmotion;
      }
    } else {
      voiceName = body.voice;
    }
  } else if (body.bookId) {
    // Legacy fallback: when neither character nor an explicit voice is
    // given, defer to the book's stored default. Preserves pre-fix
    // behaviour for any caller that doesn't set `voice` (e.g. scripts).
    const v = await resolveVoiceForCharacter(body.bookId, undefined, body.callIdx ?? 0);
    if (v?.builtinName) voiceName = v.builtinName;
    if (v?.refAudioPath) referencePath = v.refAudioPath;
    voiceSpeed = v?.speed ?? 1.0;
    voiceEmotion = v?.emotion ?? 'neutral';
  }

  // Build unified-server payload. Caller-provided speed overrides jitter.
  const speed = body.speed ?? voiceSpeed;
  const expressiveness = clampNumber(body.expressiveness ?? body.noiseScale, 0.667, 0.2, 1.0);
  const emotion = body.emotion ?? voiceEmotion;
  const payload: Record<string, unknown> = {
    text: applyEmotionMarker(text, emotion),
    speed: Math.min(3.0, Math.max(0.5, speed)),
    language: body.language ?? 'vi',
    noise_scale: expressiveness,
    noise_w: clampNumber(body.noiseW ?? expressiveness, 0.8, 0.2, 1.0),
  };
  if (voiceName) payload['voice'] = voiceName;
  if (referencePath) payload['reference_path'] = referencePath;

  try {
    let r: Response;
    // Build body as UTF-8 bytes to be safe with Vietnamese diacritics
    const bodyStr = JSON.stringify(payload);
    const bodyBytes = new TextEncoder().encode(bodyStr);
    r = await fetch(`${VIENEU_BASE_URL}/synthesize`, {
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
    return new NextResponse(audio, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.byteLength),
        'Cache-Control': 'no-cache',
        'X-Voice-Used': voiceHeader,
        'X-TTS-Backend': r.headers.get('X-TTS-Backend') ?? 'unknown',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `TTS service unreachable: ${String(err)}` }, { status: 503 });
  }
}

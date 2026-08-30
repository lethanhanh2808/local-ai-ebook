// src/lib/tts/provider.ts
//
// Single source of truth for the *TTS engine* abstraction.
//
// Why a registry? The app used to talk to VieNeu directly via a hardcoded
// VIENEU_BASE_URL. With F5 added, every call site that POSTs to a TTS engine
// needs the same plumbing in two flavours:
//
//   - Resolve which engine to use (settings.ttsProvider + env override)
//   - Get the engine's base URL
//   - Strip backend-specific bits from input text (F5 would read aloud the
//     [cười] markers that VieNeu understands as inline emotion tags)
//   - Decide whether a "voice name" passed by the UI maps to a built-in
//     preset for the current engine
//   - Build the JSON payload the engine's /synthesize expects
//   - Pass per-engine extras (e.g. speed, language, ref_audio, ref_text,
//     emotion markers) the right way
//
// Before this registry, the same knowledge was duplicated across
// `api/tts/route.ts`, `api/tts/preview/route.ts`, `api/tts/health/route.ts`,
// the three `characters/*` routes, and `voices/[voiceId]/route.ts`. Adding a
// third engine would have meant touching all six. The registry reduces
// that to one new entry.
//
// The catalog returned by `voices()` is what the UI dropdowns read via
// /api/tts/voices. For engines whose catalog lives in DB (e.g. cloned
// voices), the registry only owns the *built-in* catalog — custom voices
// are added to /api/tts/preview separately by the voices route.

import type { TTSProvider } from '@/lib/db/settings';
import { getEffectiveSettings } from '@/lib/db/settings';
import { VIENEU_PROFILES, isBuiltinVieNeuVoice, type VoiceProfile } from './vieneu-voices';
import { F5_PROFILES } from './f5-voices';

// ── Engine registry ────────────────────────────────────────────────────────

interface EngineConfig {
  /** Display label for /api/tts/voices responses and UI. */
  label: string;
  /** Base URL of the FastAPI server. Read from env, falling back to localhost. */
  baseUrl(): string;
  /** Whether the engine has a built-in voice catalog (vs. cloning-only). */
  hasBuiltins: boolean;
  /** True when every "voice" must be a reference clip + its transcript. */
  isCloningOnly: boolean;
  /** Built-in catalog in VoiceProfile shape (for picker + scoring). */
  builtins(): readonly VoiceProfile[];
  /** Membership check against the engine's catalog. */
  isBuiltinName(name: string | null | undefined): boolean;
  /** Strip engine-incompatible bits from input text. */
  sanitizeText(text: string): string;
  /** Map an emotion label → inline marker for the engine, '' for none. */
  emotionMarker(emotion: string | null | undefined): string;
  /** Build the JSON body for POST /synthesize. */
  buildSynthesizePayload(input: SynthesizeInput): Record<string, unknown>;
  /** Header value the engine returns on success; we surface it as X-TTS-Backend. */
  headerTag: string;
}

export interface SynthesizeInput {
  text: string;
  /** Built-in preset name OR a slug (F5) — resolved via the engine's catalog. */
  voice?: string | null;
  /** Path on disk for an ad-hoc cloned voice (VieNeu). F5 ignores this. */
  refAudio?: string | null;
  /** Exact transcript for the ref audio. Required if refAudio is set. */
  refText?: string | null;
  /** Playback rate, clamped [0.5, 2.0]. */
  speed: number;
  /** Language tag ('vi' default). Engines ignore when not supported. */
  language: string;
  /** Emotion hint, mapped to the engine's marker. */
  emotion?: string | null;
}

// ── VieNeu config ──────────────────────────────────────────────────────────

const VIENEU_EMOTION_RE = /\[(cười|thở dài|hắng giọng)\]/i;

function vieneuEmotionMarker(emotion?: string | null): string {
  const e = (emotion ?? '').toLowerCase().trim();
  if (!e || e === 'neutral') return '';
  if (e === 'laugh' || e === 'amused') return '[cười]';
  if (['sad', 'sigh', 'regret', 'buồn'].includes(e)) return '[thở dài]';
  if (['angry', 'rage', 'tense', 'serious', 'cold', 'sneer', 'tức giận', 'căng thẳng'].includes(e)) return '[hắng giọng]';
  return '';
}

const VIENEU: EngineConfig = {
  label: 'VieNeu-TTS',
  baseUrl: () => (process.env.VIENEU_BASE_URL
    ?? process.env.UNIFIED_TTS_URL
    ?? process.env.TTS_SERVICE_URL
    ?? 'http://127.0.0.1:5020').replace(/\/$/, ''),
  hasBuiltins: true,
  isCloningOnly: false,
  builtins: () => VIENEU_PROFILES,
  isBuiltinName: (name) => isBuiltinVieNeuVoice(name),
  // VieNeu understands the inline emotion markers natively — pass them through.
  sanitizeText: (text) => text,
  emotionMarker: vieneuEmotionMarker,
  headerTag: 'vieneu',
  buildSynthesizePayload(input) {
    const payload: Record<string, unknown> = {
      text: input.text,
      speed: input.speed,
      language: input.language,
      backend: 'vieneu',
    };
    if (input.voice) payload['voice'] = input.voice;
    else if (input.refAudio) payload['reference_path'] = input.refAudio;
    return payload;
  },
};

// ── F5 config ──────────────────────────────────────────────────────────────
//
// F5-TTS is a zero-shot cloning model — it has NO built-in voices of its
// own. Every "voice" is a reference clip + its exact transcript sitting on
// the server's filesystem. The TS catalog below mirrors the slugs that
// `prepare_f5_voices.sh` writes into app/tts-service/F5-TTS/voices/.

const F5_EMOTION_RE = /\[(cười|thở dài|hắng giọng)\]/gi;

function f5EmotionMarker(_emotion?: string | null): string {
  // F5 has no native emotion marker equivalent. The emotion still affects
  // speed/jitter via the surrounding voice selector, but the marker tag is
  // dropped (otherwise F5 reads "[cười]" aloud as Vietnamese words).
  return '';
}

const F5: EngineConfig = {
  label: 'F5-TTS (Vietnamese)',
  baseUrl: () => (process.env.F5_BASE_URL
    ?? process.env.UNIFIED_TTS_URL
    ?? 'http://127.0.0.1:5021').replace(/\/$/, ''),
  hasBuiltins: true,
  isCloningOnly: true,
  builtins: () => F5_PROFILES,
  isBuiltinName: (name) => {
    if (!name) return false;
    return F5_PROFILES.some((p) => p.name === name);
  },
  // Strip the [cười] / [thở dài] / [hắng giọng] markers — F5 would read them
  // aloud as Vietnamese words. The regex is the same one f5_server.py uses
  // server-side, so a UI bug here can't make synthesis sound wrong.
  sanitizeText: (text) => text.replace(F5_EMOTION_RE, '').trim(),
  emotionMarker: f5EmotionMarker,
  headerTag: 'f5',
  buildSynthesizePayload(input) {
    // F5 expects ref_audio (file path) + ref_text (exact transcript). Our
    // catalog slugs map to {voice} on the F5 server; the server resolves
    // them to <voices>/<slug>/{clip.wav, transcript.txt}.
    const payload: Record<string, unknown> = {
      text: input.text,
      speed: input.speed,
      language: input.language,
    };
    if (input.voice) payload['voice'] = input.voice;
    if (input.refAudio) {
      payload['ref_audio'] = input.refAudio;
      if (input.refText) payload['ref_text'] = input.refText;
    }
    return payload;
  },
};

const ENGINES: Record<TTSProvider, EngineConfig> = {
  vieneu: VIENEU,
  f5: F5,
};

// ── Public API ─────────────────────────────────────────────────────────────

export function getTTSEngine(id: TTSProvider): EngineConfig {
  return ENGINES[id] ?? VIENEU;
}

/** Resolve the active TTS engine from settings (DB) or an explicit override. */
export async function getActiveTTSEngine(userId?: string): Promise<EngineConfig> {
  const settings = await getEffectiveSettings(userId);
  const id = (settings.ttsProvider ?? 'vieneu') as TTSProvider;
  return getTTSEngine(id);
}

/**
 * Backend-aware membership check used by the characters / voices routes.
 * Pass an unknown engine and it falls back to the legacy VieNeu check so
 * stale DB rows (a previously-saved 'vieneu' voiceId in a now-f5 book)
 * don't 404.
 */
export function isBuiltinVoiceForEngine(
  engine: EngineConfig,
  name: string | null | undefined,
): boolean {
  return engine.isBuiltinName(name);
}

/** Apply engine-specific text sanitization. */
export function sanitizeTextForEngine(engine: EngineConfig, text: string): string {
  return engine.sanitizeText(text);
}

/** Build the /synthesize payload for the given engine. */
export function buildPayloadForEngine(
  engine: EngineConfig,
  input: SynthesizeInput,
): Record<string, unknown> {
  return engine.buildSynthesizePayload(input);
}

/** Header value the client reads to know which engine served the audio. */
export function engineHeaderTag(engine: EngineConfig): string {
  return engine.headerTag;
}

// ── Catalog helpers ────────────────────────────────────────────────────────

export interface VoiceListItem {
  id: string;
  label: string;
  /** True for engine built-ins; cloned voices from the user DB return false. */
  builtin: boolean;
  gender?: 'male' | 'female';
  age?: 'young' | 'mature' | 'old';
  tone?: 'calm' | 'cheerful' | 'cold' | 'mysterious' | 'serious';
}

export function voicesForEngine(engine: EngineConfig): VoiceListItem[] {
  return engine.builtins().map((p) => ({
    id: p.name,
    label: p.name,
    builtin: true,
    gender: p.gender,
    age: p.age,
    tone: p.tone,
  }));
}

/** List of all registered engines, for health/UI selectors. */
export function listEngines(): Array<{
  id: TTSProvider;
  label: string;
  baseUrl: string;
  hasBuiltins: boolean;
  isCloningOnly: boolean;
}> {
  return (Object.keys(ENGINES) as TTSProvider[]).map((id) => {
    const e = ENGINES[id];
    return {
      id,
      label: e.label,
      baseUrl: e.baseUrl(),
      hasBuiltins: e.hasBuiltins,
      isCloningOnly: e.isCloningOnly,
    };
  });
}
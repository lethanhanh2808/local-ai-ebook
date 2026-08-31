// src/lib/tts/provider.ts
//
// Single source of truth for the *TTS engine* abstraction.
//
// Why a registry (even though there's only one engine)? Every call site
// that POSTs to a TTS engine needs the same plumbing:
//
//   - Resolve which engine to use (settings.ttsProvider + env override)
//   - Get the engine's base URL
//   - Decide whether a "voice name" passed by the UI maps to a built-in
//     preset for the engine
//   - Build the JSON payload the engine's /synthesize expects
//   - Pass per-engine extras (speed, language, ref_audio, ref_text,
//     emotion markers) the right way
//
// Without the registry, the same knowledge was duplicated across
// `api/tts/route.ts`, `api/tts/preview/route.ts`, `api/tts/health/route.ts`,
// the three `characters/*` routes, and `voices/[voiceId]/route.ts`. The
// shape is kept engine-keyed (`Record<TTSProvider, EngineConfig>`) so
// swapping in a second engine later is one new entry.
//
// The catalog returned by `voices()` is what the UI dropdowns read via
// /api/tts/voices. For engines whose catalog lives in DB (e.g. cloned
// voices), the registry only owns the *built-in* catalog — custom voices
// are added via the voices API separately by the voices route.

import type { TTSProvider } from '@/lib/db/settings';
import { getEffectiveSettings } from '@/lib/db/settings';
import { VIENEU_PROFILES, isBuiltinVieNeuVoice, type VoiceProfile } from './vieneu-voices';

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
  /**
   * Engine-side default voice slug for callers that arrive without any voice
   * hint (no character voice, no UI default, no book default). Returns null
   * when the engine picks its own default — caller should leave voiceName
   * unset in that case.
   *
   * Retained in the interface for forward compatibility; the current
   * single engine (VieNeu) returns null because it picks its own default.
   */
  defaultVoice(): string | null;
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
  /** Built-in preset name (e.g. "Trúc Ly") — resolved via the engine's catalog. */
  voice?: string | null;
  /** Path on disk for an ad-hoc cloned voice (VieNeu). */
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
  // VieNeu's /synthesize endpoint picks its own default voice when no
  // `voice` is supplied (the upstream v3-turbo checkpoint has a built-in
  // default). Leaving voiceName unset is the right thing.
  defaultVoice: () => null,
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

const ENGINES: Record<TTSProvider, EngineConfig> = {
  vieneu: VIENEU,
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
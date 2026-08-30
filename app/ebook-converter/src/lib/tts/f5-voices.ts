// src/lib/tts/f5-voices.ts
//
// TS mirror of the F5-TTS catalog served by app/tts-service/F5-TTS/f5_server.py.
//
// F5 is a *zero-shot cloning* model — it has no built-in voices of its own.
// Every "voice" is a reference clip + its exact transcript. The two clips
// the user uploaded land at:
//
//   app/tts-service/F5-TTS/voices/hong-dao/clip.wav  + transcript.txt
//   app/tts-service/F5-TTS/voices/ngoc-ngan/clip.wav + transcript.txt
//
// If you add more reference clips, mirror them here as VoiceProfile entries
// and have prepare_f5_voices.sh create the dir. The shape mirrors
// vieneu-voices.ts so the existing scoreVoice() / pickBestBuiltInVoice()
// logic in lib/ai/voice-selector.ts can be parameterized over either
// catalog unchanged.

import type { VoiceProfile } from './vieneu-voices';

export const F5_PROFILES: readonly VoiceProfile[] = [
  {
    name: 'hong-dao',
    gender: 'female',
    // F5 doesn't ship tone metadata; defaults are inferred from each clip's
    // delivery style. Hồng Đào reads calmly and slowly — a kể-chuyện profile.
    tone: 'calm',
    age: 'mature',
    energy: 'low',
    description: 'Nữ — kể chuyện — clone từ giọng Hồng Đào',
  },
  {
    name: 'ngoc-ngan',
    gender: 'male',
    tone: 'serious',
    age: 'mature',
    energy: 'medium',
    description: 'Nam — kể chuyện — clone từ giọng Ngọc Ngân',
  },
] as const;

/** Just the slug list, ordered for stable iteration. */
export const BUILTIN_F5_NAMES: readonly string[] = F5_PROFILES.map((p) => p.name);

/** Membership check. Use `isBuiltinVoiceForEngine(getTTSEngine('f5'), name)`
 *  instead in route code so the engine registry stays the authority. */
export const BUILTIN_F5: ReadonlySet<string> = new Set(BUILTIN_F5_NAMES);

export function isBuiltinF5Voice(name?: string | null): boolean {
  const value = name?.trim();
  return !!value && BUILTIN_F5.has(value);
}
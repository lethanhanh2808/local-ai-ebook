import { DEFAULT_SETTINGS, type ReaderSettings } from './reader-config';

export interface BrowserSpeechRecognitionAlternative {
  transcript: string;
  confidence?: number;
}

export interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

export interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechRecognitionResult>;
}

export interface BrowserSpeechRecognitionErrorEvent {
  error: string;
}

export interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

export function loadSettings(): ReaderSettings {
  try {
    const r = localStorage.getItem('epub-reader-settings');
    if (r) {
      const saved = JSON.parse(r) as Partial<ReaderSettings>;
      // MIGRATION 2026-07-11 — bump OLD-default values to NEW defaults.
      // If the saved value matches the OLD default exactly, the user never
      // touched the slider — silently upgrade to the NEW default. Real
      // user choices (e.g. width=900) are preserved.
      //
      // ALSO: padInline < 16px is treated as a bug/stale value, not a
      // deliberate choice — anything below 16 leaves text pressed against
      // the viewport edge. Bump to the NEW default (56px). The slider
      // step is 4 so 0/4/8/12 are common off-by-one artifacts.
      const OLD_DEFAULTS = {
        width: 720,
        padTop: 48,
        padBottom: 96,
        padInline: 40,
        indent: 1.5,
      } as const;
      const migrated = { ...saved } as Record<string, unknown>;
      for (const k of Object.keys(OLD_DEFAULTS) as Array<keyof typeof OLD_DEFAULTS>) {
        if (saved[k] === OLD_DEFAULTS[k]) {
          migrated[k] = DEFAULT_SETTINGS[k];
        }
      }
      if (typeof saved.padInline === 'number' && saved.padInline < 16) {
        migrated.padInline = DEFAULT_SETTINGS.padInline;
      }
      return { ...DEFAULT_SETTINGS, ...migrated };
    }
  } catch {
    /* corrupted JSON — fall through */
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(s: ReaderSettings) {
  try {
    localStorage.setItem('epub-reader-settings', JSON.stringify(s));
  } catch {
    /**/
  }
}

export interface TtsSettings {
  speed: number;
  noise: number;
  useAI: boolean;
  emotionIntensity: number;
  voice: string;
  continuousPlay: boolean;
  paragraphGap: number;
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  speed: 1.0,
  noise: 0.667,
  useAI: false,
  emotionIntensity: 0.6,
  voice: 'Xuân Vĩnh',
  continuousPlay: false,
  paragraphGap: 0,
};

export function loadTtsSettings(): TtsSettings {
  try {
    const r = localStorage.getItem('epub-reader-tts-v1');
    if (r) {
      const parsed = JSON.parse(r) as Partial<TtsSettings>;
      const merged: TtsSettings = { ...DEFAULT_TTS_SETTINGS, ...parsed };
      if (typeof merged.speed !== 'number') merged.speed = DEFAULT_TTS_SETTINGS.speed;
      if (typeof merged.noise !== 'number') merged.noise = DEFAULT_TTS_SETTINGS.noise;
      if (typeof merged.useAI !== 'boolean') merged.useAI = DEFAULT_TTS_SETTINGS.useAI;
      if (typeof merged.emotionIntensity !== 'number') merged.emotionIntensity = DEFAULT_TTS_SETTINGS.emotionIntensity;
      if (typeof merged.voice !== 'string') merged.voice = DEFAULT_TTS_SETTINGS.voice;
      if (typeof merged.continuousPlay !== 'boolean') merged.continuousPlay = DEFAULT_TTS_SETTINGS.continuousPlay;
      if (typeof merged.paragraphGap !== 'number') merged.paragraphGap = DEFAULT_TTS_SETTINGS.paragraphGap;
      return merged;
    }
  } catch {
    /* corrupted JSON — fall through to defaults */
  }
  return DEFAULT_TTS_SETTINGS;
}

export function saveTtsSettings(s: TtsSettings) {
  try {
    localStorage.setItem('epub-reader-tts-v1', JSON.stringify(s));
  } catch {
    /**/
  }
}

export function loadBookmarks(id: string): number[] {
  try {
    const r = localStorage.getItem(`epub-bm-${id}`);
    return r ? JSON.parse(r) : [];
  } catch {
    return [];
  }
}

export function saveBookmarks(id: string, marks: number[]) {
  try {
    localStorage.setItem(`epub-bm-${id}`, JSON.stringify(marks));
  } catch {
    /**/
  }
}

export function getSpeechRecognitionCtor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function estimateReadTime(total: number, current: number): string {
  const mins = Math.max(1, Math.round((total - current) * 3));
  if (mins < 60) return `~${mins}m left`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `~${h}h ${m}m left` : `~${h}h left`;
}

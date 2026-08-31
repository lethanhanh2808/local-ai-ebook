// src/lib/tts/vieneu-voices.ts
//
// Single source of truth for the VieNeu built-in voice catalog on the TS side.
//
// The authoritative catalog lives at:
//   app/tts-service/VieNeu-TTS/src/vieneu/assets/voices_v3_turbo.json
//
// That file carries 192-dim speaker embeddings and is only consumed by the
// Python runtime — there's no TS counterpart to `_load_v3_voices()`. Re-sync
// by hand when the server catalog changes: fetch
// `${UNIFIED_TTS_URL}/voices`, then edit the `VIENEU_PROFILES` table below.

export interface VoiceProfile {
  name: string;
  gender: 'male' | 'female';
  /** Shadcn-style tone token used by scoreVoice() in voice-selector.ts. */
  tone: 'calm' | 'cheerful' | 'cold' | 'mysterious' | 'serious';
  /** Client-side heuristic for scoreVoice(). Not derived from the server JSON. */
  age: 'young' | 'mature' | 'old';
  energy: 'low' | 'medium' | 'high';
  /** One-line human description for UI lists. */
  description: string;
}

/**
 * The 12 voices currently served by `:5020/vieneu-server` after the Jul-2026
 * upstream sync + Aug-2026 user-preset add (Ngọc Ngạn + Hồng Đào). Metadata
 * is a hand-curated mirror of `voices_v3_turbo.json`.
 *
 * Server `style` → client `tone/age/energy` mapping:
 *   tự nhiên  → cheerful / young   / high
 *   kể chuyện → calm     / mature  / low
 *   tin tức   → serious  / mature  / medium
 */
export const VIENEU_PROFILES: readonly VoiceProfile[] = [
  // ── Female ────────────────────────────────────────────────────────────────
  { name: 'Trúc Ly',    gender: 'female', tone: 'cheerful', age: 'young',  energy: 'high',   description: 'Nữ — Bắc — tự nhiên' },
  { name: 'Ngọc Linh',  gender: 'female', tone: 'calm',     age: 'mature', energy: 'low',    description: 'Nữ — Bắc — kể chuyện' },
  { name: 'Đoan Trang', gender: 'female', tone: 'cheerful', age: 'young',  energy: 'high',   description: 'Nữ — Bắc — tự nhiên' },
  { name: 'Mai Anh',    gender: 'female', tone: 'serious',  age: 'mature', energy: 'medium', description: 'Nữ — Bắc — tin tức' },
  { name: 'Thục Đoan',  gender: 'female', tone: 'calm',     age: 'mature', energy: 'low',    description: 'Nữ — Nam — kể chuyện' },
  // ── Hồng Đào: user-preset enrolled 2026-08-31 from
  // reference/audio-voice-sample/Hong-Dao-(Female).wav.
  { name: 'Hồng Đào',   gender: 'female', tone: 'cheerful', age: 'mature', energy: 'high',   description: 'Nữ — Nam — tự nhiên' },
  { name: 'Thùy Dung',  gender: 'female', tone: 'serious',  age: 'mature', energy: 'medium', description: 'Nữ — Nam — tin tức' },
  { name: 'Ngọc Trân',  gender: 'female', tone: 'cheerful', age: 'young',  energy: 'high',   description: 'Nữ — Trung — tự nhiên' },
  { name: 'Mỹ Duyên',   gender: 'female', tone: 'calm',     age: 'mature', energy: 'low',    description: 'Nữ — Nam — đọc truyện' },
  { name: 'Quỳnh Anh',  gender: 'female', tone: 'calm',     age: 'mature', energy: 'low',    description: 'Nữ — Bắc — đọc truyện' },
  { name: 'Kim Thanh',  gender: 'female', tone: 'calm',     age: 'mature', energy: 'low',    description: 'Nữ — Nam — đọc truyện' },
  { name: 'Ngọc Huyền', gender: 'female', tone: 'cheerful', age: 'young',  energy: 'high',   description: 'Nữ — Bắc — tự nhiên' },
  // ── Male ──────────────────────────────────────────────────────────────────
  { name: 'Phạm Tuyên', gender: 'male',   tone: 'cheerful', age: 'young',  energy: 'high',   description: 'Nam — Bắc — tự nhiên' },
  { name: 'Xuân Vĩnh',  gender: 'male',   tone: 'cheerful', age: 'young',  energy: 'high',   description: 'Nam — Nam — tự nhiên' },
  { name: 'Thái Sơn',   gender: 'male',   tone: 'calm',     age: 'mature', energy: 'low',    description: 'Nam — Nam — kể chuyện' },
  { name: 'Thanh Bình', gender: 'male',   tone: 'calm',     age: 'mature', energy: 'low',    description: 'Nam — Bắc — kể chuyện' },
  { name: 'Minh Đức',   gender: 'male',   tone: 'serious',  age: 'mature', energy: 'medium', description: 'Nam — Bắc — tin tức' },
  // ── Ngọc Ngạn: user-preset enrolled 2026-08-31 from
  // reference/audio-voice-sample/Ngoc-Ngan-(Male).wav.
  { name: 'Ngọc Ngạn',  gender: 'male',   tone: 'cheerful', age: 'mature', energy: 'high',   description: 'Nam — Nam — tự nhiên' },
  { name: 'Minh Triết', gender: 'male',   tone: 'serious',  age: 'mature', energy: 'medium', description: 'Nam — Nam — tin tức' },
  { name: 'Quang Sơn',  gender: 'male',   tone: 'cheerful', age: 'young',  energy: 'high',   description: 'Nam — Trung — tự nhiên' },
  { name: 'Đức Trí',    gender: 'male',   tone: 'calm',     age: 'mature', energy: 'low',    description: 'Nam — Nam — đọc truyện' },
  { name: 'Adam',       gender: 'male',   tone: 'cheerful', age: 'young',  energy: 'high',   description: 'Nam — Nam — tự nhiên' },
] as const;

/** Just the name list, ordered for stable iteration. */
export const BUILTIN_VIENEU_NAMES: readonly string[] =
  VIENEU_PROFILES.map((p) => p.name);

/** Membership check for "is this a built-in preset?" (used by API + worker routes). */
export const BUILTIN_VIENEU: ReadonlySet<string> = new Set(BUILTIN_VIENEU_NAMES);

export function isBuiltinVieNeuVoice(name?: string | null): boolean {
  const value = name?.trim();
  return !!value && BUILTIN_VIENEU.has(value);
}

export function resolveBuiltinVieNeuName(name?: string | null): string | null {
  const value = name?.trim();
  return value && isBuiltinVieNeuVoice(value) ? value : null;
}

/** Gender lookup by voice name. Used for pronoun resolution in the reader. */
export const VIENEU_VOICE_GENDER: Readonly<Record<string, 'female' | 'male'>> =
  Object.fromEntries(VIENEU_PROFILES.map((p) => [p.name, p.gender]));

/**
 * Names used to back the common-voice pool (minor/crowd characters). 2F + 2M
 * for tonal variety. Each minor character cycles through these in
 * `ensureCommonVoicePool()` rather than picking a fresh voice every time.
 */
export const COMMON_POOL_BUILTINS: readonly string[] = [
  'Đoan Trang', // female, cheerful
  'Thanh Bình', // male,   calm
  'Trúc Ly',    // female, cheerful (different timbre than Đoan Trang)
  'Minh Đức',   // male,   serious
];

// ── View-model adapters for the 3 UI surfaces that render built-ins ───────

/** VoicePanel upload form: minimal {id, name, gender, tone}. */
export const VIENEU_BUILTIN_LIST: ReadonlyArray<{
  id: string;
  name: string;
  gender: 'male' | 'female';
  tone: VoiceProfile['tone'];
}> = VIENEU_PROFILES.map((p) => ({
  id: p.name,
  name: p.name,
  gender: p.gender,
  tone: p.tone,
}));

/** ReadAloudPanel dropdown: richer description rows. */
export const VIENEU_VOICES_LIST: ReadonlyArray<{
  id: string;
  label: string;
  shortLabel: string;
  gender: 'male' | 'female';
  age: VoiceProfile['age'];
  desc: string;
}> = VIENEU_PROFILES.map((p) => ({
  id: p.name,
  label: p.name,
  shortLabel: p.name,
  gender: p.gender,
  age: p.age,
  // "Nữ — trẻ, vui tươi" — short Vietnamese flavor desc, derived from
  // {gender, age, tone}. Region (Bắc/Nam) dropped: not used in picker.
  desc: descFromProfile(p),
}));

/** EbookReader top-level TTS picker: simple id+displayName pairs. */
export const VIENEU_TTS_VOICES: ReadonlyArray<{ id: string; name: string }> =
  VIENEU_PROFILES.map((p) => ({
    id: p.name,
    name: `${p.name} (${p.description})`,
  }));

function descFromProfile(p: VoiceProfile): string {
  const gendered = p.gender === 'male' ? 'Nam' : 'Nữ';
  const ageV =
    p.age === 'young' ? 'trẻ' : p.age === 'mature' ? 'trưởng thành' : 'lớn tuổi';
  const toneV =
    p.tone === 'cheerful' ? 'vui tươi'
    : p.tone === 'calm' ? 'điềm đạm'
    : p.tone === 'cold' ? 'lạnh lùng'
    : p.tone === 'serious' ? 'rõ ràng'
    : 'huyền bí';
  return `${gendered} — ${ageV}, ${toneV}`;
}

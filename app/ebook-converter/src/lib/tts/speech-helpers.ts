export function clampSpeechSpeed(value: number | string | undefined, fallback = 1): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(2, Math.max(0.5, parsed));
}

export function buildVoiceHeader(value: string | undefined, fallback = 'default'): string {
  if (!value) return fallback;
  return encodeURIComponent(value);
}

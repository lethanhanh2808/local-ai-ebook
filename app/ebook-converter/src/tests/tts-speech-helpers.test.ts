import { describe, it, expect } from 'vitest';
import { clampSpeechSpeed, buildVoiceHeader } from '@/lib/tts/speech-helpers';

describe('tts speech helpers', () => {
  it('clamps speech speed into the supported range', () => {
    expect(clampSpeechSpeed(undefined, 1.2)).toBe(1.2);
    expect(clampSpeechSpeed(0.2)).toBe(0.5);
    expect(clampSpeechSpeed(3.5)).toBe(2);
    expect(clampSpeechSpeed('1.7')).toBe(1.7);
  });

  it('keeps voice headers URL-safe for accented names', () => {
    expect(buildVoiceHeader('Nguyễn Ngọc')).toBe('Nguy%E1%BB%85n%20Ng%E1%BB%8Dc');
    expect(buildVoiceHeader('Thái Sơn')).toBe('Th%C3%A1i%20S%C6%A1n');
  });
});

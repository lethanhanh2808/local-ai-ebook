import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_DEFAULTS,
  getAiProviderDefaults,
  type AIProvider,
} from '@/lib/db/settings';

describe('AI settings centralization', () => {
  it('keeps provider defaults in one central registry', () => {
    expect(AI_PROVIDER_DEFAULTS.openai).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      needsKey: true,
    });
    expect(AI_PROVIDER_DEFAULTS['minimax-cloud']).toMatchObject({
      baseUrl: 'https://api.minimax.io/v1',
      needsKey: true,
    });
    expect(getAiProviderDefaults('custom')).toMatchObject({
      baseUrl: '',
      model: '',
      needsKey: true,
    });
  });

  it('returns a stable config for any supported provider', () => {
    (['omlx-local', 'minimax-cloud', 'openai', 'custom'] as AIProvider[]).forEach((provider) => {
      const cfg = getAiProviderDefaults(provider);
      expect(cfg).toBeTruthy();
      expect(cfg.provider).toBe(provider);
      expect(cfg.baseUrl).toBeDefined();
    });
  });
});

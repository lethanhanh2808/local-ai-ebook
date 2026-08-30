import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/auth/session';
import { canUpdateSettings, mergeEffectiveSettings, normalizeUserRole } from '@/lib/db/settings';
import { parseModelListResponse } from '@/lib/ai/provider-models';

describe('effective settings precedence', () => {
  it('prefers user overrides over app defaults', () => {
    const app = {
      aiProvider: 'openai',
      aiModel: 'gpt-4o-mini',
      aiTemperature: 0.2,
      imageProvider: 'none',
    } as any;

    const user = {
      aiProvider: 'minimax-cloud',
      aiModel: 'MiniMax-Text-01',
      imageProvider: 'openai',
    } as any;

    const effective = mergeEffectiveSettings(app, user, null);

    expect(effective.aiProvider).toBe('minimax-cloud');
    expect(effective.aiModel).toBe('MiniMax-Text-01');
    expect(effective.aiTemperature).toBe(0.2);
    expect(effective.imageProvider).toBe('openai');
  });

  it('keeps app defaults when no user override exists', () => {
    const app = {
      aiProvider: 'openai',
      aiModel: 'gpt-4o-mini',
      aiTemperature: 0.4,
    } as any;

    const effective = mergeEffectiveSettings(app, null, null);

    expect(effective.aiProvider).toBe('openai');
    expect(effective.aiModel).toBe('gpt-4o-mini');
    expect(effective.aiTemperature).toBe(0.4);
  });

  it('prefers session override over app and user defaults', () => {
    const app = { aiProvider: 'openai', aiModel: 'gpt-4o-mini', aiTemperature: 0.2 } as any;
    const user = { aiProvider: 'minimax-cloud', aiModel: 'MiniMax-Text-01', aiTemperature: 0.5 } as any;
    const session = { aiProvider: 'custom', aiModel: 'custom-model', aiTemperature: 0.8 } as any;

    const effective = mergeEffectiveSettings(app, user, session);

    expect(effective.aiProvider).toBe('custom');
    expect(effective.aiModel).toBe('custom-model');
    expect(effective.aiTemperature).toBe(0.8);
  });

  it('treats admin as the only role allowed to mutate settings', () => {
    expect(normalizeUserRole('ADMIN')).toBe('ADMIN');
    expect(normalizeUserRole('admin')).toBe('ADMIN');
    expect(normalizeUserRole('USER')).toBe('USER');
    expect(normalizeUserRole('user')).toBe('USER');
    expect(canUpdateSettings('ADMIN')).toBe(true);
    expect(canUpdateSettings('USER')).toBe(false);
    expect(canUpdateSettings(undefined)).toBe(false);
  });

  it('parses OpenAI-compatible model lists from common response shapes', () => {
    expect(parseModelListResponse({ data: [{ id: 'default' }, { id: 'gpt-4o-mini' }] })).toEqual(['default', 'gpt-4o-mini']);
    expect(parseModelListResponse({ models: [{ id: 'default' }] })).toEqual(['default']);
    expect(parseModelListResponse({ data: [{ model: 'custom-model' }] })).toEqual(['custom-model']);
  });

  it('hashes and verifies local passwords using a salted secret', async () => {
    const hashed = await hashPassword('demo-pass');

    expect(hashed).toContain(':');
    expect(await verifyPassword('demo-pass', hashed)).toBe(true);
    expect(await verifyPassword('wrong-pass', hashed)).toBe(false);
  });
});

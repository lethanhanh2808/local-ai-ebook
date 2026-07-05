// src/lib/ai/index.ts
//
// Unified AI client — picks the provider based on user settings, then routes
// the same `chat()` / `chatJSON()` calls to the right backend. Currently
// supports:
//   - OMLX (local Qwen/DeepSeek via OpenAI-compatible HTTP)
//   - MiniMax Cloud (api.minimax.io — OpenAI-compatible)
//   - OpenAI (api.openai.com)
//   - Custom (any OpenAI-compatible endpoint)
//
// Usage:
//   import { chat, chatJSON } from '@/lib/ai';
//   const text = await chat({ messages: [...] });
//
// The provider is read from the Settings table on every call so changes
// take effect immediately without restarting the server.

import { getSettings } from '@/lib/db/settings';
import type { Settings } from '@prisma/client';
import { chat as omlxChat, chatWithStats as omlxChatWithStats } from './omlx-client';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  enable_thinking?: boolean;
  timeoutMs?: number;
  messages: ChatMessage[];
}

/** Pick the best provider URL from settings. */
function endpointFor(s: Settings): { baseUrl: string; apiKey: string; model: string } {
  const provider = s.aiProvider;
  // Use empty string fallback (not "default") so the OMLX backend picks its
  // own server-side default instead of returning "Model 'default' not found".
  const model = s.aiModel?.trim() || process.env.OMLX_MODEL || '';
  const overrideBase = s.aiBaseUrl?.trim() || undefined;
  const apiKey = s.aiApiKey?.trim() || '';

  switch (provider) {
    case 'omlx-local':
      // Re-use environment / omlx-client defaults for backward compat
      return {
        baseUrl: overrideBase ?? '',
        apiKey,
        model,
      };
    case 'minimax-cloud':
      return {
        baseUrl: overrideBase ?? 'https://api.minimax.io/v1',
        apiKey,
        model,
      };
    case 'openai':
      return {
        baseUrl: overrideBase ?? 'https://api.openai.com/v1',
        apiKey,
        model,
      };
    case 'custom':
      if (!overrideBase) throw new Error('Custom AI provider requires aiBaseUrl in settings');
      return { baseUrl: overrideBase, apiKey, model };
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/** Result of an AI call including performance stats. */
export interface ChatResult {
  text: string;
  tokens: number;        // total tokens used (input + output, or output only)
  promptTokens: number;  // input tokens only (0 if not reported)
  completionTokens: number; // output tokens only (0 if not reported)
  durationMs: number;    // wall-clock time for the call
  model: string;
  /** Server-reported per-second rates (currently only OMLX emits these).
   *  When present they're more accurate than client-measured tok/s because
   *  they exclude network overhead and account for prompt evaluation time. */
  server?: {
    totalTimeSec?: number;
    timeToFirstTokenSec?: number;
    promptTokensPerSecond?: number;
    generationTokensPerSecond?: number;
  };
}

/** Make an HTTP POST to the AI provider's /chat/completions endpoint.
 *  Mirrors the request shape used by omlx-client.ts. */
async function rawChat(opts: ChatOptions, s: Settings): Promise<ChatResult> {
  const { baseUrl, apiKey, model } = endpointFor(s);
  const t0 = Date.now();

  // For OMLX (local) we delegate to the existing client — it handles the
  // optional env-driven base URL and the thinking-disable hack, and now also
  // streams + extracts usage to give us real token counts.
  if (s.aiProvider === 'omlx-local' && !s.aiBaseUrl) {
    // CRITICAL: pass the resolved model name explicitly. Without this, the
    // omlx-client falls back to process.env.OMLX_MODEL when opts.model is
    // undefined (the common case in chapter-enhancer / chapter-formatter),
    // which silently overrides the user's Settings.aiModel selection.
    const r = await omlxChatWithStats({ ...opts, model: opts.model ?? model });
    return {
      text: r.text,
      tokens: r.tokens,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      durationMs: r.durationMs || (Date.now() - t0),
      model: r.model || (opts.model ?? model),
      server: r.server,
    };
  }

  if (!apiKey) {
    throw new Error(`AI provider "${s.aiProvider}" requires an API key. Set it in /settings.`);
  }
  if (!baseUrl) {
    throw new Error(`AI provider "${s.aiProvider}" requires a base URL.`);
  }

  const body: Record<string, unknown> = {
    model: opts.model ?? model,
    temperature: opts.temperature ?? s.aiTemperature ?? 0.2,
    max_tokens: opts.max_tokens ?? s.aiMaxTokens ?? 4096,
    messages: opts.messages,
  };
  // Disable thinking for Qwen/DeepSeek reasoning models when caller asks
  if ((opts.enable_thinking ?? false) === false) {
    body.enable_thinking = false;
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const controller = new AbortController();
  // Generous default: slow local models + concurrent in-flight requests can
  // push individual calls past 3 min. 10 min default; callers can override
  // via opts.timeoutMs.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10 * 60 * 1000);

  try {
    if (process.env.AI_DEBUG === '1') process.stderr.write(`[ai] model=${body.model} url=${baseUrl}/chat/completions\n`);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      // Try to parse provider-specific error formats and extract a clean message.
      let friendly = text.slice(0, 300);
      try {
        const data = JSON.parse(text) as {
          error?: { message?: string; type?: string };
          // MiniMax / MiniMax format
          type?: string;
          request_id?: string;
        };
        // OpenAI: { error: { message, type } }
        if (data.error?.message) friendly = data.error.message;
        // MiniMax: { error: { message, type }, type, request_id }
        else if (data.error?.message) friendly = data.error.message;
        // Bare { message }
        else if ((data as { message?: string }).message) friendly = (data as { message: string }).message;
      } catch {
        // not JSON — keep raw text
      }
      throw new Error(`AI ${res.status}: ${friendly}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    };
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const totalTokens = data.usage?.total_tokens ?? (promptTokens + completionTokens);
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      durationMs: Date.now() - t0,
      model: opts.model ?? model,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Public API — chat() reads settings and routes to the right backend. */
export async function chat(opts: ChatOptions): Promise<string> {
  const s = await getSettings();
  return (await rawChat(opts, s)).text;
}

/** Like chat() but also returns performance stats (tokens, duration, model). */
export async function chatWithStats(opts: ChatOptions): Promise<ChatResult> {
  const s = await getSettings();
  return rawChat(opts, s);
}

/** Public API — chatJSON() with the same routing. */
export async function chatJSON<T>(opts: ChatOptions): Promise<T> {
  const raw = await chat({
    ...opts,
    messages: [
      ...opts.messages,
      {
        role: 'user',
        content:
          'Respond ONLY with valid JSON matching the requested schema. No explanation, no markdown code fences.',
      },
    ],
  });
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```$/m, '').trim();
  return JSON.parse(cleaned) as T;
}

// Re-export message / options types and omlx helpers for back-compat
export { chat as omlxChat } from './omlx-client';
export type { ChatMessage as LegacyChatMessage } from './omlx-client';
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

import { getAiProviderDefaults, getEffectiveSettings } from '@/lib/db/settings';
import type { Settings } from '@prisma/client';
import { chat as omlxChat, chatWithStats as omlxChatWithStats } from './omlx-client';

async function withInsecureTls<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  enable_thinking?: boolean;
  timeoutMs?: number;
  /** Number of retry attempts on transient failures (5xx, gateway timeouts,
   *  network errors, empty responses). Defaults to 2. Set to 0 to disable. */
  maxRetries?: number;
  messages: ChatMessage[];
}

/** Pick the best provider URL from settings. */
function endpointFor(s: Settings): { baseUrl: string; apiKey: string; model: string } {
  const provider = s.aiProvider;
  const defaults = getAiProviderDefaults(provider as keyof typeof import('@/lib/db/settings').AI_PROVIDER_DEFAULTS);
  const model = s.aiModel?.trim() || defaults.model;
  const overrideBase = s.aiBaseUrl?.trim();
  const apiKey = s.aiApiKey?.trim() || '';

  switch (provider) {
    case 'omlx-local':
      return {
        baseUrl: overrideBase ?? defaults.baseUrl,
        apiKey,
        model,
      };
    case 'minimax-cloud':
      return {
        baseUrl: overrideBase ?? defaults.baseUrl,
        apiKey,
        model,
      };
    case 'openai':
      return {
        baseUrl: overrideBase ?? defaults.baseUrl,
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

/**
 * Build the environment overrides to pass to the Python `character_detector.py`
 * so it uses the AI provider configured in Settings — NOT the hardcoded local
 * OMLX endpoint. The detector reads `OMLX_BASE_URL` / `OMLX_API_KEY` /
 * `OMLX_MODEL` from its environment, so we forward the effective provider's
 * base URL + key here.
 *
 * - `omlx-local`: leave `OMLX_BASE_URL` unset so the detector falls back to the
 *   deployment's `OMLX_BASE_URL` env (default `http://127.0.0.1:8080/v1`). Only
 *   forward key/model when present.
 * - cloud providers (`minimax-cloud` / `openai` / `custom`): require
 *   `aiBaseUrl` in Settings and forward it as `OMLX_BASE_URL`.
 *
 * Throws if a cloud provider is selected but no base URL is configured, so the
 * caller can return a clear 4xx/5xx instead of a confusing connection-refused
 * error from the dead local OMLX.
 */
export async function detectorEnvOverrides(sessionOverride?: Partial<Settings> | null): Promise<Record<string, string>> {
  const s = await getEffectiveSettings(undefined, sessionOverride);
  const apiKey = s.aiApiKey?.trim() ?? '';
  const model = s.aiModel?.trim() ?? '';
  // Mirror the app's `aiAllowInsecureTls` Settings flag: when set, the Python
  // detector skips TLS certificate verification (self-signed / corporate-CA
  // gateways). The chat() helper applies the same flag via NODE_TLS_REJECT_*.
  const insecureTls = s.aiAllowInsecureTls ? '1' : '';

  if (s.aiProvider === 'omlx-local') {
    const overrides: Record<string, string> = {};
    if (apiKey) overrides.OMLX_API_KEY = apiKey;
    if (model) overrides.OMLX_MODEL = model;
    if (insecureTls) overrides.OMLX_INSECURE_TLS = insecureTls;
    overrides.OMLX_MAX_TOKENS = String(maxTokensForModel(s, model));
    return overrides;
  }

  const baseUrl = s.aiBaseUrl?.trim();
  if (!baseUrl) {
    throw new Error(
      `AI provider "${s.aiProvider}" requires a base URL. Configure it in /settings.`,
    );
  }
  const overrides: Record<string, string> = {
    OMLX_BASE_URL: baseUrl,
    OMLX_API_KEY: apiKey,
    OMLX_MODEL: model,
    OMLX_MAX_TOKENS: String(maxTokensForModel(s, model)),
  };
  if (insecureTls) overrides.OMLX_INSECURE_TLS = insecureTls;
  return overrides;
}

/** Compute a safe max_tokens budget for the Python detector.
 *
 *  Reasoning models (e.g. MiniMax-M3) spend a chunk of their completion budget
 *  on internal `reasoning_content` before producing any visible answer — if
 *  the budget is too low, `content` comes back empty and the detector falls
 *  back to regex. Bump the cap when the model name hints at reasoning so the
 *  detector has enough room for both the thinking phase AND the JSON output.
 *  Honors Settings.aiMaxTokens when set; defaults to 8192.
 */
function maxTokensForModel(s: Settings, model: string): number {
  const base = (s.aiMaxTokens && s.aiMaxTokens > 0) ? s.aiMaxTokens : 8192;
  const lowered = model.toLowerCase();
  const looksLikeReasoning =
    lowered.includes('minimax') ||          // minimax-M3, MiniMax-M3, etc.
    lowered.includes('r1') ||
    lowered.includes('reasoning') ||
    lowered.includes('deepseek-r') ||
    lowered.includes('qwq');
  // Reasoning models need ~2x the completion budget so the JSON answer isn't
  // truncated mid-output. Cap at 16384 — past that the gateway can OOM.
  const adjusted = looksLikeReasoning ? Math.max(base, 8192) : base;
  return Math.max(256, Math.min(adjusted, 16384));
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

  // For OMLX (local) we ALWAYS delegate to the existing client — it
  // handles the env-driven base URL (OMLX_BASE_URL, defaults to
  // http://127.0.0.1:8080/v1) and the optional thinking-disable hack, and
  // streams + extracts usage to give us real token counts.
  //
  // We intentionally IGNORE `s.aiBaseUrl` here. If the user previously
  // selected a cloud provider (minimax/openai/custom) and switched back
  // to omlx-local without clearing the DB-stored baseUrl, the previous
  // `&& !s.aiBaseUrl` guard fell through to the generic API-key-required
  // branch and produced a misleading "omlx-local requires an API key"
  // error (when omlx itself uses the env-driven OMLX_API_KEY / 'local'
  // dummy). Routing through the client for the omlx-local provider
  // regardless of DB fields fixes that round-trip staleness — the env
  // vars are the single source of truth for omlx's URL + key.
  if (s.aiProvider === 'omlx-local') {
    // CRITICAL: pass the resolved model name explicitly. The Settings row is
    // the source of truth; legacy env fallbacks are intentionally not used to
    // override the user's configured provider/model selection.
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

  // Retry on transient upstream failures (5xx, gateway time-outs like the
  // 504 from openresty in front of MiniMax, network drops, empty responses).
  // These are intermittent — a second attempt often succeeds. We do NOT retry
  // on 4xx (auth/format errors) since those are deterministic.
  const maxRetries = opts.maxRetries ?? 2;
  let lastErr: unknown;
  try {
    if (process.env.AI_DEBUG === '1') process.stderr.write(`[ai] model=${body.model} url=${baseUrl}/chat/completions\n`);
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    };
    const insecureTls = Boolean(s.aiAllowInsecureTls);
    const fetchCall = async () => fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, requestInit);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = insecureTls ? await withInsecureTls(fetchCall) : await fetchCall();
        if (!res.ok) {
          const text = await res.text();
          // 4xx (except 408/429 which are retryable) are deterministic — don't retry.
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            let friendly = text.slice(0, 300);
            try {
              const data = JSON.parse(text) as {
                error?: { message?: string; type?: string };
                type?: string;
                request_id?: string;
              };
              if (data.error?.message) friendly = data.error.message;
              else if ((data as { message?: string }).message) friendly = (data as { message: string }).message;
            } catch { /* not JSON — keep raw text */ }
            throw new Error(`AI ${res.status}: ${friendly}`);
          }
          // 5xx / 408 / 429 → retryable
          lastErr = new Error(`AI ${res.status}: ${text.slice(0, 200)}`);
          if (attempt < maxRetries) {
            const backoff = Math.min(1000 * 2 ** attempt, 8000);
            if (process.env.AI_DEBUG === '1') process.stderr.write(`[ai] attempt ${attempt + 1} failed (${res.status}), retrying in ${backoff}ms\n`);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw lastErr;
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        };
        const content = data.choices?.[0]?.message?.content ?? '';
        // Empty/whitespace response is also a transient failure (model dropped
        // the connection mid-stream) — retry it like a 5xx.
        if (!content.trim()) {
          lastErr = new Error('AI returned empty response');
          if (attempt < maxRetries) {
            const backoff = Math.min(1000 * 2 ** attempt, 8000);
            if (process.env.AI_DEBUG === '1') process.stderr.write(`[ai] attempt ${attempt + 1} empty, retrying in ${backoff}ms\n`);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw lastErr;
        }
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;
        const totalTokens = data.usage?.total_tokens ?? (promptTokens + completionTokens);
        return {
          text: content,
          tokens: totalTokens,
          promptTokens,
          completionTokens,
          durationMs: Date.now() - t0,
          model: opts.model ?? model,
        };
      } catch (e) {
        // AbortError (our own timeout) or non-retryable 4xx → rethrow immediately.
        if (e instanceof Error && (e.name === 'AbortError' || e.message.startsWith('AI 4'))) throw e;
        lastErr = e;
        if (attempt < maxRetries) {
          const backoff = Math.min(1000 * 2 ** attempt, 8000);
          if (process.env.AI_DEBUG === '1') process.stderr.write(`[ai] attempt ${attempt + 1} threw ${e instanceof Error ? e.message : e}, retrying in ${backoff}ms\n`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    clearTimeout(timer);
  }
}

/** Public API — chat() reads settings and routes to the right backend. */
export async function chat(opts: ChatOptions): Promise<string> {
  const s = await getEffectiveSettings();
  return (await rawChat(opts, s)).text;
}

/** Like chat() but also returns performance stats (tokens, duration, model). */
export async function chatWithStats(opts: ChatOptions): Promise<ChatResult> {
  const s = await getEffectiveSettings();
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
  // Strip ```json fences defensively; emit a structured JsonChatError on
  // parse failure so callers (refreshBible, parseBiblePatches) can present
  // the raw model output to the user instead of a generic SyntaxError.
  //
  // BUGFIX 2026-07-12: also strip Qwen3-style  ̲<̲t̲h̲i̲n̲k̲>̲.̲.̲.̲<̲/̲t̲h̲i̲n̲k̲>̲  blocks. oMLX
  // routes `enable_thinking=false` to chat_template_kwargs, but the
  // underlying Qwen3-DeepSeek model still emits think blocks regardless
  // (especially for long structured-output prompts like the attribution
  // whole-chapter pass that asks the model to analyze 100+ paragraphs).
  // Without this strip the JSON.parse below fails on the first `<` token
  // and the whole batch falls back to defaults — exactly the mode in
  // Hoàng Tộc Tổ Địa ch01 ("0 via LLM, 92 voice mặc định" despite a
  // populated roster). The regex is intentionally narrow (only wrapped
  // <think>...</think> blocks, not stray XML), so JSON documents that
  // legitimately contain literal `<` characters inside string values
  // aren't accidentally truncated.
  const cleaned = raw
    .replace(/```(?:json)?\n?/g, '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    throw new JsonChatError(
      `chatJSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      cleaned,
      opts,
    );
  }
}

/** Thrown by chatJSON() when the model returns unparseable output.
 *  Carries the raw text so callers can present it (truncated) in the UI,
 *  and the original ChatOptions for log correlation. */
export class JsonChatError extends Error {
  readonly raw: string;
  readonly opts: ChatOptions;
  constructor(message: string, raw: string, opts: ChatOptions) {
    super(`${message}\n--- raw output (first 4 KB) ---\n${raw.slice(0, 4096)}`);
    this.name = 'JsonChatError';
    this.raw = raw;
    this.opts = opts;
  }
}

// (intentionally no back-compat re-exports — keep module lean; `chat` and
// `chatWithStats` are imported directly from './omlx-client' by consumers)
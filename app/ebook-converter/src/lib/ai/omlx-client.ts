// src/worker/omlx-client.ts
// Thin OpenAI-compatible client pointing at the local OMLX server.
//
// Adds:
//   - chat()              → text only (matches the OpenAI API contract)
//   - chatWithStats()     → text + token counts + duration + (if available)
//                           per-second rates for OMLX. Always uses streaming
//                           mode with stream_options.include_usage=true so
//                           OMLX emits the rich metadata at the end of the
//                           stream. Falls back to a non-streaming request if
//                           the server rejects streaming.
//
// Why streaming even though non-streaming also returns usage?
//   Streaming mode gives us OMLX-specific metrics that the non-streaming
//   response does NOT include:
//     - prompt_tokens_per_second (input tokenisation rate — "TOPS in")
//     - generation_tokens_per_second (output generation rate — "TOPS out")
//     - time_to_first_token
//     - prompt_eval_duration / generation_duration
//   These are exactly what the user wants to see for "AI generation speed".
import fetch from 'node-fetch';

// Read lazily at call-time so dotenv.config() in the worker entry-point has
// already run before these values are consumed.
function cfg() {
  return {
    baseUrl: (process.env.OMLX_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, ''),
    apiKey: process.env.OMLX_API_KEY ?? 'local',
    // Empty string fallback (not "default") — lets OMLX pick its own default
    // instead of erroring with "Model 'default' not found".
    model: process.env.OMLX_MODEL?.trim() || '',
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** Set false to disable chain-of-thought thinking (for Qwen3/DeepSeek thinking models) */
  enable_thinking?: boolean;
  /** Request timeout in ms (default: 3 minutes) */
  timeoutMs?: number;
  messages: ChatMessage[];
}

/** Extended result that captures both text + token/duration metrics. */
export interface ChatStats {
  text: string;
  /** Total tokens consumed (prompt + completion). 0 if the server didn't report any. */
  tokens: number;
  /** Input tokens (if reported). */
  promptTokens: number;
  /** Output tokens (if reported). */
  completionTokens: number;
  /** Wall-clock duration of the request (server or client). */
  durationMs: number;
  /** Model that produced the response. */
  model: string;
  /** Server-reported timings — populated only by streaming responses. */
  server?: {
    /** Total time on the server (seconds), if reported. */
    totalTimeSec?: number;
    /** Time to first token (seconds), if reported. */
    timeToFirstTokenSec?: number;
    /** Input tokens/sec (the server's "TOPS in"), if reported. */
    promptTokensPerSecond?: number;
    /** Output tokens/sec (the server's "TOPS out"), if reported. */
    generationTokensPerSecond?: number;
  };
}

export async function chat(opts: ChatOptions): Promise<string> {
  // Keep the legacy public surface stable — delegate to chatWithStats and
  // discard everything but the text. This means existing callers don't need
  // to change. Internally we get streaming for free.
  const r = await chatWithStats(opts);
  return r.text;
}

/**
 * Streaming-aware chat that returns the OMLX response text along with the
 * token counts and per-second rates (when streaming is supported).
 *
 * Strategy:
 *   1. Always request `stream: true` with `stream_options.include_usage: true`.
 *      This is the standard OpenAI streaming + usage behaviour. OMLX honours it
 *      and appends a final chunk with `usage` + extra metrics.
 *   2. If the server rejects streaming (some custom servers do), fall back to
 *      a plain non-streaming request and extract whatever `usage` it returns.
 */
export async function chatWithStats(opts: ChatOptions): Promise<ChatStats> {
  const { baseUrl, apiKey, model } = cfg();
  const modelName = opts.model ?? model;

  const body: Record<string, unknown> = {
    model: modelName,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 4096,
    messages: opts.messages,
    // Always request streaming + usage metadata. The OpenAI standard says
    // stream_options.include_usage causes a final usage-only chunk. OMLX
    // honours this and additionally returns its own per-second metrics there.
    stream: true,
    stream_options: { include_usage: true },
  };

  // Disable chain-of-thought for thinking models (Qwen3, DeepSeek-R1 etc.)
  if ((opts.enable_thinking ?? false) === false) {
    body.enable_thinking = false;
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const t0 = Date.now();
  const controller = new AbortController();
  // Generous timeout: a slow local model can take several minutes per call
  // (5-15 tok/s × ~700 output tokens ≈ 45-90 s, plus cold-start latency).
  // With concurrency=2-3 in-flight requests against the same OMLX backend,
  // queueing can push individual calls past 3 min. Use 10 min as the default
  // and still allow override via opts.timeoutMs.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10 * 60 * 1000);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal as never,
    });

    if (!res.ok || !res.body) {
      // Read the error body for diagnostics
      const errText = await res.text().catch(() => '');
      throw new Error(`OMLX request failed ${res.status}: ${errText}`);
    }

    // Parse SSE-style stream. Each line is `data: {...}` or `data: [DONE]`.
    // The final usage chunk may have an empty `choices` array with a `usage` field.
    const textDecoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let usage: Record<string, number> | null = null;
    let extra: Record<string, number> | null = null;

    // node-fetch returns a node Readable, not a web ReadableStream. The simplest
    // cross-version approach is to just read the whole body as text — OMLX
    // sends SSE lines separated by `\n\n` or `\n` and the body for normal-length
    // completions is well under a megabyte.
    const fullBody = await res.text();
    for (const line of fullBody.split('\n')) {
      const parsed = consumeLine(line, textDecoder);
      if (parsed.text) fullText += parsed.text;
      if (parsed.usage) usage = parsed.usage;
      if (parsed.extra) extra = parsed.extra;
    }

    const durationMs = Date.now() - t0;
    const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? (promptTokens + completionTokens);

    return {
      text: fullText,
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      durationMs,
      model: modelName,
      server: extra ? {
        totalTimeSec: extra.total_time,
        timeToFirstTokenSec: extra.time_to_first_token,
        promptTokensPerSecond: extra.prompt_tokens_per_second,
        generationTokensPerSecond: extra.generation_tokens_per_second,
      } : undefined,
    };
  } catch (err) {
    // Fallback: try the non-streaming request. Some custom servers don't support
    // streaming + include_usage. In that case we still want SOMETHING — better
    // than nothing.
    const isAborted = err instanceof Error && err.name === 'AbortError';
    if (!isAborted) {
      try {
        const fallback = await chatNonStreaming(opts, modelName);
        return { ...fallback, durationMs: Date.now() - t0 };
      } catch (innerErr) {
        // Re-throw original error if the fallback also fails
        throw err;
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface ParsedLine {
  text: string;
  usage: Record<string, number> | null;
  extra: Record<string, number> | null;
}

/**
 * Parse a single SSE-style chunk line and extract text + optional usage/extra
 * metadata. Returns nulls when the line isn't relevant.
 */
function consumeLine(line: string, _decoder: TextDecoder): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { text: '', usage: null, extra: null };
  // Strip leading "data:" prefix (with or without space).
  let payload = trimmed;
  if (payload.startsWith('data:')) {
    payload = payload.slice(5).trim();
  }
  if (payload === '[DONE]') return { text: '', usage: null, extra: null };
  if (!payload.startsWith('{') && !payload.startsWith('[')) {
    // Not JSON — ignore (could be SSE comments / keepalives)
    return { text: '', usage: null, extra: null };
  }
  try {
    const obj = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    let text = '';
    if (obj.choices) {
      for (const c of obj.choices) {
        if (c.delta?.content) text += c.delta.content;
        else if (c.message?.content) text += c.message.content;
      }
    }
    let usage: Record<string, number> | null = null;
    let extra: Record<string, number> | null = null;
    if (obj.usage) {
      usage = {};
      extra = {};
      for (const [k, v] of Object.entries(obj.usage)) {
        if (typeof v !== 'number') continue;
        // Token counts (prompt / completion / total) belong to the usage blob
        if (k === 'prompt_tokens' || k === 'completion_tokens' || k === 'total_tokens'
            || k === 'input_tokens' || k === 'output_tokens') {
          usage[k] = v;
        } else {
          // Speed / timing metrics are surfaced separately
          extra[k] = v;
        }
      }
      if (Object.keys(extra).length === 0) extra = null;
    }
    return { text, usage, extra };
  } catch {
    return { text: '', usage: null, extra: null };
  }
}

/** Non-streaming fallback for servers that don't support streaming + usage. */
async function chatNonStreaming(opts: ChatOptions, modelName: string): Promise<ChatStats> {
  const { baseUrl, apiKey } = cfg();
  const body: Record<string, unknown> = {
    model: modelName,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 4096,
    messages: opts.messages,
  };
  if ((opts.enable_thinking ?? false) === false) {
    body.enable_thinking = false;
    body.chat_template_kwargs = { enable_thinking: false };
  }
  const controller = new AbortController();
  // Same generous timeout as the streaming path (see chatWithStats above).
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10 * 60 * 1000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal as never,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OMLX request failed ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    let usage: Record<string, number> | null = null;
    let extra: Record<string, number> | null = null;
    if (data.usage) {
      usage = {};
      extra = {};
      for (const [k, v] of Object.entries(data.usage)) {
        if (typeof v !== 'number') continue;
        if (k === 'prompt_tokens' || k === 'completion_tokens' || k === 'total_tokens'
            || k === 'input_tokens' || k === 'output_tokens') {
          usage[k] = v;
        } else {
          extra[k] = v;
        }
      }
      if (Object.keys(extra).length === 0) extra = null;
    }
    const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? (promptTokens + completionTokens);
    return {
      text,
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      durationMs: 0, // caller will set this from its own timer
      model: modelName,
      server: extra ? {
        totalTimeSec: extra.total_time,
        timeToFirstTokenSec: extra.time_to_first_token,
        promptTokensPerSecond: extra.prompt_tokens_per_second,
        generationTokensPerSecond: extra.generation_tokens_per_second,
      } : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Helper for structured JSON responses
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

  // Strip possible markdown fences the model might add anyway
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```$/m, '').trim();
  return JSON.parse(cleaned) as T;
}

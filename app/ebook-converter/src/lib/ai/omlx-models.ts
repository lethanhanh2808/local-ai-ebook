// src/lib/ai/omlx-models.ts
//
// Shared helper: fetch + cache the live model list from the oMLX server.
//
// Why this exists:
//   - Multiple routes (characters/detect, chapters/[id]/detect-characters,
//     tts/analyze) read `settings.aiModel` and pass it to oMLX.
//   - If the user has a stale value in settings (e.g. an old session model
//     name, or a leaked Claude session id like "MiniMax-M3"), oMLX
//     responds with `Model 'X' not found` and the Python detector falls
//     into its regex-fallback branch — exactly the orphan-aiModel pattern
//     documented in the character-detection-source-tagging memory.
//   - This helper both fetches the authoritative model list (so we can
//     validate before sending) AND normalises any "ghost" model string
//     to the empty default (lets oMLX pick its server-side default).
//
// Cache strategy:
//   - TTL of 5 minutes. Models don't change often; we re-fetch on demand.
//   - Per-baseUrl cache (multi-provider setups keep separate lists).
//   - Cache survives cold-start: fetch fails fall back to env var only,
//     never throw.

interface CachedList {
  models: Set<string>;
  fetchedAt: number;
}

const CACHE: Map<string, CachedList> = new Map();
const TTL_MS = 5 * 60 * 1000;

interface ValidateOpts {
  baseUrl?: string;
  apiKey?: string;
  /** If true, skip the network call and use only env-var/cache state. */
  offlineOk?: boolean;
}

/** Return the live model id set, fetched from <baseUrl>/models.
 *  Returns an empty Set if the server is unreachable (caller can fall back
 *  to env-var / empty default). */
export async function fetchOmlxModels(opts: ValidateOpts = {}): Promise<Set<string>> {
  const baseUrl = (opts.baseUrl ?? process.env.OMLX_BASE_URL ?? 'http://127.0.0.1:8080/v1')
    .replace(/\/$/, '');
  const apiKey = opts.apiKey ?? process.env.OMLX_API_KEY ?? 'local';

  const cached = CACHE.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.models;
  }

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return cached?.models ?? new Set();
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = new Set<string>(
      (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)),
    );
    CACHE.set(baseUrl, { models: ids, fetchedAt: Date.now() });
    return ids;
  } catch {
    return cached?.models ?? new Set();
  }
}

/** Resolve a settings.aiModel string into one oMLX will accept.
 *
 *  - Empty / whitespace / "default" → empty string (OMLX picks its own default)
 *  - Known-valid model id → passed through unchanged
 *  - Unknown / stale value (e.g. "MiniMax-M3" leaked from a Claude session
 *    id, or a model that was renamed/removed) → empty string + reason flag
 *
 *  The reason flag lets the caller surface "Your /settings aiModel was
 *  invalid, so I fell back to the oMLX default" in the UI instead of
 *  silently dropping the user's choice. */
export interface ResolvedModel {
  /** The model string to pass to oMLX. Empty = "use your default". */
  model: string;
  /** Why we ended up with this value. */
  reason:
    | 'empty'
    | 'default'
    | 'env-fallback'
    | 'validated'
    | 'unknown-replaced';
  /** Original value the caller asked us to resolve (for diagnostics). */
  requested: string;
}

export async function resolveOmlxModel(
  requested: string | null | undefined,
  opts: ValidateOpts = {},
): Promise<ResolvedModel> {
  const raw = (requested ?? '').trim();
  if (!raw) return { model: '', reason: 'empty', requested: raw };
  if (raw.toLowerCase() === 'default') return { model: '', reason: 'default', requested: raw };

  // Trust the env-var fallback for callers that pass nothing meaningful
  // in settings — without it the Python detector always gets an empty
  // string and has to pick its own default.
  const envFallback = process.env.OMLX_MODEL?.trim() ?? '';

  // Quick path: if the env var is set AND matches the requested value, we
  // know it's valid (the env var can only have been set by something that
  // already verified oMLX accepts it). Skip the network call.
  if (envFallback && envFallback === raw) {
    return { model: raw, reason: 'validated', requested: raw };
  }

  const known = await fetchOmlxModels(opts);
  if (known.has(raw)) return { model: raw, reason: 'validated', requested: raw };
  if (envFallback && known.has(envFallback)) {
    return { model: envFallback, reason: 'env-fallback', requested: raw };
  }
  return { model: '', reason: 'unknown-replaced', requested: raw };
}

/** Test seam: clear the in-memory model cache. Used by unit tests. */
export function _clearOmlxModelCacheForTests(): void {
  CACHE.clear();
}
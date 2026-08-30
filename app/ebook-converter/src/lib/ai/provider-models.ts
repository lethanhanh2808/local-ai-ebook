export type ModelListPayload =
  | { data?: Array<{ id?: string; model?: string }> | null }
  | { models?: Array<{ id?: string; model?: string }> | null }
  | { object?: string; data?: Array<{ id?: string; model?: string }> | null }
  | Array<{ id?: string; model?: string }>
  | null
  | undefined;

export async function fetchJsonWithOptionalTls(url: string, opts: { apiKey?: string; method?: string; body?: string; timeoutMs?: number; allowInsecureTls?: boolean } = {}): Promise<any> {
  const requestInit: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  };
  if (opts.body !== undefined) requestInit.body = opts.body;

  const fetchCall = async () => fetch(url, requestInit);
  if (!opts.allowInsecureTls) return await fetchCall();

  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fetchCall();
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
}

export function parseModelListResponse(payload: ModelListPayload): string[] {
  if (!payload) return [];

  const items = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: Array<{ id?: string; model?: string }> }).data)
      ? (payload as { data: Array<{ id?: string; model?: string }> }).data
      : Array.isArray((payload as { models?: Array<{ id?: string; model?: string }> }).models)
        ? (payload as { models: Array<{ id?: string; model?: string }> }).models
        : [];

  const set = new Set<string>();
  for (const item of items) {
    const value = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : typeof item?.model === 'string' && item.model.trim() ? item.model.trim() : '';
    if (value) set.add(value);
  }
  return Array.from(set);
}

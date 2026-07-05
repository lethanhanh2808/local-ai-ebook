// src/lib/utils/retry.ts
// Generic retry helper with exponential backoff. Used by AI calls to recover
// from transient errors (rate limits, network timeouts, 5xx responses).

export interface RetryOptions {
  /** Maximum number of attempts (including the first). */
  maxAttempts?: number;
  /** Initial delay before retrying (ms). Default: 500. */
  initialDelayMs?: number;
  /** Backoff multiplier. Default: 2 (doubles each time). */
  backoff?: number;
  /** Cap on delay between retries (ms). Default: 30000. */
  maxDelayMs?: number;
  /** Called on each failure before sleeping — useful for logging. */
  onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void;
  /** Predicate — return false to stop retrying early. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    backoff = 2,
    maxDelayMs = 30_000,
    onRetry,
    shouldRetry = () => true,
  } = opts;

  let delay = initialDelayMs;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) break;
      onRetry?.(attempt, err, delay);
      await sleep(delay);
      delay = Math.min(maxDelayMs, Math.floor(delay * backoff));
    }
  }

  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Default predicate: retry on transient errors only (5xx, timeouts, 429).
 *  Don't retry on 4xx (client error) unless caller says so. */
export function transientErrorPredicate(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message;
  // Network / timeout
  if (/timeout|abort|econnrefused|enotfound|fetch failed/i.test(msg)) return true;
  // Rate limit
  if (/429|rate limit|too many/i.test(msg)) return true;
  // Server errors
  if (/5\d\d/i.test(msg)) return true;
  return false;
}
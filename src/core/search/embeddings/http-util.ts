/**
 * Shared, dependency-free helpers for HTTP embedding providers
 * (openai-compat, zeroentropy). Pure utilities only - no network, no
 * config knowledge - so each provider owns its own request/response
 * mapping while reusing identical batching, concurrency, backoff, and
 * unit-normalisation semantics.
 */

/** Statuses that warrant a transient retry with backoff. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Auth statuses that trigger failover to the next probe key. */
export const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** HTTP 402 Payment Required: an unconditional billing/quota exhaustion signal. */
export const PAYMENT_REQUIRED_STATUS = 402;

/** HTTP 429 Too Many Requests: a rate-limit unless the body proves quota exhaustion. */
export const RATE_LIMIT_STATUS = 429;

/** Milliseconds per second, used to convert `Retry-After` delta-seconds. */
const MS_PER_SECOND = 1000;

/**
 * Parse an HTTP `Retry-After` header value into milliseconds. The header is
 * either a non-negative integer count of seconds (RFC 7231 delta-seconds) or
 * an HTTP-date. Returns null when absent or unparseable. `nowMs` is
 * injectable so date-form parsing stays deterministic in tests.
 */
export function parseRetryAfterMs(
  headerValue: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;
  // delta-seconds form: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * MS_PER_SECOND;
  }
  // HTTP-date form: convert to a delay relative to now, floored at zero.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - nowMs;
  return delta > 0 ? delta : 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Apply ±25% jitter to a backoff base (never negative). */
export function jittered(base: number): number {
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

/** A minimal counting semaphore for bounded batch concurrency. */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];
  constructor(n: number) {
    this.permits = Math.max(1, n | 0);
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
    this.permits--;
  }
  release(): void {
    this.permits++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** Unit-normalise a vector in place so cosine similarity equals 1 - L2²/2. */
export function unitNormaliseInPlace(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/** Split an array into fixed-size chunks (step >= 1). */
export function chunkArray<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  const step = Math.max(1, size | 0);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step) as T[]);
  return out;
}

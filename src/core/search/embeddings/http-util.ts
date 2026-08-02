/**
 * Shared, dependency-free helpers for HTTP embedding providers
 * (openai-compat, zeroentropy). Pure utilities only - no network, no
 * config knowledge - so each provider owns its own request/response
 * mapping while reusing identical batching, concurrency, backoff, and
 * unit-normalisation semantics.
 */

import { SearchError } from "../types.ts";
import { assertValidVector } from "../vector-guard.ts";
import { estimateTokens } from "./signature.ts";

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

/**
 * Delay for `ms`, resolving early (never rejecting) if `signal` aborts. An
 * abort-aware sleep lets a retry backoff react to cancellation immediately
 * instead of blocking a sibling batch for up to the retry-after cap after
 * the shared abort signal fires. The caller re-checks the signal on the next
 * loop iteration to surface the cancellation.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((res) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      res();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      res();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

/**
 * Unit-normalise a vector in place so cosine similarity equals 1 - L2²/2.
 * A zero-norm or non-finite input has no meaningful unit direction, so it
 * surfaces a typed {@link SearchError} (`EMBEDDING_INVALID_VECTOR`) rather
 * than the former silent no-op that returned unnormalised zeros
 * (memory-write-path-integrity B1).
 */
export function unitNormaliseInPlace(v: number[]): number[] {
  assertValidVector(v, "unitNormalise");
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/**
 * The two batching caps, named for the operator-facing config key each one
 * carries, so a refusal says which key to change.
 */
const CAP_FIELD = Object.freeze({
  /** `embedding_batch_size`: how many items one request may carry. */
  size: "batch size",
  /** `embedding_batch_tokens`: how many estimated tokens one request may carry. */
  tokens: "token budget",
});

/**
 * Take a batching cap EXACTLY as the caller gave it, or refuse it.
 *
 * `Math.max(1, cap | 0)` used to stand at both call sites. `| 0` truncates
 * to a signed 32-bit int, so a cap above 2^31-1 wrapped NEGATIVE and the
 * clamp then lifted it to 1: the largest batch an operator can ask for
 * silently became the smallest one possible - one HTTP request per item,
 * at full `embedding_concurrency`. Nothing is truncated now, and nothing is
 * clamped: a cap this packer cannot step by is named rather than quietly
 * reinterpreted into a different request plan than the one configured.
 *
 * Both keys are already refused below 1, at a fraction, and at a
 * non-finite value by config validation (`search/index.ts`), so a resolved
 * config never reaches this guard; it holds the line for programmatic
 * callers that construct a `ResolvedEmbeddingConfig` directly.
 */
function requireBatchCap(cap: number, field: string): number {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new SearchError("INVALID_INPUT", `${field} must be an integer >= 1, got ${cap}`);
  }
  return cap;
}

/** Split an array into fixed-size chunks. Refuses a step below 1 or fractional. */
export function chunkArray<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  const step = requireBatchCap(size, CAP_FIELD.size);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step) as T[]);
  return out;
}

/**
 * Split an array into batches that close on whichever of two caps fills
 * first: the item count (`size`, i.e. `embedding_batch_size`) or the
 * accumulated token estimate (`tokenBudget`, i.e. `embedding_batch_tokens`).
 *
 * `tokenBudget` of `undefined` - the state of an unset config key - delegates
 * straight to {@link chunkArray}, so batching is byte-identical to the fixed
 * stride that preceded the budget.
 *
 * The estimate is {@link estimateTokens}, the estimator already resident in
 * this layer and already governing the indexer's cost gate, so the gate and
 * the batch budget describe the same texts identically. It deliberately
 * differs from the chunker's word-count estimator: that one sizes chunks of
 * a document, this one sizes a request. `textOf` must return the text
 * exactly as it will be sent, instruction prefix included, because the
 * provider prepends the prefix before batching and the provider's token
 * ceiling counts it.
 *
 * An item whose own estimate already exceeds the budget cannot be made to fit
 * by closing the batch around it, so it travels alone. Splitting the text
 * itself is the chunker's job, not the request packer's; dropping it would be
 * silent data loss.
 */
export function chunkArrayByTokenBudget<T>(
  arr: ReadonlyArray<T>,
  size: number,
  tokenBudget: number | undefined,
  textOf: (item: T) => string,
): T[][] {
  if (tokenBudget === undefined) return chunkArray(arr, size);
  const step = requireBatchCap(size, CAP_FIELD.size);
  const budget = requireBatchCap(tokenBudget, CAP_FIELD.tokens);
  const out: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;
  for (const item of arr) {
    const tokens = estimateTokens([textOf(item)]);
    if (current.length > 0 && (current.length >= step || currentTokens + tokens > budget)) {
      out.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += tokens;
  }
  if (current.length > 0) out.push(current);
  return out;
}

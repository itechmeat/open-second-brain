/**
 * Shared, dependency-free helpers for HTTP embedding providers
 * (openai-compat, zeroentropy). Pure utilities only - no network, no
 * config knowledge - so each provider owns its own request/response
 * mapping while reusing identical batching, concurrency, backoff, and
 * unit-normalisation semantics.
 *
 * {@link Semaphore} is the one exception to "embedding providers": it is
 * the search layer's only concurrency limiter, and the recall benchmark
 * bounds its query fan-out with it too rather than growing a second one.
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

/**
 * The three caps this module enforces, named for the operator-facing
 * config key each one carries, so a refusal says which key to change.
 */
const CAP_FIELD = Object.freeze({
  /** `embedding_batch_size`: how many items one request may carry. */
  size: "batch size",
  /** `embedding_batch_tokens`: how many estimated tokens one request may carry. */
  tokens: "token budget",
  /** `embedding_concurrency`: how many requests may be in flight at once. */
  concurrency: "concurrency ceiling",
});

/**
 * Take a cap EXACTLY as the caller gave it, or refuse it.
 *
 * `Math.max(1, cap | 0)` used to stand at every call site. `| 0` truncates
 * to a signed 32-bit int, so a cap above 2^31-1 wrapped NEGATIVE and the
 * clamp then lifted it to 1: the largest batch - or the widest concurrency
 * ceiling - an operator can ask for silently became the smallest one
 * possible. Nothing is truncated now, and nothing is clamped: a cap this
 * module cannot honour is named rather than quietly reinterpreted into a
 * different request plan than the one configured.
 *
 * All three keys are already refused below 1, at a fraction, and at a
 * non-finite value by config validation (`search/index.ts`), so a resolved
 * config never reaches this guard; it holds the line for programmatic
 * callers that construct a `ResolvedEmbeddingConfig` directly.
 */
function requireCap(cap: number, field: string): number {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new SearchError("INVALID_INPUT", `${field} must be an integer >= 1, got ${cap}`);
  }
  return cap;
}

/**
 * One permit, handed to the acquirer that holds it. Calling it gives the
 * permit back; calling it a second time raises, because the second call
 * is a release of something the caller no longer holds.
 */
export type SemaphorePermit = () => void;

/**
 * A minimal counting semaphore for bounded concurrency.
 *
 * Giving a permit back hands it DIRECTLY to the head of the waiter queue
 * instead of returning it to the pool for the woken waiter to claim
 * later. The pool form over-subscribes by one for every wakeup: between
 * the `permits++` and the waiter's continuation there is a microtask in
 * which a fresh `acquire()` sees a free permit and takes it, and the
 * waiter then decrements past zero. Both run, and the ceiling reads one
 * higher than configured. With a hand-off the permit is never observable
 * as free, so the invariant holds for any interleaving.
 *
 * ## Why a permit rather than a `release()` method
 *
 * An over-release is a CALLER DEFECT, not an input: nothing an operator
 * configures can produce one, only code that gives back a permit it never
 * took or gives one back twice. So it is refused loudly rather than
 * clamped - a clamp would leave the defective call site running, and the
 * whole point of this object is that the number of requests on the wire
 * is the configured number and not a number that drifted.
 *
 * Refusing needs the holder's own record, which is what makes the permit
 * a value instead of a method:
 *
 *   - `if (permits >= limit) throw` cannot see the case that matters.
 *     With a waiter queued the pool count is 0, so a stray release passes
 *     that test and is handed straight to the waiter: one more holder
 *     than the ceiling, and no counter moved.
 *   - `if (held === 0) throw` misses the same case for the same reason.
 *   - A one-shot permit closure decides it locally: the second call knows
 *     it is the second call, whatever the pool and queue happen to hold,
 *     and code that never acquired has nothing to call.
 *
 * That also repairs the instrument. {@link peakInFlight} counts entries
 * and matched exits ONLY, so it can no longer be driven below the truth
 * by the very releases that break the bound - the failure mode where a
 * ceiling of 2 ran 4 real holders and the counter still reported 2
 * (nothing-runs-unwatched review, C4). A bound nothing can observe is a
 * bound nothing can verify, and a counter the breach silences is worse
 * than none.
 *
 * The ceiling is process-wide and shared between callers
 * (`provider-semaphore.ts`), so one caller's stray release would widen
 * the ceiling for every other caller against the same provider. That is
 * why the guard lives here rather than at any one call site.
 */
export class Semaphore {
  /** The ceiling enforced here: the permit count when nothing is held. */
  readonly limit: number;
  private permits: number;
  private held = 0;
  private peak = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(limit: number) {
    this.limit = requireCap(limit, CAP_FIELD.concurrency);
    this.permits = this.limit;
  }
  /**
   * Most permits held at once since construction. Every increment is an
   * acquirer that entered and every decrement is that acquirer's own
   * permit coming back, so this is the true high-water mark of holders -
   * and never above `limit`, as a consequence rather than a coincidence.
   */
  get peakInFlight(): number {
    return this.peak;
  }
  private enter(): SemaphorePermit {
    this.held++;
    if (this.held > this.peak) this.peak = this.held;
    let spent = false;
    return (): void => {
      if (spent) {
        throw new SearchError(
          "INVALID_INPUT",
          `semaphore permit released twice (ceiling ${this.limit}): a second release ` +
            `returns a permit this caller no longer holds and widens the ceiling for ` +
            `every caller sharing it`,
        );
      }
      spent = true;
      this.leave();
    };
  }
  private leave(): void {
    this.held--;
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.permits++;
  }
  /** Take a permit, waiting for one; call the result once to give it back. */
  async acquire(): Promise<SemaphorePermit> {
    if (this.permits > 0) {
      this.permits--;
      return this.enter();
    }
    // The releaser transfers its permit to this waiter, so the resumed
    // acquirer must NOT decrement `permits` again.
    await new Promise<void>((res) => this.waiters.push(res));
    return this.enter();
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

/** Split an array into fixed-size chunks. Refuses a step below 1 or fractional. */
export function chunkArray<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  const step = requireCap(size, CAP_FIELD.size);
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
  const step = requireCap(size, CAP_FIELD.size);
  const budget = requireCap(tokenBudget, CAP_FIELD.tokens);
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

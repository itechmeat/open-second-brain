/**
 * OpenAI-compatible `/v1/embeddings` provider.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §11.
 *
 * Network rules:
 *   - One concurrent batch per semaphore slot (`embedding_concurrency`).
 *   - Each batch contains up to `embedding_batch_size` texts.
 *   - Per-request timeout: `embedding_timeout_ms`.
 *   - Retry on `429`, `5xx`, and network/timeout errors with exponential
 *     backoff `1s/2s` (+ ±25% jitter), three attempts total. Other 4xx
 *     fail fast.
 *   - Vectors are unit-normalised so cosine similarity equals
 *     `1 - L2² / 2` (see ranker).
 *
 * Provider-shaped, never-prompt-shaped errors. The caller decides
 * whether to surface (`--semantic`) or warn (implicit).
 */

import { EMBEDDING_QUOTA_MESSAGE, SearchError } from "../types.ts";
import type { EmbeddingErrorCategory, ResolvedEmbeddingConfig } from "../types.ts";
import type { EmbeddingProvider, EmbedKind } from "./contract.ts";
import {
  AUTH_STATUSES,
  PAYMENT_REQUIRED_STATUS,
  RATE_LIMIT_STATUS,
  RETRYABLE_STATUSES,
  Semaphore,
  chunkArray,
  jittered,
  parseRetryAfterMs,
  sleep,
  unitNormaliseInPlace,
} from "./http-util.ts";

/**
 * Sentinel embedded in a synthetic error message when a batch is cancelled
 * by the parent abort controller. A cancelled batch must never be retried:
 * the outer `Promise.all` already gave up on it.
 */
const CANCELLED_SENTINEL = "embed cancelled";

/** Max characters of an error response body echoed into the thrown message. */
const ERROR_BODY_HEAD_LEN = 300;

/** Fallback backoff base (ms) when the configured schedule runs out. */
const DEFAULT_BACKOFF_MS = 4000;

/**
 * Upper bound (ms) on how long a provider `Retry-After` is honored before a
 * retry (Task C2). A cooperative reindex should pause for a short provider
 * hint, but a multi-minute Retry-After would stall the run; past this cap we
 * still wait the cap rather than the raw hint. 30s balances respecting the
 * provider against keeping an interactive reindex responsive.
 */
export const RETRY_AFTER_CAP_MS = 30_000;

/**
 * Delay (ms) before the next retry of a just-failed attempt (1-based
 * `attempt`). When the provider supplied a `Retry-After`, honor it capped at
 * `capMs`; otherwise use the configured exponential backoff with jitter.
 */
export function computeRetryDelayMs(
  retryAfterMs: number | null,
  attempt: number,
  backoffMs: ReadonlyArray<number>,
  capMs: number,
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, capMs);
  const base = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? DEFAULT_BACKOFF_MS;
  return jittered(base);
}

/**
 * OpenAI-compatible provider error `code`/`type` values that denote quota /
 * billing exhaustion. These are wire-protocol identifiers, not natural
 * language, so matching them is deterministic and provider-portable.
 */
const QUOTA_ERROR_TOKENS: ReadonlySet<string> = new Set(["insufficient_quota"]);

/** Prefix forms of quota tokens (e.g. `billing_hard_limit_reached`). */
const QUOTA_ERROR_TOKEN_PREFIXES: ReadonlyArray<string> = ["billing"];

function safeParseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isQuotaToken(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.toLowerCase();
  if (QUOTA_ERROR_TOKENS.has(v)) return true;
  return QUOTA_ERROR_TOKEN_PREFIXES.some((prefix) => v.startsWith(prefix));
}

/**
 * True when a parsed provider error body carries protocol-token evidence of
 * quota exhaustion in its `error.code`/`error.type` (or top-level `code`/
 * `type`) fields. Inspects structured fields only, never prose.
 */
function bodyHasQuotaEvidence(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  const err = obj["error"];
  if (err !== null && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (isQuotaToken(e["code"]) || isQuotaToken(e["type"])) return true;
  }
  return isQuotaToken(obj["code"]) || isQuotaToken(obj["type"]);
}

/** Classification of an embedding-provider error (Task C1). */
export interface EmbeddingErrorClassification {
  readonly category: EmbeddingErrorCategory;
  readonly retriable: boolean;
  readonly retryAfterMs: number | null;
  readonly error: SearchError;
}

/**
 * Classify an embedding-provider error into a coarse category plus retry
 * policy, reading the structured `status`/`retryAfterMs` fields carried on
 * the {@link SearchError} - never re-parsing the message string. Non-quota
 * behaviour matches the pre-C1 retry semantics: 5xx / timeout / network
 * retry, 4xx (except quota) fail fast, 401/403 stay non-retriable so the
 * caller's key failover engages.
 */
export function classifyEmbeddingError(e: unknown): EmbeddingErrorClassification {
  if (e instanceof SearchError) {
    if (e.message.includes(CANCELLED_SENTINEL)) {
      return { category: "fatal", retriable: false, retryAfterMs: null, error: e };
    }
    if (e.code === "EMBEDDING_QUOTA_EXHAUSTED") {
      return {
        category: "quota",
        retriable: false,
        retryAfterMs: e.retryAfterMs ?? null,
        error: e,
      };
    }
    if (e.code === "EMBEDDING_PROVIDER_TIMEOUT") {
      return { category: "transient", retriable: true, retryAfterMs: null, error: e };
    }
    if (e.code === "EMBEDDING_PROVIDER_HTTP") {
      const status = e.status;
      const retryAfterMs = e.retryAfterMs ?? null;
      if (status !== undefined) {
        if (AUTH_STATUSES.has(status)) {
          return { category: "auth", retriable: false, retryAfterMs, error: e };
        }
        if (status === RATE_LIMIT_STATUS) {
          return { category: "rate_limit", retriable: true, retryAfterMs, error: e };
        }
        if (RETRYABLE_STATUSES.has(status)) {
          // 429 is handled above, so the remaining retryable statuses are 5xx.
          return { category: "transient", retriable: true, retryAfterMs, error: e };
        }
        // Any other explicit HTTP status (e.g. 400) fails fast.
        return { category: "fatal", retriable: false, retryAfterMs, error: e };
      }
      // No status attached = network error: retry as transient.
      return { category: "transient", retriable: true, retryAfterMs, error: e };
    }
    return { category: "fatal", retriable: false, retryAfterMs: null, error: e };
  }
  return {
    category: "fatal",
    retriable: false,
    retryAfterMs: null,
    error: new SearchError("EMBEDDING_PROVIDER_HTTP", String(e)),
  };
}

interface OpenAiEmbeddingResponse {
  readonly data: ReadonlyArray<{
    readonly embedding: ReadonlyArray<number>;
    readonly index: number;
  }>;
  readonly model?: string;
}

interface ResolvedHttp {
  readonly url: string;
  readonly apiKey: string;
}

function resolveHttp(config: ResolvedEmbeddingConfig): ResolvedHttp {
  if (!config.baseUrl) {
    throw new SearchError(
      "INVALID_INPUT",
      "embedding_base_url is required when semantic is enabled",
    );
  }
  if (!config.model) {
    throw new SearchError("INVALID_INPUT", "embedding_model is required when semantic is enabled");
  }
  if (!config.apiKey) {
    throw new SearchError(
      "EMBEDDING_KEY_MISSING",
      "embedding_api_key is required when semantic is enabled",
    );
  }
  const base = config.baseUrl.replace(/\/+$/, "");
  return { url: `${base}/embeddings`, apiKey: config.apiKey };
}

/**
 * Ordered API-key failover list. Uses `config.apiKeys` when present and
 * non-empty, otherwise the single resolved key. `resolveHttp` has already
 * guaranteed a non-empty first key, so the list is never empty.
 */
function resolveKeys(config: ResolvedEmbeddingConfig, fallbackKey: string): string[] {
  const list = (config.apiKeys ?? []).map((k) => k.trim()).filter((k) => k !== "");
  return list.length > 0 ? list : [fallbackKey];
}

export interface OpenAICompatProviderOptions {
  /** Override default `[1000, 2000]` ms backoffs (used by tests). */
  readonly backoffMs?: ReadonlyArray<number>;
}

export class OpenAICompatProvider implements EmbeddingProvider {
  readonly name = "openai-compat";
  readonly model: string;
  private _dimension: number | null;
  private readonly config: ResolvedEmbeddingConfig;
  private readonly http: ResolvedHttp;
  private readonly backoffMs: ReadonlyArray<number>;
  /** Ordered probe keys; `activeKeyIndex` pins the first that authenticates. */
  private readonly keys: ReadonlyArray<string>;
  private activeKeyIndex = 0;

  constructor(config: ResolvedEmbeddingConfig, opts?: OpenAICompatProviderOptions) {
    this.config = config;
    this.http = resolveHttp(config);
    this.model = config.model!;
    this._dimension = config.dimension;
    this.backoffMs = opts?.backoffMs ?? [1000, 2000];
    this.keys = resolveKeys(config, this.http.apiKey);
  }

  private get activeKey(): string {
    return this.keys[this.activeKeyIndex] ?? this.http.apiKey;
  }

  get dimension(): number | null {
    return this._dimension;
  }

  /**
   * Resolve the instruction prefix for an embed `kind`
   * (memory-write-path-integrity B2). No kind, or an empty configured prefix,
   * yields no prefix so the sent text is byte-identical to pre-feature runs.
   */
  private prefixFor(kind?: EmbedKind): string {
    if (kind === "query") return this.config.queryPrefix ?? "";
    if (kind === "passage") return this.config.passagePrefix ?? "";
    return "";
  }

  async embed(texts: ReadonlyArray<string>, kind?: EmbedKind): Promise<number[][]> {
    if (texts.length === 0) return [];
    const prefix = this.prefixFor(kind);
    const prepared = prefix === "" ? texts : texts.map((t) => prefix + t);
    const batches = chunkArray(
      prepared.map((t, i) => ({ text: t, originalIndex: i })),
      this.config.batchSize,
    );
    const sem = new Semaphore(this.config.concurrency);
    const out: number[][] = new Array(texts.length);

    // Shared abort controller cancels in-flight siblings and skips
    // queued ones the moment any batch fails. Without this, a 4xx on
    // batch #1 still bills the remaining N-1 batches that were already
    // scheduled by Promise.all.
    const cancel = new AbortController();

    const tasks = batches.map(async (batch) => {
      await sem.acquire();
      try {
        if (cancel.signal.aborted) return;
        const vectors = await this.embedBatchWithRetry(
          batch.map((b) => b.text),
          {
            maxAttempts: this.config.maxRetries,
            parentSignal: cancel.signal,
          },
        );
        for (let i = 0; i < vectors.length; i++) {
          out[batch[i]!.originalIndex] = vectors[i]!;
        }
      } finally {
        sem.release();
      }
    });

    try {
      // Promise.all rejects on first rejection. Abort siblings so they
      // don't keep hitting the provider; then await the cancelled tasks
      // via allSettled to avoid unhandled-rejection warnings.
      try {
        await Promise.all(tasks);
      } catch (firstError) {
        cancel.abort();
        await Promise.allSettled(tasks);
        if (firstError instanceof SearchError) throw firstError;
        throw new SearchError("EMBEDDING_PROVIDER_HTTP", String(firstError));
      }
    } finally {
      // No-op if already settled; keeps semaphore + listeners cleaned up.
      cancel.abort();
    }
    return out;
  }

  async ping(): Promise<{ ok: true; dimension: number } | { ok: false; reason: string }> {
    try {
      const vectors = await this.embedBatchWithRetry(["check"], { maxAttempts: 1 });
      const v = vectors[0];
      if (!v) return { ok: false, reason: "empty response" };
      return { ok: true, dimension: v.length };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason };
    }
  }

  /**
   * Embed one batch with transient-retry AND multi-key failover: run the
   * active key through the full transient-retry budget; on an auth error
   * (HTTP 401/403) advance to the next probe key and retry, pinning the
   * first key that authenticates. Bounded by the number of keys, so a
   * fully-invalid probe list terminates and surfaces the auth error. With
   * a single key the outer loop runs once - byte-identical to before.
   */
  private async embedBatchWithRetry(
    texts: string[],
    opts?: { maxAttempts?: number; parentSignal?: AbortSignal },
  ): Promise<number[][]> {
    let lastError: SearchError | null = null;
    for (let keyAttempt = 0; keyAttempt < this.keys.length; keyAttempt++) {
      const usedKeyIndex = this.activeKeyIndex;
      try {
        return await this.embedBatchOnKey(texts, opts);
      } catch (e) {
        const err =
          e instanceof SearchError ? e : new SearchError("EMBEDDING_PROVIDER_HTTP", String(e));
        lastError = err;
        if (!this.isAuthError(err)) throw err;
        if (usedKeyIndex === this.activeKeyIndex && this.activeKeyIndex < this.keys.length - 1) {
          // We are the first to see this key fail; advance to the next.
          this.activeKeyIndex++;
        } else if (this.activeKeyIndex <= usedKeyIndex) {
          // No further key to fail over to; surface the auth error.
          throw err;
        }
        // Otherwise a concurrent batch already advanced the key; retry with it.
      }
    }
    throw lastError ?? new SearchError("EMBEDDING_PROVIDER_HTTP", "key failover exhausted");
  }

  private isAuthError(e: SearchError): boolean {
    return (
      e.code === "EMBEDDING_PROVIDER_HTTP" && e.status !== undefined && AUTH_STATUSES.has(e.status)
    );
  }

  private async embedBatchOnKey(
    texts: string[],
    opts?: { maxAttempts?: number; parentSignal?: AbortSignal },
  ): Promise<number[][]> {
    const maxAttempts = opts?.maxAttempts ?? 3;
    let lastError: SearchError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts?.parentSignal?.aborted) {
        throw new SearchError("EMBEDDING_PROVIDER_HTTP", CANCELLED_SENTINEL);
      }
      try {
        return await this.embedBatchOnce(texts, opts?.parentSignal);
      } catch (e) {
        const cls = classifyEmbeddingError(e);
        if (!cls.retriable || attempt >= maxAttempts) throw cls.error;
        lastError = cls.error;
        this.retriesSeen++;
        const wait = computeRetryDelayMs(
          cls.retryAfterMs,
          attempt,
          this.backoffMs,
          RETRY_AFTER_CAP_MS,
        );
        await sleep(wait, opts?.parentSignal);
      }
    }
    throw lastError ?? new SearchError("EMBEDDING_PROVIDER_HTTP", "retry loop exhausted");
  }

  /** Retries since construction; `consumeRetryCount()` resets the tally. */
  retriesSeen = 0;

  /** Read-and-reset retry counter — indexer uses this to populate IndexStats. */
  consumeRetryCount(): number {
    const n = this.retriesSeen;
    this.retriesSeen = 0;
    return n;
  }

  private async embedBatchOnce(texts: string[], parentSignal?: AbortSignal): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onParentAbort = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    let response: Response;
    try {
      response = await fetch(this.http.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.activeKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          encoding_format: "float",
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const cause = e instanceof Error ? e : new Error(String(e));
      if (cause.name === "AbortError") {
        if (parentSignal?.aborted) {
          throw new SearchError("EMBEDDING_PROVIDER_HTTP", CANCELLED_SENTINEL);
        }
        throw new SearchError(
          "EMBEDDING_PROVIDER_TIMEOUT",
          `embedding request timed out after ${this.config.timeoutMs}ms`,
        );
      }
      throw new SearchError("EMBEDDING_PROVIDER_HTTP", `network error: ${cause.message}`);
    } finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const head = body.slice(0, ERROR_BODY_HEAD_LEN);
      const status = response.status;
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? undefined;
      const parsed = safeParseJson(body);
      const isQuota =
        status === PAYMENT_REQUIRED_STATUS ||
        (status === RATE_LIMIT_STATUS && bodyHasQuotaEvidence(parsed));
      if (isQuota) {
        throw new SearchError("EMBEDDING_QUOTA_EXHAUSTED", EMBEDDING_QUOTA_MESSAGE, {
          status,
          retryAfterMs,
        });
      }
      throw new SearchError(
        "EMBEDDING_PROVIDER_HTTP",
        `embedding HTTP ${status}: ${head || response.statusText}`,
        { status, retryAfterMs },
      );
    }

    let json: OpenAiEmbeddingResponse;
    try {
      json = (await response.json()) as OpenAiEmbeddingResponse;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SearchError("EMBEDDING_PROVIDER_HTTP", `embedding response not JSON: ${msg}`);
    }

    if (!Array.isArray(json.data) || json.data.length !== texts.length) {
      throw new SearchError(
        "EMBEDDING_PROVIDER_HTTP",
        `embedding response shape: expected ${texts.length} vectors, got ${json.data?.length ?? "none"}`,
      );
    }

    const ordered: number[][] = new Array(texts.length);
    for (const item of json.data) {
      if (typeof item.index !== "number" || item.index < 0 || item.index >= texts.length) {
        throw new SearchError(
          "EMBEDDING_PROVIDER_HTTP",
          `embedding response: out-of-range index ${item.index}`,
        );
      }
      if (!Array.isArray(item.embedding)) {
        throw new SearchError(
          "EMBEDDING_PROVIDER_HTTP",
          `embedding response: data[${item.index}].embedding is not an array`,
        );
      }
      const arr = (item.embedding as ReadonlyArray<number>).slice();
      if (this._dimension === null) {
        this._dimension = arr.length;
      } else if (this._dimension !== arr.length) {
        throw new SearchError(
          "EMBEDDING_DIMENSION_MISMATCH",
          `embedding dimension changed mid-batch: expected ${this._dimension}, got ${arr.length}`,
        );
      }
      ordered[item.index] = unitNormaliseInPlace(arr);
    }
    for (let i = 0; i < ordered.length; i++) {
      if (!Array.isArray(ordered[i])) {
        throw new SearchError(
          "EMBEDDING_PROVIDER_HTTP",
          `embedding response: missing vector for index ${i}`,
        );
      }
    }
    return ordered;
  }
}

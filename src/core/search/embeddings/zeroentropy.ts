/**
 * Native ZeroEntropy embedding provider (Retrieval & Ranking Quality).
 *
 * Calls the ZeroEntropy native embed API (`POST {base}/models/embed`)
 * directly over `fetch` - no SDK, no new dependency - instead of routing
 * through the OpenAI-compatible wrapper. Request/response shape per the
 * ZeroEntropy API reference:
 *
 *   request:  { model, input_type, input: string[], encoding_format, dimensions? }
 *   response: { results: [{ embedding: number[] }, ...], usage? }
 *
 * `results` preserves input order (there is no per-item index field), so
 * vectors map positionally. Network discipline mirrors the OpenAI-compat
 * provider: bounded concurrency, per-request timeout, retry on 429/5xx and
 * network/timeout with jittered backoff, vectors unit-normalised so cosine
 * equals 1 - L2²/2.
 *
 * The interface is symmetric (one `embed`), so `input_type` is fixed to
 * "document" - consistent with how OSB treats query and passage embeddings
 * uniformly across every provider.
 */

import { SearchError } from "../types.ts";
import type { ResolvedEmbeddingConfig } from "../types.ts";
import type { EmbeddingProvider } from "./provider.ts";
import {
  RETRYABLE_STATUSES,
  Semaphore,
  chunkArray,
  jittered,
  sleep,
  unitNormaliseInPlace,
} from "./http-util.ts";

const ZEROENTROPY_INPUT_TYPE = "document";

interface ZeroEntropyEmbeddingResponse {
  readonly results: ReadonlyArray<{ readonly embedding: ReadonlyArray<number> }>;
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
  return { url: `${base}/models/embed`, apiKey: config.apiKey };
}

export interface ZeroEntropyProviderOptions {
  /** Override default `[1000, 2000]` ms backoffs (used by tests). */
  readonly backoffMs?: ReadonlyArray<number>;
}

export class ZeroEntropyProvider implements EmbeddingProvider {
  readonly name = "zeroentropy";
  readonly model: string;
  private _dimension: number | null;
  private readonly config: ResolvedEmbeddingConfig;
  private readonly http: ResolvedHttp;
  private readonly backoffMs: ReadonlyArray<number>;
  private retriesSeen = 0;

  constructor(config: ResolvedEmbeddingConfig, opts?: ZeroEntropyProviderOptions) {
    this.config = config;
    this.http = resolveHttp(config);
    this.model = config.model!;
    this._dimension = config.dimension;
    this.backoffMs = opts?.backoffMs ?? [1000, 2000];
  }

  get dimension(): number | null {
    return this._dimension;
  }

  consumeRetryCount(): number {
    const n = this.retriesSeen;
    this.retriesSeen = 0;
    return n;
  }

  async embed(texts: ReadonlyArray<string>): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batches = chunkArray(
      texts.map((t, i) => ({ text: t, originalIndex: i })),
      this.config.batchSize,
    );
    const sem = new Semaphore(this.config.concurrency);
    const out: number[][] = new Array(texts.length);
    const cancel = new AbortController();

    const tasks = batches.map(async (batch) => {
      await sem.acquire();
      try {
        if (cancel.signal.aborted) return;
        const vectors = await this.embedBatchWithRetry(
          batch.map((b) => b.text),
          { parentSignal: cancel.signal },
        );
        for (let i = 0; i < vectors.length; i++) {
          out[batch[i]!.originalIndex] = vectors[i]!;
        }
      } finally {
        sem.release();
      }
    });

    try {
      try {
        await Promise.all(tasks);
      } catch (firstError) {
        cancel.abort();
        await Promise.allSettled(tasks);
        if (firstError instanceof SearchError) throw firstError;
        throw new SearchError("EMBEDDING_PROVIDER_HTTP", String(firstError));
      }
    } finally {
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

  private async embedBatchWithRetry(
    texts: string[],
    opts?: { maxAttempts?: number; parentSignal?: AbortSignal },
  ): Promise<number[][]> {
    const maxAttempts = opts?.maxAttempts ?? 3;
    let lastError: SearchError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts?.parentSignal?.aborted) {
        throw new SearchError("EMBEDDING_PROVIDER_HTTP", "embed cancelled");
      }
      try {
        return await this.embedBatchOnce(texts, opts?.parentSignal);
      } catch (e) {
        const err = this.classifyError(e);
        if (!err.retriable || attempt >= maxAttempts) throw err.error;
        lastError = err.error;
        this.retriesSeen++;
        const wait = jittered(
          this.backoffMs[attempt - 1] ?? this.backoffMs[this.backoffMs.length - 1] ?? 4000,
        );
        await sleep(wait);
      }
    }
    throw lastError ?? new SearchError("EMBEDDING_PROVIDER_HTTP", "retry loop exhausted");
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
          authorization: `Bearer ${this.http.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input_type: ZEROENTROPY_INPUT_TYPE,
          input: texts,
          encoding_format: "float",
          ...(this._dimension !== null ? { dimensions: this._dimension } : {}),
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const cause = e instanceof Error ? e : new Error(String(e));
      if (cause.name === "AbortError") {
        if (parentSignal?.aborted) {
          throw new SearchError("EMBEDDING_PROVIDER_HTTP", "embed cancelled");
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
      const head = body.slice(0, 300);
      throw new SearchError(
        "EMBEDDING_PROVIDER_HTTP",
        `embedding HTTP ${response.status}: ${head || response.statusText}`,
      );
    }

    let json: ZeroEntropyEmbeddingResponse;
    try {
      json = (await response.json()) as ZeroEntropyEmbeddingResponse;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SearchError("EMBEDDING_PROVIDER_HTTP", `embedding response not JSON: ${msg}`);
    }

    if (!Array.isArray(json.results) || json.results.length !== texts.length) {
      throw new SearchError(
        "EMBEDDING_PROVIDER_HTTP",
        `embedding response shape: expected ${texts.length} vectors, got ${json.results?.length ?? "none"}`,
      );
    }

    const ordered: number[][] = new Array(texts.length);
    for (let i = 0; i < json.results.length; i++) {
      const item = json.results[i]!;
      if (!Array.isArray(item.embedding)) {
        throw new SearchError(
          "EMBEDDING_PROVIDER_HTTP",
          `embedding response: results[${i}].embedding is not an array`,
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
      ordered[i] = unitNormaliseInPlace(arr);
    }
    return ordered;
  }

  private classifyError(e: unknown): { retriable: boolean; error: SearchError } {
    if (e instanceof SearchError) {
      if (e.message.includes("embed cancelled")) return { retriable: false, error: e };
      if (e.code === "EMBEDDING_PROVIDER_TIMEOUT") return { retriable: true, error: e };
      if (e.code === "EMBEDDING_PROVIDER_HTTP") {
        const m = e.message.match(/HTTP (\d+)/);
        if (m) return { retriable: RETRYABLE_STATUSES.has(Number(m[1])), error: e };
        return { retriable: true, error: e };
      }
      return { retriable: false, error: e };
    }
    return { retriable: false, error: new SearchError("EMBEDDING_PROVIDER_HTTP", String(e)) };
  }
}

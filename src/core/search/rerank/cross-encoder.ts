/**
 * OpenAI-compatible cross-encoder rerank provider
 * (retrieval-precision-quality-loop, card A / t_110867f5).
 *
 * Calls a `{base_url}/rerank` endpoint — the shape Cohere, Jina,
 * text-embeddings-inference, and vLLM's rerank route share — with
 * `{ model, query, documents }` and reads one relevance score per
 * document back. Both the wrapped `{ results: [{ index, relevance_score }] }`
 * shape and the bare `[{ index, score }]` array shape are accepted, so a
 * single provider works across compatible backends.
 *
 * Network rules mirror `embeddings/openai-compat.ts` at a smaller scale:
 * one request (the top-K candidate set is small, no batching), a
 * per-request timeout, and provider-shaped `SearchError`s. Retries are
 * intentionally omitted: this is an opt-in final reader step that
 * degrades gracefully to the heuristic ordering on ANY failure (see
 * `applyCrossEncoderRerank`), so a slow retry loop would only add latency
 * to the hot path for a result the caller already has a good answer for.
 */

import { SearchError } from "../types.ts";
import type { OpenAiCompatEndpoint } from "../embeddings/provider-resolve.ts";
import type { RerankProvider } from "./contract.ts";

/** Default per-request timeout when the caller does not override it. */
export const DEFAULT_RERANK_TIMEOUT_MS = 5000;

interface RerankResultItem {
  readonly index: number;
  readonly relevance_score?: number;
  readonly score?: number;
}

interface WrappedRerankResponse {
  readonly results: ReadonlyArray<RerankResultItem>;
}

function extractItems(json: unknown): ReadonlyArray<RerankResultItem> {
  if (Array.isArray(json)) return json as ReadonlyArray<RerankResultItem>;
  if (
    json !== null &&
    typeof json === "object" &&
    Array.isArray((json as WrappedRerankResponse).results)
  ) {
    return (json as WrappedRerankResponse).results;
  }
  throw new SearchError(
    "RERANK_PROVIDER_HTTP",
    "rerank response shape: expected an array or a { results: [...] } object",
  );
}

function scoreOf(item: RerankResultItem): number {
  const raw = item.relevance_score ?? item.score;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new SearchError(
      "RERANK_PROVIDER_HTTP",
      `rerank response: item at index ${item.index} has no finite relevance score`,
    );
  }
  return raw;
}

export class CrossEncoderRerankProvider implements RerankProvider {
  readonly name = "openai-compat-rerank";
  readonly model: string;
  private readonly endpoint: OpenAiCompatEndpoint;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(endpoint: OpenAiCompatEndpoint, opts?: { readonly timeoutMs?: number }) {
    this.endpoint = endpoint;
    this.model = endpoint.model;
    this.url = `${endpoint.baseUrl}/rerank`;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  }

  async rerank(query: string, documents: ReadonlyArray<string>): Promise<number[]> {
    if (documents.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: [...documents],
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const cause = e instanceof Error ? e : new Error(String(e));
      if (cause.name === "AbortError") {
        throw new SearchError(
          "RERANK_PROVIDER_HTTP",
          `rerank request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new SearchError("RERANK_PROVIDER_HTTP", `network error: ${cause.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const head = body.slice(0, 300);
      throw new SearchError(
        "RERANK_PROVIDER_HTTP",
        `rerank HTTP ${response.status}: ${head || response.statusText}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SearchError("RERANK_PROVIDER_HTTP", `rerank response not JSON: ${msg}`);
    }

    const items = extractItems(json);
    if (items.length !== documents.length) {
      throw new SearchError(
        "RERANK_PROVIDER_HTTP",
        `rerank response shape: expected ${documents.length} scores, got ${items.length}`,
      );
    }

    // Map back to input order. Each item carries its own `index`, so a
    // backend that returns them sorted by score is realigned here.
    const scores: number[] = Array.from({ length: documents.length }, () => Number.NaN);
    const seen: boolean[] = Array.from({ length: documents.length }, () => false);
    for (const item of items) {
      if (
        typeof item.index !== "number" ||
        item.index < 0 ||
        item.index >= documents.length ||
        !Number.isInteger(item.index)
      ) {
        throw new SearchError(
          "RERANK_PROVIDER_HTTP",
          `rerank response: out-of-range index ${item.index}`,
        );
      }
      if (seen[item.index]) {
        throw new SearchError(
          "RERANK_PROVIDER_HTTP",
          `rerank response: duplicate index ${item.index}`,
        );
      }
      seen[item.index] = true;
      scores[item.index] = scoreOf(item);
    }
    return scores;
  }
}

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
 * per-request timeout, and provider-shaped `RerankEndpointError`s (a
 * `SearchError` with code `RERANK_PROVIDER_HTTP` plus a closed failure
 * category, see `failure.ts`). Retries are
 * intentionally omitted: this is an opt-in final reader step that
 * degrades gracefully to the heuristic ordering on ANY failure (see
 * `applyCrossEncoderRerank`), so a slow retry loop would only add latency
 * to the hot path for a result the caller already has a good answer for.
 */

import { assertHttpEgressEndpoint, linkAbortSignal } from "../embeddings/http-util.ts";
import type { OpenAiCompatEndpoint } from "../embeddings/provider-resolve.ts";
import type { RerankCallOptions, RerankProvider } from "./contract.ts";
import {
  RERANK_FAILURE_CATEGORY,
  RerankEndpointError,
  rerankCategoryForStatus,
} from "./failure.ts";

/** A 2xx body this build cannot read as one score per document. */
function malformed(message: string): RerankEndpointError {
  return new RerankEndpointError(message, { category: RERANK_FAILURE_CATEGORY.malformed });
}

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
  throw malformed("rerank response shape: expected an array or a { results: [...] } object");
}

function scoreOf(item: RerankResultItem): number {
  const raw = item.relevance_score ?? item.score;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw malformed(`rerank response: item at index ${item.index} has no finite relevance score`);
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
    // Same endpoint rule the embedding providers answer to: the vault
    // query text and the bearer key both travel to this host.
    const base = assertHttpEgressEndpoint(endpoint.baseUrl, "search_rerank_base_url", {
      allowInsecureHttp: endpoint.allowInsecureHttp === true,
      key: "search_rerank_allow_insecure_http",
    });
    this.url = `${base.replace(/\/+$/, "")}/rerank`;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  }

  async rerank(
    query: string,
    documents: ReadonlyArray<string>,
    opts?: RerankCallOptions,
  ): Promise<number[]> {
    if (documents.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const unlink = linkAbortSignal(opts?.signal, controller);
    // The timeout and the caller's signal cover the body read as well as
    // the fetch, so the timer is cleared only once the body is in.
    let text: string;
    try {
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
          // No cross-host redirect may take the bearer key - or the query -
          // somewhere the operator did not configure.
          redirect: "error",
          signal: controller.signal,
        });
      } catch (e) {
        const cause = e instanceof Error ? e : new Error(String(e));
        // The caller cancelled: its own abort reason travels up unchanged,
        // so the caller recognises its cancellation by name.
        if (opts?.signal?.aborted === true) throw opts.signal.reason;
        if (controller.signal.aborted) {
          throw new RerankEndpointError(`rerank request timed out after ${this.timeoutMs}ms`, {
            category: RERANK_FAILURE_CATEGORY.timeout,
          });
        }
        throw new RerankEndpointError(`network error: ${cause.message}`, {
          category: RERANK_FAILURE_CATEGORY.network,
        });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const head = body.slice(0, 300);
        throw new RerankEndpointError(
          `rerank HTTP ${response.status}: ${head || response.statusText}`,
          { category: rerankCategoryForStatus(response.status), status: response.status },
        );
      }

      // Read and parse apart: a stream that breaks while the 2xx body is
      // read is the path failing (`network`), while a body that arrived
      // whole and is not JSON is the endpoint's answer (`malformed`).
      try {
        text = await response.text();
      } catch (e) {
        // The timer and the caller's signal abort a stalled body too, and
        // read the same way they do for the fetch.
        if (opts?.signal?.aborted === true) throw opts.signal.reason;
        if (controller.signal.aborted) {
          throw new RerankEndpointError(`rerank request timed out after ${this.timeoutMs}ms`, {
            category: RERANK_FAILURE_CATEGORY.timeout,
          });
        }
        const msg = e instanceof Error ? e.message : String(e);
        throw new RerankEndpointError(`network error: ${msg}`, {
          category: RERANK_FAILURE_CATEGORY.network,
        });
      }
    } finally {
      clearTimeout(timer);
      unlink();
    }
    let json: unknown;
    try {
      // Parsed through a Response rather than JSON.parse, so the parse
      // error, and with it the message, is the one `response.json()` gave.
      json = await new Response(text).json();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw malformed(`rerank response not JSON: ${msg}`);
    }

    const items = extractItems(json);
    if (items.length !== documents.length) {
      throw malformed(
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
        throw malformed(`rerank response: out-of-range index ${item.index}`);
      }
      if (seen[item.index]) {
        throw malformed(`rerank response: duplicate index ${item.index}`);
      }
      seen[item.index] = true;
      scores[item.index] = scoreOf(item);
    }
    return scores;
  }
}

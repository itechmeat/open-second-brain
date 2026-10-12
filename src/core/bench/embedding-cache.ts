/**
 * Shared vector cache for capability-declaring bench suites
 * (recall-quality wave, t_607d429d).
 *
 * One cache file under the RUNS directory - shared by every run
 * ("arm") against the same runs dir - keyed by the embedding identity
 * triple (provider, model, dimension) plus the SHA-256 of the chunk
 * text. The suite's index phase is the only writer: it applies cached
 * vectors straight into the run's disposable store (no provider
 * contact, no spend), hands only the misses to the indexer's
 * apply-gated embedding phase - which re-prices and re-gates that
 * census itself - then reads every stored vector back and rewrites the
 * cache atomically once the phase completed. Because a hit IS the
 * earlier arm's stored bytes, arms compare byte-identical vectors by
 * construction, without touching the store schema.
 *
 * The spend plan is computed over the FULL pending census through
 * `planEmbeddingSpend` and surfaced on the receipt; a blocked gate is a
 * named refusal before any provider contact. The bench never passes
 * `forceCost` and never bypasses the plan.
 *
 * Scale bound, stated honestly: this backend is one JSON file of float
 * arrays, read fully into memory and rewritten atomically per run, with
 * the pending census looked up through a Map keyed by chunk id. That
 * serves bench runs up to roughly 10^4 chunks. LongMemEval at `_s`
 * scale is about 10^5 chunks - past what one in-memory JSON file should
 * hold; a suite that size needs a different cache (one file per key, or
 * SQLite), not this one.
 *
 * Deterministic and network-free under the deterministic local provider
 * the CI pin selects; a real provider is an operator lane through the
 * same explicit capability-plus-pin gate.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../integrity/digest.ts";
import {
  COST_GATE_KEY,
  formatEstimatedUsd,
  planEmbeddingSpend,
  priceSpendPlan,
} from "../search/embedding-spend.ts";
import { makeProvider } from "../search/embeddings/provider.ts";
import { indexVault, runEmbeddingPhase, type EmbeddingPhaseTally } from "../search/indexer.ts";
import { Store } from "../search/store.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";
import type { BenchEmbeddingReceipt } from "./types.ts";

/** Typed failure of the bench embedding path. Errors surface by name. */
export class BenchEmbeddingError extends Error {}

/** Field sentinel of an unknown model or dimension, keeping keys parseable. */
const SIGNATURE_SENTINEL = "?";

/** NFC, trim, lowercase: the one canonicalization for identity tokens. */
function canonicalSignatureToken(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/**
 * The bench's own rendering of the embedding identity: the
 * `<provider>:<model>:<dimension>` triple plus the resolved
 * query/passage prefixes, canonicalized exactly like the store's
 * identity so cache keys match across runs. Rendered here
 * rather than imported because the module that exports the shared
 * renderer also carries a token estimator, and the bench pins exactly
 * one estimator - the census is on the import path.
 */
export function benchEmbeddingSignature(
  provider: string,
  model: string | null,
  dimension: number | null,
  queryPrefix: string,
  passagePrefix: string,
): string {
  const modelField = model === null ? SIGNATURE_SENTINEL : canonicalSignatureToken(model);
  const dimensionField = dimension === null ? SIGNATURE_SENTINEL : String(dimension);
  // The prefixes join the signature because the stored bytes depend on
  // them as much as on the model: the provider input is the prefixed
  // text, and BenchPinnedKnobs.semantic can pin either prefix. Two arms
  // that differ only in prefix pins must never share an entry.
  return (
    `${canonicalSignatureToken(provider)}:${modelField}:${dimensionField}:` +
    `${canonicalSignatureToken(queryPrefix)}:${canonicalSignatureToken(passagePrefix)}`
  );
}

/** Cache file shared by every bench run under one runs directory. */
export const BENCH_VECTOR_CACHE_FILENAME = "embedding-cache.json";

/** The spend receipt each capability run writes beside its report. */
export const BENCH_EMBEDDING_RECEIPT_FILENAME = "embeddings.json";

export const BENCH_VECTOR_CACHE_SCHEMA = "o2b.bench.vectors.v1";

interface VectorCache {
  readonly schema: string;
  readonly entries: Record<string, ReadonlyArray<number>>;
}

/** Runs-directory path of the shared vector cache. */
export function benchVectorCachePath(runsDir: string): string {
  return join(runsDir, BENCH_VECTOR_CACHE_FILENAME);
}

/**
 * Cache key for one chunk: the embedding identity triple plus the text
 * hash. The dimension joins the key because vectors of different
 * dimensions are incomparable even at the same provider and model - the
 * comparability rule the identity signature exists for.
 */
export function benchVectorCacheKey(signature: string, text: string): string {
  return `${signature}|${sha256Hex(text)}`;
}

/**
 * Load the shared cache. An absent file is an empty cache; a malformed
 * one is a named error - the cache is repo-owned state, and silently
 * re-embedding over a corrupt file would hide why two arms disagreed.
 * A file stamped with another schema is foreign state by the same rule:
 * its vectors are never served as hits.
 */
function loadVectorCache(runsDir: string): Record<string, ReadonlyArray<number>> {
  const path = benchVectorCachePath(runsDir);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new BenchEmbeddingError(
      `bench vector cache is not readable JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BenchEmbeddingError(`bench vector cache at ${path} must be an object`);
  }
  // Every writer stamps the schema, so a missing or foreign one means the
  // file was not written by this module's generation: applying its bytes
  // as cache hits would compare vectors across incomparable identities.
  const schema = (raw as Record<string, unknown>)["schema"];
  if (schema !== BENCH_VECTOR_CACHE_SCHEMA) {
    throw new BenchEmbeddingError(
      `bench vector cache at ${path} has schema '${String(schema)}', expected ` +
        `'${BENCH_VECTOR_CACHE_SCHEMA}' - refusing to serve vectors across cache generations`,
    );
  }
  const entries = (raw as Record<string, unknown>)["entries"];
  if (entries === undefined) return {};
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    throw new BenchEmbeddingError(`bench vector cache at ${path} needs an entries object`);
  }
  const parsed: Record<string, ReadonlyArray<number>> = {};
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!Array.isArray(value) || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new BenchEmbeddingError(
        `bench vector cache at ${path}: entry '${key}' must be an array of finite numbers`,
      );
    }
    parsed[key] = Object.freeze([...value]);
  }
  return parsed;
}

/**
 * Rewrite the shared cache atomically: a temp file renamed over the
 * target, so an arm never reads a partially written file and a crash
 * leaves the previous generation intact.
 */
function writeVectorCache(runsDir: string, entries: Record<string, ReadonlyArray<number>>): void {
  const cache: VectorCache = { schema: BENCH_VECTOR_CACHE_SCHEMA, entries };
  const path = benchVectorCachePath(runsDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** The stored-model spelling, matching the indexer's embedding phase. */
function storedEmbeddingModel(config: ResolvedSearchConfig): string | null {
  return config.semantic.model ?? makeProvider(config.semantic).model;
}

/** Same digest formula the indexer records alongside every vector. */
function embeddingHashOf(vector: ReadonlyArray<number>): string {
  return sha256Hex(vector.map((x) => x.toFixed(8)).join(","));
}

/**
 * Build the disposable vault's index with real vectors, through the
 * apply-gated indexer path and the shared vector cache.
 *
 * Order matters: the chunk-only index runs first (no provider contact),
 * the full spend plan is computed and gated over its census, cache hits
 * are applied without any provider, and only the misses reach the
 * indexer's embedding phase - handed in as a plan the phase re-prices
 * and re-gates itself, unforced. Every pending vector is then read back
 * from the store and the cache is rewritten atomically.
 */
export async function embedBenchVaultIndex(opts: {
  config: ResolvedSearchConfig;
  runsDir: string;
}): Promise<BenchEmbeddingReceipt> {
  const { config, runsDir } = opts;
  // Chunk-only index: walk, chunk, FTS - the apply-gated phase below is
  // the only provider contact in the whole run.
  await indexVault(config);
  const model = storedEmbeddingModel(config);
  if (model === null) {
    throw new BenchEmbeddingError(
      "bench embedding: no embedding model is stored on the index; the capability path needs an indexed model to key vectors",
    );
  }
  const provider = makeProvider(config.semantic);
  const signature = benchEmbeddingSignature(
    config.semantic.provider,
    model,
    provider.dimension ?? null,
    config.semantic.queryPrefix ?? "",
    config.semantic.passagePrefix ?? "",
  );
  const store = await Store.open(config, { mode: "write" });
  try {
    const plan = planEmbeddingSpend(store, config);
    const cache = loadVectorCache(runsDir);
    const prefixes = {
      query: config.semantic.queryPrefix ?? "",
      passage: config.semantic.passagePrefix ?? "",
    };
    interface Hit {
      readonly chunkId: number;
      readonly key: string;
      readonly vector: ReadonlyArray<number>;
    }
    const hits: Hit[] = [];
    const misses: Array<{ chunkId: number; content: string; key: string }> = [];
    for (const item of plan.pending) {
      const key = benchVectorCacheKey(signature, item.content);
      const cached = cache[key];
      if (cached !== undefined) {
        hits.push({ chunkId: item.chunkId, key, vector: cached });
      } else {
        misses.push({ chunkId: item.chunkId, content: item.content, key });
      }
    }
    // The spend gate prices the misses census, the chunks this arm would
    // actually embed: an arm the shared cache serves whole makes zero
    // provider contact, and gating it on the full census would refuse
    // exactly the runs the cache exists for. With misses, the verdict
    // over the misses subset is the honest one - the phase's own gate
    // re-checks the same census at write time. Pending entries are
    // keyed by chunk id once, so pricing the misses stays linear in the
    // census rather than a scan per miss.
    if (misses.length > 0) {
      const pendingByChunkId = new Map(plan.pending.map((p) => [p.chunkId, p]));
      const missesPlan = priceSpendPlan(
        misses.map((m) => {
          const pending = pendingByChunkId.get(m.chunkId);
          if (pending === undefined) throw new BenchEmbeddingError("census split lost a chunk");
          return pending;
        }),
        config,
      );
      if (missesPlan.gate.blocked) {
        throw new BenchEmbeddingError(
          `bench embedding spend gate refused (${missesPlan.gate.reason}): estimated ` +
            `${formatEstimatedUsd(missesPlan.estimatedUsd)} for ${missesPlan.pending.length} chunk(s) exceeds ` +
            `${COST_GATE_KEY} ${formatEstimatedUsd(config.semantic.costGateUsd)} - the bench never ` +
            `bypasses the spend plan`,
        );
      }
    }
    // Cache hits carry an earlier arm's exact bytes: same signature, so
    // the same model, dimension and prefix bookkeeping apply.
    if (hits.length > 0) {
      const dim = hits[0]!.vector.length;
      store.ensureEmbeddingModel(model, dim, prefixes);
      for (const hit of hits) {
        store.vecUpsert(
          hit.chunkId,
          new Float32Array(hit.vector),
          model,
          dim,
          embeddingHashOf(hit.vector),
        );
      }
    }
    const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
    if (misses.length > 0) {
      // Only the misses are spend, and the phase prices and gates that
      // census itself - the verdict acted on is always the phase's own.
      await runEmbeddingPhase(store, config, tally, {
        plan: priceSpendPlan(
          misses.map((miss) => ({ chunkId: miss.chunkId, content: miss.content })),
          config,
        ),
      });
    }
    // Read every pending vector back from the store - the stored bytes
    // are canonical, whether they came from the cache or the provider -
    // and rewrite the cache in one atomic generation.
    const entries: Record<string, ReadonlyArray<number>> = { ...cache };
    for (const item of plan.pending) {
      const stored = store.embeddingForChunk(item.chunkId);
      if (stored === null) {
        throw new BenchEmbeddingError(
          `bench embedding cache: chunk ${item.chunkId} has no stored vector after the embedding phase`,
        );
      }
      entries[benchVectorCacheKey(signature, item.content)] = Object.freeze([...stored]);
    }
    writeVectorCache(runsDir, entries);
    return Object.freeze({
      provider: config.semantic.provider,
      model,
      signature,
      planned: plan.pending.length,
      cache_hits: hits.length,
      cache_misses: misses.length,
      tokens: plan.tokens,
      estimated_usd: plan.estimatedUsd,
      price_source: plan.quote.source,
      gate: plan.gate,
      ...(tally.spend !== undefined ? { forced: tally.spend.forced } : {}),
    });
  } finally {
    await store.close();
  }
}

/**
 * Read back the spend receipt of a resumed run whose index phase
 * completed in an earlier invocation. A run pinned to the semantic lane
 * without the artifact is broken state, not an empty receipt.
 */
export function readBenchEmbeddingReceipt(runDir: string): BenchEmbeddingReceipt {
  const path = join(runDir, BENCH_EMBEDDING_RECEIPT_FILENAME);
  if (!existsSync(path)) {
    throw new BenchEmbeddingError(
      `bench run is missing the embedding spend receipt at ${path} - the index phase of a semantic-pinned run must have written one`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new BenchEmbeddingError(
      `bench embedding spend receipt is not readable JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BenchEmbeddingError(`bench embedding spend receipt at ${path} must be an object`);
  }
  return Object.freeze({ ...(raw as BenchEmbeddingReceipt) });
}

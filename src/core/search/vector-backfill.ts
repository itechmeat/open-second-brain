/**
 * Vector-only backfill (provenance-at-the-boundary, unit F).
 *
 * A chunk without a vector is NOT a broken row. Vectors live in a `vec0`
 * virtual table that cannot hold a null vector, so the absence of a
 * vector is simply a `chunks` row with no `embeddings` row - a
 * first-class state the store already queries (`findChunksWithoutEmbeddings`)
 * and that the population phase already resumes from, because the
 * anti-join finds exactly what is still missing and `vecUpsert` commits
 * per chunk. Nothing here introduces a schema change, a deferred provider
 * class, or a null-vector concept; the state already existed and had no
 * operator-facing verb.
 *
 * That verb is what this module plans. It is the vector phase run ALONE:
 * no vault walk, no re-chunking, no frontmatter pass. An operator who
 * indexed offline (the default - no automatic index call requests
 * embeddings) and later configures a provider closes the gap with it
 * instead of re-indexing the whole vault.
 *
 * Contract, taken verbatim from `brain/authored-at-backfill.ts`:
 *   - Dry-run by DEFAULT. {@link planVectorBackfill} without `apply`
 *     opens the index read-only, counts, and writes nothing at all.
 *   - `apply` is the only mutating path, and it is the only path that
 *     contacts a provider.
 *   - Idempotent: a re-run over a fully vectorised index finds nothing
 *     pending and does nothing.
 *
 * ## Which question each refusal answers
 *
 * The dry run does not attempt anything, so it REPORTS the capability
 * tier - what the operator configured - and still counts the pending
 * work, because how much work is waiting is true regardless of whether
 * the credential is in place yet. The apply path does attempt, so its
 * refusals are the typed `SearchError`s the embedding phase already
 * raises. One condition is never reported both ways.
 */

import { resolveSemanticCapability, type SemanticCapability } from "./capability-tier.ts";
import { estimateCostUsd, estimateTokens, pricePerMillionTokens } from "./embeddings/signature.ts";
import { runEmbeddingPhase } from "./indexer.ts";
import { Store } from "./store.ts";
import type { ResolvedSearchConfig } from "./types.ts";

export interface VectorBackfillOptions {
  /** When true, compute and store the missing vectors. Default false. */
  readonly apply?: boolean;
  /** Bypass the configured spend ceiling for this run. */
  readonly forceCost?: boolean;
  readonly safeguard?: import("../brain/safeguard.ts").Safeguard;
  readonly signal?: AbortSignal;
}

export interface VectorBackfillResult {
  /** Whether the run mutated the index (`false` for a dry run). */
  readonly applied: boolean;
  /** What the operator configured, from the shared tier resolver. */
  readonly capability: SemanticCapability;
  /** Chunks in the index. */
  readonly chunksTotal: number;
  /** Chunks that had no vector when the run started. */
  readonly pending: number;
  /** Vectors written by this run (0 on a dry run). */
  readonly embedded: number;
  /** Provider retries this run consumed (0 on a dry run). */
  readonly retries: number;
  /**
   * Estimated spend for the pending set, from the estimator that already
   * governs the indexer's cost gate. `0` when the model carries no known
   * price - which is an absent price, not a free run, and the human
   * report says so rather than printing `$0.0000`.
   */
  readonly estimatedCostUsd: number;
  /** True when {@link estimatedCostUsd} could be derived at all. */
  readonly costKnown: boolean;
}

/**
 * Count the vectorless chunks and, when `apply` is set, populate them.
 *
 * Throws `SearchError("INDEX_MISSING")` when there is no index to read:
 * an absent index is a different answer from an index with no pending
 * work, and collapsing the two would report "nothing to do" for a vault
 * that has never been indexed.
 */
export async function planVectorBackfill(
  config: ResolvedSearchConfig,
  opts: VectorBackfillOptions = {},
): Promise<VectorBackfillResult> {
  const apply = opts.apply === true;
  const capability = resolveSemanticCapability(config.semantic);
  const store = await Store.open(config, { mode: apply ? "write" : "read" });
  try {
    const pendingChunks = store.findChunksWithoutEmbeddings();
    const chunksTotal = store.counts().chunks;
    const model = config.semantic.model;
    const tokens = estimateTokens(pendingChunks.map((c) => c.content));
    const estimatedCostUsd = estimateCostUsd(tokens, model);
    const tally = { embeddingsComputed: 0, embeddingsRetries: 0 };

    if (apply && pendingChunks.length > 0) {
      await runEmbeddingPhase(store, config, tally, {
        forceCost: opts.forceCost === true,
        ...(opts.safeguard !== undefined ? { safeguard: opts.safeguard } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    }

    return Object.freeze({
      applied: apply,
      capability,
      chunksTotal,
      pending: pendingChunks.length,
      embedded: tally.embeddingsComputed,
      retries: tally.embeddingsRetries,
      estimatedCostUsd,
      // Whether the MODEL has a price, not whether this run costs
      // anything: an empty pending set costs nothing and that is not the
      // same statement as "the price of this model is unknown".
      costKnown: pricePerMillionTokens(model) > 0,
    });
  } finally {
    await store.close();
  }
}

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
import { planEmbeddingSpend, type EmbeddingGateReason } from "./embedding-spend.ts";
import type { EmbeddingPriceSource } from "./embeddings/pricing.ts";
import { runEmbeddingPhase, type EmbeddingPhaseTally } from "./indexer.ts";
import { assertSafePathPrefix } from "./pipeline/request.ts";
import { SearchError } from "./search-error.ts";
import { Store } from "./store.ts";
import type { PendingVectorScope } from "./store/chunks.ts";
import type { ResolvedSearchConfig } from "./types.ts";
import type { MaintenanceSpendReceipt } from "../brain/maintenance/journal.ts";
import {
  OPERATION,
  progressCounter,
  withProgressAsync,
  type ProgressCounter,
} from "../brain/progress.ts";

export interface VectorBackfillOptions {
  /** When true, compute and store the missing vectors. Default false. */
  readonly apply?: boolean;
  /** Bypass the configured spend ceiling for this run. */
  readonly forceCost?: boolean;
  /**
   * Vault-relative path prefixes the run is limited to. Each one is
   * validated by {@link assertSafePathPrefix}; the census, the estimate,
   * the gate and the receipt all read this scope. Empty or absent means
   * the whole vault.
   */
  readonly pathPrefixes?: ReadonlyArray<string>;
  readonly safeguard?: import("../brain/safeguard.ts").Safeguard;
  readonly signal?: AbortSignal;
  /**
   * Live progress observer (nothing-runs-unwatched, U1). This verb owns
   * the run - it holds the plan and the gate, and the embedding phase
   * holds the loop - so the counter is built here and lent to the phase.
   * One run, one counter, one terminator.
   */
  readonly onProgress?: import("../brain/progress.ts").ProgressSink;
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
   * Estimated spend for the pending set, from the shared spend plan the
   * indexer's cost gate reads. Null when nobody stated the model's price
   * - an absent price, not a free run, and the report says so rather
   * than printing `$0.0000`.
   */
  readonly estimatedCostUsd: number | null;
  /** Who stated the price the estimate used. */
  readonly priceSource: EmbeddingPriceSource;
  /** True when the configured gate would refuse this spend unforced. */
  readonly blocked: boolean;
  /** Why the gate would refuse; null when it would not. */
  readonly reason: EmbeddingGateReason | null;
  /**
   * The prefixes the run was limited to, normalised (no leading `./`,
   * `/` separators); empty for the whole vault.
   */
  readonly pathPrefixes: ReadonlyArray<string>;
  /**
   * The prefixes that match no indexed document. A scope that matches
   * nothing has nothing pending, and without this list it would read
   * exactly like a fully embedded scope.
   */
  readonly unmatchedPathPrefixes: ReadonlyArray<string>;
  /**
   * The spend receipt of an applied run that reached the provider, from
   * the same scoped plan the dry run reports; null otherwise.
   */
  readonly spend: MaintenanceSpendReceipt | null;
}

/** The argument name an unsafe prefix is refused under. */
const PATH_PREFIX_ARGUMENT = "path prefix";

/**
 * The spelling a prefix is matched under: Windows separators become `/`
 * and a leading `./` is dropped, so `./Brain/` and `Brain\preferences\` match the
 * stored `Brain/...` paths. Matching itself stays a raw string prefix.
 */
function normalisePathPrefix(prefix: string): string {
  let normal = prefix.replaceAll("\\", "/");
  while (normal.startsWith("./")) normal = normal.slice(2);
  return normal;
}

/**
 * Normalise and validate every prefix by name; an empty list scopes
 * nothing. An empty or blank prefix is refused rather than skipped: it
 * would match every document and widen a scoped run to the whole vault
 * while the report still echoed a scope.
 */
function normalisePathPrefixes(pathPrefixes: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.freeze(
    pathPrefixes.map((raw) => {
      const prefix = normalisePathPrefix(raw);
      if (prefix.trim() === "") {
        throw new SearchError(
          "INVALID_INPUT",
          `${PATH_PREFIX_ARGUMENT} is empty: ${JSON.stringify(raw)}`,
        );
      }
      assertSafePathPrefix(prefix, PATH_PREFIX_ARGUMENT);
      return prefix;
    }),
  );
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
  const progress = progressCounter(OPERATION.reindex, opts.onProgress);
  progress.start(VECTOR_BACKFILL_STAGE);
  return await withProgressAsync(progress, () => planVectorBackfillRun(config, opts, progress));
}

/** The one stage: the backfill plans, then lends the loop to the phase. */
const VECTOR_BACKFILL_STAGE = "plan";

async function planVectorBackfillRun(
  config: ResolvedSearchConfig,
  opts: VectorBackfillOptions,
  progress: ProgressCounter,
): Promise<VectorBackfillResult> {
  const apply = opts.apply === true;
  const pathPrefixes = normalisePathPrefixes(opts.pathPrefixes ?? []);
  const scope: PendingVectorScope | undefined =
    pathPrefixes.length > 0 ? { pathPrefixes } : undefined;
  const capability = resolveSemanticCapability(config.semantic);
  const store = await Store.open(config, { mode: apply ? "write" : "read" });
  try {
    const plan = planEmbeddingSpend(store, config, scope ? { scope } : {});
    const chunksTotal = store.counts().chunks;
    const unmatchedPathPrefixes = Object.freeze(
      pathPrefixes.filter((prefix) => store.countDocumentsUnderPrefix(prefix) === 0),
    );
    const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };

    if (apply && plan.pending.length > 0) {
      await runEmbeddingPhase(store, config, tally, {
        forceCost: opts.forceCost === true,
        ...(scope ? { scope } : {}),
        plan,
        ...(opts.safeguard !== undefined ? { safeguard: opts.safeguard } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        progress,
      });
    }

    return Object.freeze({
      applied: apply,
      capability,
      chunksTotal,
      pending: plan.pending.length,
      embedded: tally.embeddingsComputed,
      retries: tally.embeddingsRetries,
      estimatedCostUsd: plan.estimatedUsd,
      priceSource: plan.quote.source,
      blocked: plan.gate.blocked,
      reason: plan.gate.reason,
      pathPrefixes,
      unmatchedPathPrefixes,
      spend: tally.spend ?? null,
    });
  } finally {
    await store.close();
  }
}

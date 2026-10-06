/**
 * Belief vector scorer and loader (Honest Embedding Spend): the read side
 * of `brain_context_pack` `semantic` mode.
 *
 * Belief notes (`Brain/preferences/`, `Brain/retired/`) are ordinary
 * indexed documents, so their chunks already carry vectors after any
 * embedding pass. This module reads those stored vectors directly and
 * scores them by exact cosine against one query vector. It runs no KNN:
 * a prefix-filtered `semanticTopK` asks sqlite-vec for the nearest chunks
 * of the WHOLE vault and drops the rest afterwards, which under-returns
 * beliefs in a large vault, while the belief set is small enough to score
 * outright.
 *
 * Two halves:
 *   - {@link scoreBeliefsByVector} is pure. A note's score is the maximum
 *     cosine over its usable chunk vectors (the frontmatter chunk and the
 *     body chunk both carry the principle, so a sum would double-count).
 *     A row recorded under another model or dimension is not comparable
 *     with the query and counts as unembedded, never as scored.
 *   - {@link loadBeliefSemanticRelevance} opens the index, refuses a
 *     blocked capability tier and a missing sqlite-vec by name BEFORE it
 *     embeds anything, asks the query-embed gateway (`prepareQueryEmbed`)
 *     whether and with what text to embed, embeds that text exactly once
 *     with the `query` prefix kind, and discloses that one spend: the
 *     model, the price source, the query tokens actually sent (prefix
 *     included) and the cost (null when the price is unknown). A caller
 *     that is not local is refused an unpriced model's embed under a
 *     positive cost gate, before the call; a query cut to the model's
 *     input window adds a warning.
 *
 * No belief row under the model anywhere is refused here, before the
 * embed, with `BELIEF_VECTORS_MISSING`: none in reach can have one. Any
 * other shortfall is the pack's to judge, because whether the caller's
 * KEPT candidates have vectors is only known after its reach filter.
 */

import { BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL } from "./path-constants.ts";
import {
  BLOCKED_TIER_ERROR_CODE,
  isBlockedCapability,
  resolveSemanticCapability,
  semanticCapabilityLabel,
} from "../search/capability-tier.ts";
import type { EmbeddingProvider } from "../search/embeddings/contract.ts";
import { formatEstimatedUsd } from "../search/embedding-spend.ts";
import type { EmbeddingPriceSource } from "../search/embeddings/pricing.ts";
import { makeProvider } from "../search/embeddings/provider.ts";
import {
  prepareQueryEmbed,
  queryEmbedCutMessage,
  queryEmbedEmptyFitMessage,
  queryEmbedRefusalMessage,
} from "../search/embeddings/query-embed.ts";
import { estimateCostUsd } from "../search/embeddings/signature.ts";
import { SearchError } from "../search/search-error.ts";
import { isRemotelyReadable } from "../graph/visibility.ts";
import {
  resolvedTransportReach,
  TRANSPORT_REACH,
  type TransportReach,
} from "../graph/transport-reach.ts";
import { contradictedAbiFields, formatEmbeddingAbiDrift, Store } from "../search/store.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";
import { assertValidVector } from "../search/vector-guard.ts";

/** Vault-relative directory prefixes whose notes are scored as beliefs. */
export const BELIEF_SEMANTIC_PATH_PREFIXES: ReadonlyArray<string> = Object.freeze([
  `${BRAIN_PREFERENCES_REL}/`,
  `${BRAIN_RETIRED_REL}/`,
]);

/** The command that pays for the vectors the `semantic` mode reads. */
export const BELIEF_VECTORS_BACKFILL_COMMAND = `o2b search vector-backfill ${BELIEF_SEMANTIC_PATH_PREFIXES.map((prefix) => `--path ${prefix}`).join(" ")} --apply`;

/** One stored vector with the identity its `embeddings` row recorded. */
export interface StoredBeliefVector {
  readonly vector: Float32Array;
  readonly model: string;
  readonly dimension: number;
}

export interface BeliefVectorScoreInput {
  /** The model the query vector was produced by. */
  readonly model: string;
  readonly queryVector: ReadonlyArray<number> | Float32Array;
  /** Every belief note's stored vectors, keyed by vault-relative path. */
  readonly vectorsByPath: ReadonlyMap<string, ReadonlyArray<StoredBeliefVector>>;
}

export interface BeliefVectorScores {
  /** Maximum cosine per path, only for paths with a usable vector. */
  readonly relevanceByPath: ReadonlyMap<string, number>;
  /** Scored paths, highest relevance first, ties by path. */
  readonly order: ReadonlyArray<string>;
  /** Paths with no usable vector, sorted. */
  readonly unembedded: ReadonlyArray<string>;
  /** How many paths were scored. */
  readonly scored: number;
}

/** The one query spend of the semantic mode, disclosed rather than hidden. */
export interface BeliefSemanticQueryReport {
  readonly model: string;
  readonly priceSource: EmbeddingPriceSource;
  /** The estimate of the text actually sent, the instruction prefix included. */
  readonly queryTokens: number;
  /** Null when nobody stated the model's price. */
  readonly estimatedUsd: number | null;
}

export interface BeliefSemanticRelevance extends BeliefVectorScores {
  readonly report: BeliefSemanticQueryReport;
  /**
   * The search lane's embedding-ABI drift warning when the index
   * contradicts this build, and one warning when the query was cut to the
   * model's input window.
   */
  readonly warnings: ReadonlyArray<string>;
}

export interface BeliefSemanticDeps {
  /** The query embedder; the configured provider when omitted. */
  readonly provider?: EmbeddingProvider;
  /** Whether the store loads sqlite-vec; omitted loads it. */
  readonly loadVec?: boolean;
  /**
   * The caller's transport reach; remote when omitted, as everywhere else
   * (`resolvedTransportReach`). Below local reach a
   * belief whose INDEXED visibility is not readable there loses its
   * vectors: they were captured from bytes reserved at index time, and a
   * live file rewritten since must not be ordered by them.
   */
  readonly reach?: TransportReach;
  /**
   * Whether the caller may be shown a belief, by vault-relative path; every
   * belief when omitted. A belief it rejects is left out of the read, so the
   * pre-embed refusal below answers for it exactly as for an absent page:
   * the pack drops it after its own reach and owner filters, and a refusal
   * decided over a wider set would tell the two apart.
   */
  readonly inView?: (path: string) => boolean;
}

/**
 * A refusal raised after the query embed still names that spend: the
 * provider answered, so the call was paid whatever is refused after it.
 * Shared by the loader (a query vector the guard rejects) and the pack (a
 * refusal decided over the beliefs it keeps), so both read the same.
 */
export function discloseSpentQuery(e: SearchError, spent: BeliefSemanticQueryReport): SearchError {
  return new SearchError(
    e.code,
    `${e.message} (the query embed was still spent: model ${spent.model}, ` +
      `price source ${spent.priceSource}, ${spent.queryTokens} query token(s), ` +
      `${formatEstimatedUsd(spent.estimatedUsd)})`,
  );
}

/** The context the query vector is validated under, named in a refusal. */
const QUERY_VECTOR_CONTEXT = "belief semantic query";

function cosine(a: ReadonlyArray<number> | Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Score belief notes by the best cosine of their usable stored vectors. */
export function scoreBeliefsByVector(input: BeliefVectorScoreInput): BeliefVectorScores {
  const dimension = input.queryVector.length;
  const relevanceByPath = new Map<string, number>();
  const unembedded: string[] = [];
  for (const [path, rows] of input.vectorsByPath) {
    let best: number | null = null;
    for (const row of rows) {
      if (row.model !== input.model) continue;
      if (row.dimension !== dimension || row.vector.length !== dimension) continue;
      const score = cosine(input.queryVector, row.vector);
      // A zero or non-finite row from an index written before the store
      // guard has no direction: unusable, never a NaN in the order.
      if (!Number.isFinite(score)) continue;
      if (best === null || score > best) best = score;
    }
    if (best === null) unembedded.push(path);
    else relevanceByPath.set(path, best);
  }
  const order = [...relevanceByPath.keys()].toSorted(
    (a, b) => relevanceByPath.get(b)! - relevanceByPath.get(a)! || byPath(a, b),
  );
  return {
    relevanceByPath,
    order: Object.freeze(order),
    unembedded: Object.freeze(unembedded.toSorted(byPath)),
    scored: relevanceByPath.size,
  };
}

function isBeliefPath(path: string): boolean {
  return BELIEF_SEMANTIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Embed `query`, fitted to the model's input window, once and score every
 * indexed belief note by its stored vectors. Throws a named
 * {@link SearchError} for a blocked tier (`EMBEDDING_DISABLED`,
 * `EMBEDDING_KEY_MISSING`), for a store without sqlite-vec
 * (`VEC_EXTENSION_UNAVAILABLE`), for an unpriced model under a positive
 * cost gate when the caller is not local (`EMBEDDING_COST_UNPRICED`) and
 * for a window the instruction prefix alone fills (`INVALID_INPUT`), each
 * before any embed call.
 */
export async function loadBeliefSemanticRelevance(
  config: ResolvedSearchConfig,
  query: string,
  deps: BeliefSemanticDeps = {},
): Promise<BeliefSemanticRelevance> {
  const capability = resolveSemanticCapability(config.semantic);
  if (isBlockedCapability(capability)) {
    throw new SearchError(
      BLOCKED_TIER_ERROR_CODE[capability.tier],
      await semanticCapabilityLabel(capability.code),
    );
  }
  const store = await Store.open(config, {
    mode: "read",
    ...(deps.loadVec !== undefined ? { loadVec: deps.loadVec } : {}),
  });
  try {
    if (!store.vecLoaded()) {
      throw new SearchError(
        "VEC_EXTENSION_UNAVAILABLE",
        "semantic belief order unavailable: sqlite-vec extension not loaded",
      );
    }
    const reach = resolvedTransportReach(deps.reach);
    const inView = deps.inView ?? (() => true);
    const beliefDocs = [...store.listDocuments()].filter(
      ([path]) => isBeliefPath(path) && inView(path),
    );
    const indexed =
      reach === TRANSPORT_REACH.local
        ? new Map<string, ReadonlyArray<string>>()
        : store.indexedVisibilityByPaths(beliefDocs.map(([path]) => path));
    const vectorsByPath = new Map<string, ReadonlyArray<StoredBeliefVector>>();
    for (const [path, doc] of beliefDocs) {
      // Reads as unembedded, exactly as a page whose reserved bytes were never indexed.
      const readable = isRemotelyReadable(indexed.get(path) ?? [], reach);
      vectorsByPath.set(path, readable ? store.storedEmbeddingsForDocument(doc.id) : []);
    }
    const provider = deps.provider ?? makeProvider(config.semantic);
    const model = config.semantic.model ?? provider.model;
    // No belief row under the model anywhere means none in reach has one:
    // the pack's refusal is certain, so it is raised before the paid embed.
    // The dimension needs the query vector and is judged after it.
    const anyUsable = [...vectorsByPath.values()].some((rows) =>
      rows.some((r) => r.model === model),
    );
    if (!anyUsable) {
      throw new SearchError(
        "BELIEF_VECTORS_MISSING",
        `semantic belief order unavailable: no belief note has a stored vector ` +
          `for the configured model; run: ${BELIEF_VECTORS_BACKFILL_COMMAND}`,
      );
    }
    // The gateway every query embed shares decides whether the embed is
    // sent and with what text; `model` above stays the row filter because
    // it matches the indexer's stamp. This order has no keyword fallback,
    // so a refusal is always an error here.
    const prepared = prepareQueryEmbed(config, query, reach);
    if (prepared.kind === "refused") {
      throw new SearchError(
        prepared.code,
        `semantic belief order refused: ${queryEmbedRefusalMessage(prepared)}`,
      );
    }
    if (prepared.emptyFit) {
      throw new SearchError(
        "INVALID_INPUT",
        `semantic belief order unavailable: ${queryEmbedEmptyFitMessage(prepared)}`,
      );
    }
    const [queryVector = []] = await provider.embed([prepared.text], "query");
    const report: BeliefSemanticQueryReport = {
      model: prepared.model ?? model,
      priceSource: prepared.quote.source,
      queryTokens: prepared.sentTokens,
      estimatedUsd: estimateCostUsd(prepared.sentTokens, prepared.quote),
    };
    try {
      assertValidVector(queryVector, QUERY_VECTOR_CONTEXT);
    } catch (e) {
      throw e instanceof SearchError ? discloseSpentQuery(e, report) : e;
    }
    const contradicted = contradictedAbiFields(store.embeddingAbiMismatches());
    const warnings: string[] = [];
    if (contradicted.length > 0) warnings.push(formatEmbeddingAbiDrift(contradicted));
    if (prepared.truncated) {
      warnings.push(`semantic belief order: ${queryEmbedCutMessage(prepared, query)}`);
    }
    return {
      ...scoreBeliefsByVector({ model, queryVector, vectorsByPath }),
      report,
      warnings: Object.freeze(warnings),
    };
  } finally {
    await store.close();
  }
}

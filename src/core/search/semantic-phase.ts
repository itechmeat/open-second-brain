/**
 * Semantic candidate lane: the on/off policy the caller's options resolve
 * to, the candidate-pool over-fetch sizing, and the guarded semantic
 * phase that embeds the query and runs the vector top-K (self-degrading
 * to keyword-only with warnings when the lane cannot run).
 */

import {
  resolveSemanticCapability,
  SEMANTIC_CAPABILITY_TIER,
  semanticCapabilityIsBlocked,
  semanticCapabilityLabel,
} from "./capability-tier.ts";
import { classifyEmbeddingError } from "./embeddings/openai-compat.ts";
import { makeProvider } from "./embeddings/provider.ts";
import { RETRIEVAL_DEGRADATION, noteDegradation } from "./retrieval-trail.ts";
import { Store } from "./store.ts";
import { EMBEDDING_QUOTA_MESSAGE, SearchError } from "./types.ts";
import type { SemanticCapability, SemanticCapabilityTier } from "./capability-tier.ts";
import type { RetrievalDegradationSink } from "./retrieval-trail.ts";
import type { ResolvedSearchConfig, SearchErrorCode, SearchOptions } from "./types.ts";

export interface SemanticPolicy {
  /** caller asked for semantic on or off (true), or accepted the default (false). */
  readonly explicit: boolean;
  /** does the caller want semantic at all? */
  readonly wantSemantic: boolean;
}

export function resolveSemanticPolicy(
  config: ResolvedSearchConfig,
  opts: SearchOptions,
): SemanticPolicy {
  if (opts.keywordOnly === true) {
    return { explicit: true, wantSemantic: false };
  }
  if (opts.semantic === true) return { explicit: true, wantSemantic: true };
  if (opts.semantic === false) return { explicit: true, wantSemantic: false };
  return { explicit: false, wantSemantic: config.semantic.enabled };
}

/**
 * Semantic candidate-pool over-fetch policy: rank more than `limit` rows
 * so downstream filtering (property/visibility scope, MMR diversify) has
 * enough headroom to still fill the final window. `floor` is the minimum
 * pool size regardless of `limit`; `overfetch` is the multiplier applied
 * to `limit` itself.
 */
const POOL_OVERFETCH = 5;
const POOL_FLOOR = 50;

export function semanticPoolSize(limit: number): number {
  return Math.max(limit * POOL_OVERFETCH, POOL_FLOOR);
}

/** The rungs of the capability ladder that BLOCK; `configured` is not one. */
type BlockedCapabilityTier = Exclude<
  SemanticCapabilityTier,
  typeof SEMANTIC_CAPABILITY_TIER.configured
>;

/**
 * The typed failure an EXPLICIT semantic request reports per blocked rung.
 *
 * One entry per rung, so adding a rung to the ladder is a type error here
 * rather than a request that silently degrades. `credential-missing` keeps
 * `EMBEDDING_KEY_MISSING`, the code that arm has always raised; `disabled`
 * raises `EMBEDDING_DISABLED`, the code the null provider already raises
 * for the same configuration when the indexer meets it, so one condition
 * has one code across the tree.
 */
const BLOCKED_TIER_ERROR_CODE: Readonly<Record<BlockedCapabilityTier, SearchErrorCode>> =
  Object.freeze({
    [SEMANTIC_CAPABILITY_TIER.disabled]: "EMBEDDING_DISABLED",
    [SEMANTIC_CAPABILITY_TIER.credentialMissing]: "EMBEDDING_KEY_MISSING",
  });

/**
 * {@link semanticCapabilityIsBlocked} as a TYPE predicate. The shared
 * resolver exports it as a plain boolean and lives in a module this lane
 * does not own, so the narrowing lives here - which lets the table above be
 * total over exactly the blocked rungs, with no cast and no unreachable
 * default arm.
 */
function isBlockedCapability(
  capability: SemanticCapability,
): capability is SemanticCapability & { readonly tier: BlockedCapabilityTier } {
  return semanticCapabilityIsBlocked(capability);
}

interface SemanticPhaseOutcome {
  readonly attempted: boolean;
  readonly hits: ReturnType<Store["semanticTopK"]>;
  readonly warnings: string[];
  /**
   * The typed half of {@link warnings} (evidence-at-the-boundary, C2).
   * Every arm below that returns `attempted: false` names why it did, so
   * a caller served keyword-only can tell an unconfigured provider from a
   * quota-exhausted one without matching on a sentence.
   */
  readonly degraded: RetrievalDegradationSink;
}

export async function runSemanticPhase(
  store: Store,
  config: ResolvedSearchConfig,
  query: string,
  opts: { limit: number; pathPrefix: string | undefined; explicit: boolean },
): Promise<SemanticPhaseOutcome> {
  const warnings: string[] = [];
  const degraded: RetrievalDegradationSink = [];

  const counts = store.counts();
  if (counts.embeddings === 0) {
    warnings.push("no compatible embeddings; run: o2b search index --embeddings");
    noteDegradation(degraded, RETRIEVAL_DEGRADATION.semanticEmbeddingsAbsent);
    return { attempted: false, hits: [], warnings, degraded };
  }

  if (!store.vecLoaded()) {
    if (opts.explicit) {
      throw new SearchError(
        "VEC_EXTENSION_UNAVAILABLE",
        "semantic search unavailable: sqlite-vec extension not loaded",
      );
    }
    warnings.push("sqlite-vec unavailable, semantic disabled this session");
    noteDegradation(degraded, RETRIEVAL_DEGRADATION.semanticVecExtensionUnavailable);
    return { attempted: false, hits: [], warnings, degraded };
  }
  // What the OPERATOR CONFIGURED, from the one shared resolver
  // (provenance-at-the-boundary, F1). The two runtime guards above stay
  // where they are: an empty vector table and a missing extension are
  // facts about this index and this machine, not about the configuration.
  //
  // The explicit arm is the one that ATTEMPTED something and could not,
  // so it keeps reporting the typed `SearchError`; the implicit arm
  // refused before attempting and reports the capability. Neither
  // condition is reported both ways.
  //
  // EVERY blocked rung throws on the explicit arm, not just the missing
  // credential: a caller who asked for semantic recall in so many words and
  // was served lexical results with exit 0 was told the search succeeded.
  // Both arms name the condition with the SAME registry sentence, so the
  // warning and the error message cannot drift apart.
  const capability = resolveSemanticCapability(config.semantic);
  if (isBlockedCapability(capability)) {
    const label = await semanticCapabilityLabel(capability.code);
    if (opts.explicit) throw new SearchError(BLOCKED_TIER_ERROR_CODE[capability.tier], label);
    warnings.push(label);
    // The rung is already a closed vocabulary; the label is a registry
    // sentence, which is exactly what the trail must not carry.
    noteDegradation(degraded, RETRIEVAL_DEGRADATION.semanticCapabilityBlocked, {
      tier: capability.tier,
    });
    return { attempted: false, hits: [], warnings, degraded };
  }

  let queryVec: number[];
  try {
    const provider = makeProvider(config.semantic);
    const vectors = await provider.embed([query], "query");
    queryVec = vectors[0] ?? [];
  } catch (e) {
    if (opts.explicit) {
      // Defensive: provider methods are expected to throw SearchError,
      // but wrap anything else (e.g. an unexpected runtime failure)
      // so callers always see a typed code rather than a bare Error.
      if (e instanceof SearchError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new SearchError("EMBEDDING_PROVIDER_HTTP", `embedding provider failure: ${msg}`);
    }
    // Implicit path: degrade to keyword-only, but the warning must say WHY
    // by naming the classification category, and for a quota exhaustion it
    // carries the actionable billing message so the CLI/MCP caller learns
    // the remediation, not just that semantic was skipped.
    const cls = classifyEmbeddingError(e);
    const detail =
      cls.category === "quota"
        ? EMBEDDING_QUOTA_MESSAGE
        : e instanceof Error
          ? e.message
          : String(e);
    warnings.push(`embedding provider unavailable [${cls.category}]: ${detail}`);
    // The category is the classification the warning already computed and
    // then buried in prose; the provider's own message stays out of the
    // trail, which travels into logs and MCP payloads.
    noteDegradation(degraded, RETRIEVAL_DEGRADATION.semanticProviderUnavailable, {
      category: cls.category,
    });
    return { attempted: false, hits: [], warnings, degraded };
  }

  if (queryVec.length === 0) {
    warnings.push("embedding provider returned an empty vector; semantic skipped");
    noteDegradation(degraded, RETRIEVAL_DEGRADATION.semanticEmptyQueryVector);
    return { attempted: false, hits: [], warnings, degraded };
  }

  const hits = store.semanticTopK(queryVec, {
    limit: opts.limit,
    pathPrefix: opts.pathPrefix,
  });
  return { attempted: true, hits, warnings, degraded };
}

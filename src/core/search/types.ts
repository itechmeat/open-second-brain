/**
 * Public types for `src/core/search/*`. Plain data — no behaviour, no I/O.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §12, §14.
 */

import type { VaultIgnoreRule } from "../vault-scope/defaults.ts";
import type { EvidencePack } from "./evidence-pack.ts";
import type { SearchSessionFocus } from "./session-focus.ts";
import type { StructuredRecallQueryDocument } from "./structured-query.ts";

export type { VaultIgnoreRule };

export const SEARCH_ERROR_CODES = [
  "INDEX_MISSING",
  "INDEX_UNREADABLE",
  "SCHEMA_MISMATCH",
  "VEC_EXTENSION_UNAVAILABLE",
  "EMBEDDING_DISABLED",
  "EMBEDDING_KEY_MISSING",
  "EMBEDDING_PROVIDER_HTTP",
  "EMBEDDING_PROVIDER_TIMEOUT",
  "EMBEDDING_DIMENSION_MISMATCH",
  "EMBEDDING_COST_GATE",
  "RERANK_PROVIDER_HTTP",
  "INDEX_LOCKED",
  "INVALID_INPUT",
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

/**
 * Structured per-layer score components (Search & Recall Quality Suite).
 * The numeric sibling of `reasons[]`: where `reasons` formats only the
 * layers that fired as strings, `breakdown` carries every component of
 * the final score as a number, zero for a layer that did not fire and 1
 * for a neutral multiplier. Additive layers (keyword, semantic, rrf,
 * entity, activation, coAccess, link, recency, sessionFocus) are the raw
 * contributions; `tier` and `trend` are the relevance-portion multipliers
 * (1.0 = neutral). The ranker emits it for every primary result; the MCP
 * `explain` projection and `feedback.ts` read it directly instead of
 * re-parsing reason strings.
 */
export interface ScoreBreakdown {
  readonly keyword: number;
  readonly semantic: number;
  readonly rrf: number;
  readonly entity: number;
  readonly activation: number;
  readonly coAccess: number;
  readonly link: number;
  readonly recency: number;
  readonly tier: number;
  readonly trend: number;
  readonly sessionFocus: number;
}

/**
 * Inline per-hit trust metadata (Search & Recall Quality Suite). Computed
 * at read time, never stored. `age_days` is the whole-day distance from
 * the document mtime; `superseded` / `conflict` are derived from the
 * typed relation edges the recall pipeline surfaces (`superseded_by` /
 * `contradicts`). Present on a result only when the caller set `trust`.
 */
export interface TrustMetadata {
  readonly age_days: number;
  readonly superseded: boolean;
  readonly conflict: boolean;
}

export interface BrainSearchResult {
  readonly documentId: number;
  readonly chunkId: number;
  readonly path: string;
  readonly title: string | null;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly keywordScore: number;
  readonly semanticScore: number;
  readonly linkBoost: number;
  readonly recencyBoost: number;
  readonly searchType: "keyword" | "semantic" | "hybrid" | "link";
  /**
   * Explainable recall: one entry per scoring layer that contributed
   * to `score`, formatted `"<layer>: <fixed-precision value>"`. Layers
   * that did not fire (zero contribution) are omitted. Always present;
   * never empty for a result that surfaced.
   */
  readonly reasons: ReadonlyArray<string>;
  /**
   * Typed semantic relations this result's page declares in its
   * frontmatter (v3 / typed graph semantics): `related` / `extends` /
   * `contradicts` / `superseded_by` and any other vocabulary relation.
   * Computed at query time from the links table, never stored on the
   * result row. Absent when the page declares no typed relations.
   */
  readonly relations?: ReadonlyArray<{
    readonly relation: string;
    readonly target: string;
  }>;
  /**
   * Structured per-layer score components (Search & Recall Quality
   * Suite). Always present on a primary ranked result; absent on
   * synthetic results (link-traversal expansions, relation-polarity
   * successor pull-ins) whose score is not a per-layer sum - the
   * `explain` projection derives a faithful breakdown from the
   * first-class lane/boost fields for those. Never serialized to the MCP
   * output unless the caller sets `explain`.
   */
  readonly breakdown?: ScoreBreakdown;
  /**
   * Inline trust metadata (Search & Recall Quality Suite). Present only
   * when the caller set `trust`; computed at read time from the document
   * mtime and the surfaced typed relations, never stored.
   */
  readonly trust?: TrustMetadata;
  /**
   * Kind-namespaced origin label (Workspace Insight Suite, cross-vault
   * search): "local", "profile/<name>", or "source/<alias>". Only set
   * by `searchAcrossVaults`; plain single-vault search leaves it
   * absent, keeping the legacy result shape byte-identical.
   */
  readonly origin?: string;
}

/**
 * Structural query intent (v0.20.0). Derived purely from query shape -
 * quoted phrases, FTS wildcards, wikilinks, entity-token share, token
 * count - never from a natural-language word list. `neutral` trips no
 * rule and keeps ranking bit-identical.
 */
export type QueryIntent = "neutral" | "exact" | "entity" | "broad";

/**
 * Per-query ranking multipliers emitted by the query plan. Each is a
 * bounded multiplier applied to the corresponding ranking layer; the
 * neutral profile is all 1.0 (no effect).
 */
export interface WeightProfile {
  readonly keywordMul: number;
  readonly semanticMul: number;
  readonly entityMul: number;
  readonly recencyMul: number;
}

/**
 * Pure analysis of an incoming query (v0.20.0). Computed once before
 * retrieval and shared by intent-aware ranking (the `weightProfile`) and
 * candidate augmentation (`expandedTerms`, populated by synonym
 * expansion). `planHash` is a stable fingerprint of everything in the
 * plan that affects results - used as part of the query-cache key.
 */
export interface QueryPlan {
  readonly intent: QueryIntent;
  readonly weightProfile: WeightProfile;
  readonly expandedTerms: ReadonlyArray<string>;
  readonly planHash: string;
}

export interface IndexStats {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly chunksTotal: number;
  readonly embeddingsComputed: number;
  readonly embeddingsRetries: number;
  readonly errors: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
  }>;
  /**
   * Typed edges blocked by the schema pack's `link_constraints` during
   * this run's materialization post-pass
   * (write-time-integrity-governance). Empty when no constraints are
   * declared.
   */
  readonly relationViolations: ReadonlyArray<{
    readonly relation: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly sourceType: string;
    readonly targetType: string;
    readonly declared: ReadonlyArray<string>;
  }>;
  /**
   * Identity-tier frontmatter fields whose value changed against the
   * stored snapshot during this run - staged hand-edits awaiting
   * `o2b brain tiers check|restore|accept`
   * (write-time-integrity-governance).
   */
  readonly tierDrift: ReadonlyArray<{
    readonly path: string;
    readonly field: string;
    readonly expected: unknown;
    readonly actual: unknown;
  }>;
  /**
   * Links whose `target_document_id` the alias post-pass materialized
   * through a frontmatter `aliases:` declaration this run
   * (link-recall-intelligence, v7).
   */
  readonly aliasResolved: number;
  /**
   * Backend that processed this run, resolved lazily after content
   * detection (offline code-only extraction, t_85252236). `"offline"`
   * when only the deterministic lexical pipeline ran and no provider
   * credentials were resolved; `"semantic"` when the embedding backend
   * was actually engaged. Additive — the deterministic fields above are
   * unaffected by this field's value.
   */
  readonly backend: "offline" | "semantic";
  /**
   * Human-readable explanation of why the semantic backend was not
   * engaged this run (e.g. embeddings not requested, semantic disabled,
   * or `embedding_api_key` not configured). Null when the semantic
   * backend ran (`backend === "semantic"`).
   */
  readonly deferredReason: string | null;
  readonly durationMs: number;
}

/**
 * State of the optional sqlite-vec extension. `not-attempted` covers
 * the diagnostic path where we never tried to load (e.g. `check` on a
 * vault with semantic disabled); `unknown` covers status snapshots
 * taken before any open has happened (index file missing).
 */
export type VecExtensionState = "loaded" | "unavailable" | "unknown" | "not-attempted";

export interface IndexStatusSnapshot {
  readonly indexPath: string;
  readonly exists: boolean;
  readonly schemaVersion: number | null;
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  readonly staleEmbeddings: number;
  readonly embeddingModel: string | null;
  readonly embeddingDimension: number | null;
  /**
   * Canonical `<provider>:<model>:<dimension>` fingerprint of the ACTIVE
   * embedding configuration (Embedding Provider Suite). Null when
   * semantic search is disabled. Compare with the stored model/dimension
   * to reason about staleness after a config change.
   */
  readonly embeddingSignature: string | null;
  /**
   * Best-effort USD estimate to (re-)embed the chunks that currently
   * lack a current embedding, at the active model's rate. 0 for the
   * local/unknown-price case.
   */
  readonly estimatedRefreshCostUsd: number;
  readonly vecExtension: VecExtensionState;
  readonly semanticEnabled: boolean;
  readonly embeddingKeyPresent: boolean;
  readonly lastIndexedAt: string | null;
  readonly lastFullIndexAt: string | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface IndexCheckReport {
  readonly vaultReadable: boolean;
  readonly indexDirWritable: boolean;
  readonly sqliteOk: boolean;
  readonly fts5Ok: boolean;
  readonly vecExtension: VecExtensionState;
  readonly embeddingKeyResolved: boolean;
  readonly providerReachable: boolean | null;
  readonly providerReason: string | null;
  readonly warnings: ReadonlyArray<string>;
  readonly fatal: ReadonlyArray<string>;
  /**
   * Actionable hints derived from the check state — empty when
   * nothing needs operator attention. The CLI renders these under a
   * `recommendations:` block; the JSON exposes them under the same
   * key so headless callers (Hermes cron, CI) can act on them.
   */
  readonly recommendations: ReadonlyArray<string>;
}

/**
 * Result-depth disclosure mode (progressive 3-layer recall). `full`
 * (default) is the historical flat search: every hit carries its full
 * chunk content. `cards` returns compact layer-1 {@link SearchCard}s
 * instead — path/title/score/reasons/snippet/pointer, no full content —
 * so recall stays token-cheap and the agent pays for depth only by
 * calling `expandHit` (layer 2 fuller note, layer 3 raw transcript).
 *
 * This is NOT the query-lane `expand` flag on {@link SearchOptions}:
 * that broadens the candidate query, this shapes how much of each
 * surfaced result is disclosed.
 */
export type DisclosureMode = "full" | "cards";

/**
 * Layer-1 compact card (progressive disclosure). The token-cheap
 * projection of a ranked {@link BrainSearchResult}: identity, score,
 * the same explainable `reasons`, a bounded `snippet`, and a
 * `path:Lstart-Lend` line pointer (D2 grammar) — but never the full
 * chunk content. Drill to layer 2/3 via `expandHit({ chunkId })`.
 */
export interface SearchCard {
  readonly chunkId: number;
  readonly documentId: number;
  readonly path: string;
  readonly title: string | null;
  readonly score: number;
  readonly reasons: ReadonlyArray<string>;
  readonly snippet: string;
  /** `path:Lstart-Lend` (or single-line `path:Lstart`) line pointer. */
  readonly pointer: string;
  /** Cross-vault origin label, mirrored from the source result when set. */
  readonly origin?: string;
}

export interface ExpandHitInput {
  readonly chunkId: number;
  /** Raw-chunk page size for layer 3 (default 10). */
  readonly rawLimit?: number;
  /** Opaque pagination cursor returned as `next_cursor` by a prior call. */
  readonly cursor?: string;
}

/**
 * Layer-2 fuller note: the hit's whole document, reconstructed from the
 * store's chunk rows (no new index, no disk read), with the line span it
 * occupies and a `path:Lstart-Lend` pointer.
 */
export interface ExpandedNote {
  readonly documentId: number;
  readonly path: string;
  readonly title: string | null;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly pointer: string;
  readonly content: string;
}

/** Layer-3 raw chunk (the indexed transcript), one page entry. */
export interface ExpandedRawChunk {
  readonly chunkId: number;
  readonly chunkIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly pointer: string;
  readonly content: string;
}

/**
 * `expandHit` result, mirroring `expandSessionRecall`: the fuller note
 * (layer 2) and a paginated slice of the document's raw chunks (layer 3),
 * with a `next_cursor` that is null once the transcript is exhausted.
 */
export interface ExpandHitResult {
  readonly chunkId: number;
  readonly note: ExpandedNote;
  readonly raw_content: ReadonlyArray<ExpandedRawChunk>;
  readonly next_cursor: string | null;
}

export interface SearchOptions {
  readonly query: string;
  readonly limit?: number;
  readonly semantic?: boolean | null;
  readonly keywordOnly?: boolean;
  readonly pathPrefix?: string;
  readonly keywordWeight?: number;
  readonly semanticWeight?: number;
  /**
   * Property filter map (v0.10.17). Each key maps to one or more
   * accepted scalar values. Within one key the match is OR; across
   * keys it is AND. The filter is applied as a post-rank phase
   * against the source frontmatter of each result. Absent map = no
   * filter (existing behaviour).
   */
  readonly properties?: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * Per-query MMR override (v0.13.0). Absent uses the resolved config
   * default; `1` disables diversification for this query.
   */
  readonly mmrLambda?: number;
  /**
   * Per-query link-graph traversal depth (v0.13.0). Absent uses the
   * resolved config default; `0` disables traversal for this query.
   */
  readonly maxHops?: number;
  /**
   * Requested content-visibility scope (v3 / typed graph semantics).
   * Pages with no `visibility:` frontmatter are always returned;
   * a page that declares visibility values is returned only when this
   * scope includes one of them. Absent/empty = default scope (reaches
   * untagged pages only). See src/core/graph/visibility.ts.
   */
  readonly visibility?: ReadonlyArray<string>;
  /**
   * Requested agent-ownership scope (Unit 5). When set, a page that
   * declares an `owner:` frontmatter token is returned only if its owner
   * equals this scope; ownerless (shared) pages are always returned.
   * Absent/empty = no ownership filtering at all, so results are
   * byte-identical to today. See src/core/graph/agent-scope.ts.
   */
  readonly agentScope?: string;
  /** Optional parsed structured recall query document. Plain-string search ignores this. */
  readonly structuredQuery?: StructuredRecallQueryDocument;
  /**
   * Opt-in deterministic query expansion (link-recall-intelligence,
   * t_2fa95db1): when true and no `structuredQuery` was supplied, the
   * bare query is expanded into lex/vec/hyde lanes locally before
   * retrieval. Never silently active.
   */
  readonly expand?: boolean;
  /**
   * Result-depth disclosure (progressive 3-layer recall). `full`
   * (default) keeps the flat full-content result shape byte-identical;
   * `cards` returns compact {@link SearchCard}s on `SearchOutcome.cards`
   * and an empty `results`, so the caller pays for depth only by calling
   * `expandHit`. Distinct from the query-lane `expand` flag above.
   */
  readonly disclosure?: DisclosureMode;
  /**
   * Optional named recall profile (Recall & Working-Memory Quality Suite,
   * t_98c39dd6): `fast | balanced | thorough` expand to a fixed knob tuple
   * applied through the same machinery as the self-tuning grid. An explicit
   * profile takes precedence over a persisted self-tuning grid point. Absent
   * leaves ranking on the existing config path, byte-for-byte. An unknown
   * name fails loud (`SearchError("INVALID_INPUT")`). See `profiles.ts`.
   */
  readonly profile?: string;
  /** Optional per-query or persisted session focus steering. Undefined means load persisted focus. */
  readonly sessionFocus?: SearchSessionFocus | null;
  /**
   * Session id for scoped focus resolution (Agent Surface Suite,
   * t_5b478e47). Applies only when `sessionFocus` is undefined: the
   * persisted focus lookup checks `search-focus/<scope>.json` first
   * and falls back to the global focus file.
   */
  readonly focusSession?: string;
  /** Opt-in verified evidence pack diagnostics. Omitted preserves the legacy search outcome shape. */
  readonly evidencePack?: boolean;
  /**
   * Access recording (Time-Aware Recall & Activation Suite). When true,
   * the surfaced result paths are recorded as one activation access
   * event AFTER ranking completes - the current query's own ranking is
   * never affected by its own recording, and cache hits never record.
   * Default false: the pure core stays read-only; CLI/MCP surfaces opt
   * in explicitly.
   */
  readonly recordAccess?: boolean;
  /**
   * History mode for relation polarity (recall-trust-suite). When true a
   * matched predecessor (`superseded_by` declarer) keeps its rank and no
   * successor is pulled in; informational reasons still land. Default
   * false: stale predecessors are demoted below their successor.
   */
  readonly includeSuperseded?: boolean;
  /**
   * Time-aware recall (recall-trust-suite). Accepts ISO dates and
   * datetimes, `today` / `yesterday` / `last week` / `last month`, and
   * `<n>h` / `<n>d` / `<n>w` shorthand — see `time-range.ts`. Filters
   * candidates by document mtime before ranking. Time-filtered queries
   * bypass the query cache (a relative range resolves to a different
   * absolute window every call).
   */
  readonly since?: string;
  readonly until?: string;
  /**
   * Inline trust metadata (Search & Recall Quality Suite). When true,
   * each surfaced result carries a computed-at-read-time `trust` object
   * (age in days, superseded, conflict) derived from the document mtime
   * and the surfaced typed relations. Off by default; absent leaves the
   * result shape byte-identical.
   */
  readonly trust?: boolean;
  /**
   * Relevance floor (Search & Recall Quality Suite). When > 0, results
   * whose final normalized score is below this value are dropped before
   * the diversity rerank, so a query with no sufficiently relevant memory
   * returns no match instead of weak noise. Absent / 0 disables the
   * filter and keeps results byte-identical. Applied against the clamped
   * [0, 1] final score, so it is meaningful in both linear and rrf
   * fusion.
   */
  readonly threshold?: number;
  /**
   * Relevance rerank (Search & Recall Quality Suite). When true, the
   * threshold-qualified candidates are re-ordered by core textual
   * relevance (keyword + semantic lanes) before the final slice - a
   * deeper-relevance second pass. Off by default; absent leaves ordering
   * unchanged.
   */
  readonly rerank?: boolean;
  /**
   * Self-tuning reinforce (Search & Recall Quality Suite). When present
   * (even empty), the persisted reinforce ledger lifts proven-useful
   * memories by a bounded boost before the top_k cut. A non-empty list is
   * also recorded to the ledger by the calling surface. Absent leaves
   * ranking byte-identical; surfaced-only frequency never boosts.
   */
  readonly reinforce?: ReadonlyArray<string>;
  /**
   * Self-healing index policy (Workspace Insight Suite). Default true:
   * a missing or schema-stale index is rebuilt once and the search
   * retried. `searchAcrossVaults` passes false for non-active origins
   * so a read-only external vault is NEVER written to - its missing
   * index surfaces as a per-origin warning instead.
   */
  readonly selfHeal?: boolean;
}

export interface SearchOutcome {
  readonly results: ReadonlyArray<BrainSearchResult>;
  readonly warnings: ReadonlyArray<string>;
  readonly total: number;
  /**
   * Layer-1 compact cards (progressive disclosure). Present only when the
   * caller set `disclosure: "cards"`; in that mode `results` is empty and
   * `total` counts the cards. Absent on the default `full` path, keeping
   * the legacy outcome shape byte-identical.
   */
  readonly cards?: ReadonlyArray<SearchCard>;
  readonly evidencePack?: EvidencePack;
  /**
   * Self-correcting two-pass recall (Time-Aware Recall & Activation
   * Suite, t_ef92dfdc; coverage-driven targeted retry, t_8eb5ca32).
   * Present only when a single follow-up retry fired in evidence-pack
   * mode. `kind` distinguishes the two triggers, which are mutually
   * exclusive (at most one retry per query):
   *   - `"broadened"`: a ZERO-candidate first pass ran one broadened
   *     OR retry over all significant terms.
   *   - `"targeted"`: a non-empty first pass left rare query terms
   *     uncovered (partial coverage below the completeness threshold)
   *     and ran one retry aimed at exactly those uncovered rare terms,
   *     listed in `targetedTerms`.
   */
  readonly secondPass?: {
    readonly triggered: true;
    readonly kind: "broadened" | "targeted";
    readonly reason: string;
    /** Candidate hits the retry pass contributed to the pool. */
    readonly added: number;
    /** The uncovered rare terms re-queried by a `"targeted"` retry. */
    readonly targetedTerms?: ReadonlyArray<string>;
  };
  /**
   * Normalized-confidence chain-stop (t_23c1b929). Present only when
   * `searchAcrossVaults` ran with `chainStopEnabled` and a completed origin's
   * top normalized score reached the threshold, so the remaining origins were
   * skipped. `stoppedAfter` is the origin label that cleared the threshold;
   * `skipped` lists the origin labels that were not searched. Absent whenever
   * the chain-stop is off or never triggered, keeping the outcome shape
   * byte-identical to single-vault search.
   */
  readonly chainStop?: {
    readonly triggered: true;
    readonly stoppedAfter: string;
    readonly skipped: ReadonlyArray<string>;
  };
}

export interface ResolvedEmbeddingConfig {
  readonly enabled: boolean;
  readonly provider: "openai-compat" | "disabled" | "local";
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
  readonly dimension: number | null;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly batchSize: number;
  /**
   * Spend ceiling in USD for a single embedding run (Embedding Provider
   * Suite). 0 (default) disables the gate. When positive, an embedding
   * run whose estimated cost exceeds this is refused unless forced.
   */
  readonly costGateUsd: number;
}

/**
 * Optional cross-encoder rerank stage (retrieval-precision-quality-loop,
 * card A). A learned final reader step that re-scores the top-K fused
 * candidates jointly against the query, appended after the heuristic
 * reranks. Off by default (`enabled: false`), in which case the stage is
 * a zero-cost no-op and result ordering is byte-identical to the
 * pre-feature baseline. When enabled, the endpoint (OpenAI-compatible
 * `/rerank`) is resolved fail-closed through
 * `resolveOpenAiCompatEndpoint`; on any endpoint error the stage degrades
 * to the heuristic ordering and never throws into the hot path.
 */
export interface ResolvedRerankConfig {
  readonly enabled: boolean;
  /** OpenAI-compatible base URL (trailing slashes stripped) or null. */
  readonly baseUrl: string | null;
  readonly model: string | null;
  /** Env var NAME the API key is read from (never the key itself). */
  readonly envKey: string | null;
  /** API key resolved from `envKey` at config-resolution time, else null. */
  readonly apiKey: string | null;
  /** How many top fused candidates to re-score. Must be >= 1. */
  readonly topK: number;
  /**
   * Relevance floor in the cross-encoder's score space. A reranked
   * candidate scoring below this is not promoted above candidates the
   * heuristic ranker placed higher; it sinks below the qualifying
   * candidates but is never dropped (result count is preserved). Default
   * 0 promotes every candidate a non-negative-scoring endpoint returns.
   */
  readonly minScore: number;
}

/**
 * Recall-quality tunables (v0.13.0). Each layer is bounded and
 * deterministic; the defaults enable the layer while leaving a clear
 * off switch (`mmrLambda = 1`, `maxHops = 0`). A vault that never opts
 * out ranks by the documented defaults.
 */
export interface ResolvedRecallConfig {
  /** MMR relevance-vs-diversity tradeoff in [0, 1]; 1 disables MMR. */
  readonly mmrLambda: number;
  /** Link-graph traversal hop depth during recall; 0 disables. */
  readonly maxHops: number;
  /** Per-hop score multiplier in (0, 1]. */
  readonly hopDecay: number;
  /** Cap on outbound links followed per node. */
  readonly maxExpansionPerHit: number;
  /**
   * Weibull recency decay curve (v0.20.0). `recencyShape` is the Weibull
   * shape k (> 0); `recencyScale` is the characteristic lifetime in days
   * (> 0); `recencyAmplitude` is the maximum boost at age 0, in [0, 1].
   * Amplitude 0 disables the recency layer. See `recency.ts`.
   */
  readonly recencyShape: number;
  readonly recencyScale: number;
  readonly recencyAmplitude: number;
  /**
   * Query-intent classification (v0.20.0). When true (default) the query
   * plan's weight profile re-weights ranking per detected intent; when
   * false the neutral profile is used and ranking is bit-identical to
   * pre-intent behaviour.
   */
  readonly intentEnabled: boolean;
  /**
   * Synonym / query expansion (v0.20.0). Off by default: expansion
   * broadens the candidate set via local co-occurrence, so it changes
   * results and is opt-in. `synonymMaxTerms` caps how many expansion
   * terms are OR'd onto the query. Always suppressed for exact-intent
   * (quoted/wildcard) queries. See `synonyms.ts`.
   */
  readonly synonymEnabled: boolean;
  readonly synonymMaxTerms: number;
  /**
   * Persistent query cache (v0.20.0). Off by default: when enabled,
   * `search()` serves a previously computed result for an identical
   * request as long as the corpus generation is unchanged and the row is
   * within `cacheTtlSeconds`. A cache hit is the result that was
   * computed and stored; generation changes (embedding change or content
   * reindex) and TTL expiry invalidate it.
   */
  readonly cacheEnabled: boolean;
  readonly cacheTtlSeconds: number;
  /**
   * Relation-aware recall polarity (recall-trust-suite). When true
   * (default) typed relation edges affect ranking: `superseded_by`
   * demotes the matched predecessor and boosts/pulls in the successor,
   * `contradicts` adds warning reasons, positive relations grant a small
   * bounded boost. Vaults without typed relations rank bit-identically
   * either way; this switch exists as the explicit kill switch.
   */
  readonly relationPolarityEnabled: boolean;
  /**
   * Retrieval feedback loop (recall-trust-suite). Off by default: when
   * true, learned per-layer multipliers derived from explicit recall
   * feedback (`Brain/search/learned-weights.json`) compose with the
   * intent weight profile during ranking. Bounded, deterministic,
   * resettable — see `feedback.ts`.
   */
  readonly learnedWeightsEnabled: boolean;
  /**
   * Access-reinforced activation (Time-Aware Recall & Activation
   * Suite). On by default: recorded access events under
   * `Brain/search/activation/` feed a bounded, type-decayed activation
   * boost and co-access companion boost. A vault without recorded
   * events ranks bit-identically either way; this switch exists as the
   * explicit kill switch.
   */
  readonly activationEnabled: boolean;
  /**
   * Self-correcting two-pass recall (t_ef92dfdc; coverage-driven
   * targeted retry, t_8eb5ca32). On by default and the kill switch for
   * BOTH retry triggers in evidence-pack mode: a zero-candidate first
   * pass runs one broadened OR retry, and a non-empty first pass whose
   * IDF-weighted coverage falls below the completeness threshold with
   * rare terms still uncovered runs one targeted retry aimed at those
   * uncovered rare terms. At most one retry fires per query. Plain
   * (non-evidence-pack) searches never retry either way.
   */
  readonly twoPassEnabled: boolean;
  /**
   * Keyword candidate-pool width as a multiple of the requested limit
   * (link-recall-intelligence, t_ae973491). Default 3 preserves the
   * historical `limit * 3` FTS pools; the self-tuner may select 4 or
   * 5. The semantic pool keeps its own `max(limit * 5, 50)` floor.
   */
  readonly poolMultiplier: number;
  /**
   * Opt-in self-tuning recall (t_ae973491). When true, `search()`
   * applies the bounded parameters persisted in
   * `Brain/search/tuning.json` (validated on read, fail-soft to the
   * configured defaults). Off by default - tuning never activates
   * silently.
   */
  readonly selfTuningEnabled: boolean;
  /**
   * Normalized-confidence chain-stop for cross-vault recall (t_23c1b929).
   * Off by default: when true, `searchAcrossVaults` stops querying further
   * origins as soon as a completed origin's top NORMALIZED [0,1] result
   * score reaches `chainStopScore`, recording the skipped origins. Gates on
   * the normalized result score, never the raw lane score, so a tiny-corpus
   * origin with a high raw score but a low normalized score never
   * short-circuits. Default-off keeps cross-vault results bit-identical.
   */
  readonly chainStopEnabled: boolean;
  /** Normalized-score threshold in [0, 1] that triggers the chain-stop. */
  readonly chainStopScore: number;
}

export interface ResolvedSearchConfig {
  readonly vault: string;
  readonly dbPath: string;
  /**
   * Vault-wide exclusion rules. Resolved through
   * `src/core/vault-scope` from `<vault>/Brain/_brain.yaml` →
   * `vault.ignore_paths`; falls back to the shared built-in default
   * set when the block is not declared. The legacy
   * `search_ignore_paths` config key and the
   * `OPEN_SECOND_BRAIN_SEARCH_IGNORE` env variable were removed in
   * v0.10.9.
   */
  readonly ignoreRules: ReadonlyArray<VaultIgnoreRule>;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  /**
   * Chunk floor (min tokens) — the heading-boundary flush threshold in
   * the markdown chunker (`minTokens`). Resolved from
   * `search_chunk_min_size` / `OPEN_SECOND_BRAIN_SEARCH_CHUNK_MIN_SIZE`.
   * Default 100 (the chunker's `DEFAULT_MIN_TOKENS`); kept stable so
   * vaults that don't set it hash identical chunks across Syncthing
   * peers. Must be ≥ 1 and ≤ `chunkSize`.
   */
  readonly chunkMinSize: number;
  readonly keywordWeight: number;
  readonly semanticWeight: number;
  /**
   * Rank-fusion mode (Embedding Provider Suite). `linear` (default) is
   * the weighted sum of normalised BM25 and cosine; `rrf` fuses the two
   * lanes by reciprocal rank. `linear` keeps ranking bit-identical to
   * pre-suite behaviour.
   */
  readonly fusionMode: "linear" | "rrf";
  /** Reciprocal Rank Fusion damping constant (only used when rrf). */
  readonly rrfK: number;
  readonly semantic: ResolvedEmbeddingConfig;
  readonly recall: ResolvedRecallConfig;
  /**
   * Optional cross-encoder rerank stage (retrieval-precision-quality-loop,
   * card A). Off by default; when off the reader tail is byte-identical to
   * the pre-feature baseline.
   */
  readonly rerank: ResolvedRerankConfig;
  /**
   * Grace window (ms) the `o2b search watch` shutdown waits for an
   * in-flight index pass to settle at a cooperative boundary before
   * exiting (Indexer Durability suite). `0` exits immediately after
   * signalling the abort, without awaiting. Default 5000.
   */
  readonly shutdownGraceMs: number;
  /**
   * When true, an interrupted full `reindexVault` rebuild resumes a
   * compatible `brain.sqlite.new` staging build instead of discarding
   * it. Opt-in; default false keeps the always-fresh rebuild. Resume is
   * gated on a signature marker, so a drifted staging DB is rebuilt.
   */
  readonly resumeReindex: boolean;
}

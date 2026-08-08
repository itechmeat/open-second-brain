/**
 * Public types for `src/core/search/*`. Plain data — no behaviour, no I/O.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §12, §14.
 *
 * This module AGGREGATES: it names the leaf types its own dependents own
 * (`DegreePredicate`, `TemporalIntent`, the trust receipts) inside the
 * option / outcome shapes. The two things those dependents need back -
 * the {@link SearchError} carrier and the ranked-hit row - therefore live
 * in leaf modules of their own (`search-error.ts`, `search-result.ts`)
 * and are re-exported here, so no dependent has to point at the
 * aggregate. Import surface unchanged: every symbol this module exported
 * before is still exported from this path.
 */

import type { DegradationNotice } from "../integrity/degradation.ts";
import type { StampMismatch } from "../integrity/stamp.ts";
import type { VaultIgnoreRule } from "../vault-scope/defaults.ts";
import type { DegreePredicate } from "./property-filter.ts";
import type { TemporalIntent } from "./temporal-intent.ts";
import type { BrainSearchResult, ScoreBreakdown, TrustMetadata } from "./search-result.ts";
import type {
  MemoryTrustAssessment,
  RetrievalDecisionTrace,
} from "../brain/trust/retrieval-receipts.ts";

export type { VaultIgnoreRule };
export type { BrainSearchResult, ScoreBreakdown, TrustMetadata };
export {
  EMBEDDING_QUOTA_MESSAGE,
  SEARCH_ERROR_CODES,
  SearchError,
  type EmbeddingErrorCategory,
  type SearchErrorCode,
  type SearchErrorOptions,
} from "./search-error.ts";

/**
 * Structural query intent (v0.20.0). Derived purely from query shape -
 * quoted phrases, FTS wildcards, wikilinks, entity-token share, token
 * count - never from a natural-language word list. `neutral` trips no
 * rule and keeps ranking bit-identical.
 */
export type QueryIntent = "neutral" | "exact" | "entity" | "broad";

/**
 * Retrieval-surface routing decision (t_7b96f242). A deterministic,
 * structural determination layered onto the query plan that names which
 * retrieval surface a query is shaped for. `default` is the generic
 * hybrid-search surface (byte-identical to today); `summary` is the
 * summary-search surface - reached for source-targeted queries and queries
 * naming an artifact kind from the schema vocabulary. The field is advisory
 * (it re-weights nothing) and is `default` for every query unless a caller
 * supplies the surface vocabulary, so the pure default is provably inert.
 */
export type QuerySurface = "default" | "summary";

/** One parsed `lex:` lane of a structured recall query document. */
export interface StructuredLexLane {
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}

/**
 * A parsed structured recall query document: explicit intent plus the
 * lex / vec / hyde retrieval lanes. Parsed by `structured-query.ts`.
 */
export interface StructuredRecallQueryDocument {
  readonly intent: QueryIntent | null;
  readonly lex: StructuredLexLane;
  readonly vec: ReadonlyArray<string>;
  readonly hyde: ReadonlyArray<string>;
}

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
  /**
   * Retrieval-surface routing decision (t_7b96f242). Advisory only: it
   * never enters `planHash` and never re-weights ranking, so a query's
   * results are byte-identical regardless of its value. `default` unless
   * the caller supplied a surface vocabulary AND the query is structurally
   * summary-shaped. See {@link QuerySurface}.
   */
  readonly surface: QuerySurface;
  /**
   * The time window this query declares (t_58fc4720), resolved to
   * absolute bounds. Present only when the caller supplied a clock AND
   * the query carries an ISO token or a `since:` / `until:` directive;
   * absent otherwise, so a query with no temporal window keeps a
   * byte-identical plan and `planHash`. See {@link TemporalIntent}.
   */
  readonly temporalIntent?: TemporalIntent;
}

/**
 * Result of the oversize-chunk census: what the configured chunk size
 * actually produced, measured against the configured embedding model's
 * DECLARED input window.
 *
 * The census owns a token ESTIMATE, not a tokenizer, so it answers with a
 * two-sided bound and three reportable states rather than a boolean:
 *
 *   - `over-window`  - the low estimate already exceeds the window, so
 *     the request is over it whatever the real tokenizer does;
 *   - `estimate-undecided` - the low estimate fits and the high estimate
 *     does not. Characters-over-four is a Latin-script rule of thumb; on
 *     Han text a BERT-family tokenizer is roughly character-level, and on
 *     supplementary-plane text SQLite and JavaScript disagree about what
 *     a "character" is. In that band the census cannot tell, and says so;
 *   - `window-undeclared` - the model is outside the curated preset
 *     table, so there is no window to compare against at all.
 *
 * "The census ran and every chunk fits under BOTH bounds" is the ABSENCE
 * of this value - a check with nothing to report has nothing to say, and
 * a field that is present-and-zero is a field every consumer has to
 * interpret. Absence is only ever produced when the bound the code can
 * actually back was cleared; the two states it cannot back are the two
 * verdicts above, which is what stops silence from meaning a pass the
 * estimate never earned.
 *
 * The census is not taken at all when there is no model whose window
 * could be exceeded - semantic search disabled, or the offline local
 * embedder, which hashes features over the whole text and has no input
 * window by construction.
 */
export type ChunkWindowCensus =
  | {
      /** Chunks were measured and some exceed the declared window. */
      readonly verdict: "over-window";
      /** The active embedding model the window was declared for. */
      readonly model: string;
      /** The model's declared window, in the model's own tokens. */
      readonly windowTokens: number;
      /** Chunks whose LOW estimate exceeds `windowTokens`. */
      readonly chunksOverWindow: number;
      /**
       * Chunks in the undecided band beside them. Absent, never zero,
       * when the estimate decided every remaining chunk - an all-ASCII
       * index has no band, and its record carries the bytes it carried
       * before this field existed.
       */
      readonly chunksUndecided?: number;
      /** Chunks the census looked at. */
      readonly chunksMeasured: number;
    }
  | {
      /**
       * Every chunk clears the low estimate, but some do not clear the
       * high one: the census measured them and cannot say.
       */
      readonly verdict: "estimate-undecided";
      /** The active embedding model the window was declared for. */
      readonly model: string;
      /** The model's declared window, in the model's own tokens. */
      readonly windowTokens: number;
      /** Chunks the estimate cannot place on either side of the window. */
      readonly chunksUndecided: number;
      /** Chunks the census looked at. */
      readonly chunksMeasured: number;
    }
  | {
      /** No window is declared for this model, so nothing was measured. */
      readonly verdict: "window-undeclared";
      /** The active model, or null when none is configured. */
      readonly model: string | null;
      /** Chunks the census WOULD have looked at. */
      readonly chunksMeasured: number;
    };

/**
 * The census member that reports a check which could not run. Narrowed
 * out of {@link ChunkWindowCensus} rather than redeclared, so the two
 * surfaces that carry it cannot drift on its fields.
 */
export type ChunkWindowUndeclared = Extract<ChunkWindowCensus, { verdict: "window-undeclared" }>;

/**
 * Registered diagnostic codes for the two census verdicts, resolved
 * through `core/brain/next-step.ts`. Declared beside the verdict they
 * belong to so the core surface that formats the warning and the CLI
 * surface that serializes the record cannot drift on which code names
 * which state.
 */
export const CHUNK_WINDOW_CODE = Object.freeze({
  "over-window": "search-chunk-window-overflow",
  // The same exit as measured overflow, and deliberately: the two states
  // differ in what the census KNOWS, not in what an operator does about
  // it. Chunks the estimate cannot place inside the window are fixed by
  // the one lever that fixes chunks known to be outside it - lower
  // `search_chunk_size` and rebuild - so pointing somewhere else would
  // invent a second remedy for one cause.
  "estimate-undecided": "search-chunk-window-overflow",
  "window-undeclared": "search-chunk-window-undeclared",
} as const);

/** The registered diagnostic code for a census verdict. */
export function chunkWindowDiagnosticCode(census: ChunkWindowCensus): string {
  return CHUNK_WINDOW_CODE[census.verdict];
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
   * Frontmatter lines this run's scanner could not express as a
   * `key: value` pair or a block-list item, and therefore dropped
   * (unit F). The `path` on each notice is vault-relative.
   *
   * A separate field rather than an entry in `errors` on purpose:
   * `errors` means "this file did not index", drives the `N error(s)`
   * count in the watch summary, and is rendered under an `errors:`
   * heading by `o2b search index`. A dropped frontmatter line is none
   * of those - the file indexes fine, it just lost a field. Folding it
   * into `errors` would change the meaning of an existing field and the
   * reported error count for vaults that index cleanly today.
   *
   * Scoped to the files this run actually read: the mtime/size fastpath
   * skips unchanged documents, so an unchanged malformed file is
   * reported by the run that last read it, not by every run. Use
   * `--force` (or `o2b brain doctor`, which scans the Brain tree
   * unconditionally) for a full sweep.
   */
  readonly frontmatterNotices: ReadonlyArray<DegradationNotice>;
  /**
   * Indexed documents whose EVENT ANCHOR has never been resolved by an
   * anchor-aware binary (v11) - the rows a pre-anchor index carried
   * across the in-place schema migration.
   *
   * Not the same as "documents that declare no date": that verdict is
   * recorded, this is its absence. It cannot fall to zero on its own,
   * because both content-identity fastpaths correctly decline to
   * recompute an anchor for content that did not change and those
   * documents' content never changes. `o2b search event-anchor-backfill
   * --apply` is what closes it.
   */
  readonly eventAnchorsPending: number;
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
  /**
   * Oversize-chunk census over the index this run left behind. Present
   * ONLY when it has something to report: chunks that exceed the
   * configured model's declared input window, chunks the estimate cannot
   * place inside it, or a model for which no window is declared and the
   * check therefore did not run. Absent when the census cleared BOTH of
   * its bounds, and absent when there is no model whose window could be
   * exceeded - so a run that has nothing to say about it emits the bytes
   * it emitted before this field existed.
   */
  readonly chunkWindow?: ChunkWindowCensus;
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
  /**
   * Embedding-ABI fields whose recorded token no longer matches this
   * build, as the GATED read open found them (context-integrity-gates,
   * Unit E). Structurally empty whenever `integrity.embedding_abi` is
   * `off`, which is what distinguishes this from the ungated
   * {@link IndexCheckReport.embeddingAbi}: `search check` is a
   * diagnostic the operator explicitly ran and refuses nothing, while
   * status reports what the serving path actually enforced.
   *
   * The same condition also appears in {@link warnings} as one
   * operator-facing line. This field is the machine-readable side of
   * it, so an agent does not have to match on message text; both are
   * emitted only when there is drift.
   */
  readonly embeddingAbi: ReadonlyArray<StampMismatch>;
  /**
   * The oversize-chunk census's UNMEASURABLE state: the configured
   * embedding model is outside the curated preset table, so it declares
   * no input window and no chunk could be compared against one. Present
   * only in that state, which makes this surface distinguish four things
   * a single boolean could not - measured clean under both bounds
   * (absent, and no warning), measured overflow and measured-undecidable
   * (absent here, one line each in {@link warnings}), and not measurable
   * at all (this field).
   *
   * Deliberately NOT a warning, unlike the overflow it sits beside. The
   * convention this snapshot already follows is that the structured
   * field says WHAT is true and the warning says what to run; there is
   * no command that declares a window for someone else's model, and a
   * line repeated on every status call for the majority of real
   * configurations is what teaches operators to stop reading warnings.
   * Reporting it as a field keeps the statement - nothing here claims
   * the check passed - without spending the warning channel on it.
   */
  readonly chunkWindowUndeclared?: ChunkWindowUndeclared;
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
  /**
   * Embedding-ABI fields whose token recorded in the index no longer
   * matches this build - model, dimension, or sqlite-vec version
   * (context-integrity-gates, Unit E). Empty when they agree, when
   * there is no index to read, or when semantic search is disabled;
   * the CLI emits the field only when non-empty, so a matching store's
   * output is byte-identical.
   *
   * `expected` is what the index recorded and `actual` what this build
   * would produce; an `expected` of `null` is a store written before the
   * field was stamped, which is reported and never treated as wrong.
   */
  readonly embeddingAbi: ReadonlyArray<StampMismatch>;
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
  /**
   * Locations of the exact duplicates folded into this row
   * (what-the-index-already-knew, task D), as `path:Lstart-Lend`
   * pointers in the same grammar as {@link SearchCard.pointer}.
   *
   * Pointers rather than the full {@link DuplicatePassageLocation}
   * records the ranked row carries: a folded passage is byte-identical to
   * the surviving one, so the caller never needs to expand a copy — it
   * needs to know where else the same bytes live, and a card exists to be
   * small.
   *
   * Present ONLY when at least one byte-identical passage was merged
   * away, so a corpus that holds no duplicate passages produces cards
   * byte-identical to pre-merge ones. Never empty when present.
   */
  readonly duplicatePointers?: ReadonlyArray<string>;
}

export interface ExpandHitInput {
  readonly chunkId: number;
  /** Raw-chunk page size for layer 3 (default 10). */
  readonly rawLimit?: number;
  /** Opaque pagination cursor returned as `next_cursor` by a prior call. */
  readonly cursor?: string;
  /**
   * Owner-scope isolation (context-integrity-gates, Unit A). `chunkId`
   * is a sequential integer, so an unchecked drill-down enumerates whole
   * note bodies. Under a scope, another owner's chunk is refused with
   * the SAME error an absent chunk produces - a distinguishable refusal
   * would confirm the chunk exists. Omitted / blank filters nothing.
   */
  readonly agentScope?: string;
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

/** Active session-focus steering. Persisted/parsed by `session-focus.ts`. */
export interface SearchSessionFocus {
  readonly query: string | null;
  readonly pathPrefix: string | null;
  readonly expiresAt: number | null;
}

/** One bounded grid point in the self-tuning parameter space (`tuning.ts`). */
export interface TunedParameters {
  readonly poolMultiplier: number;
  readonly traversalDepth: number;
  readonly learnedWeights: boolean;
  readonly expansion: boolean;
}

export interface EvidenceRecord {
  readonly path: string;
  readonly documentId: number;
  readonly chunkId: number;
  /**
   * Read-time line-anchored citation for this chunk, formatted
   * `path:Lstart-Lend` (or `path:Lstart` for a single line) from the chunk's
   * 1-based `startLine`/`endLine`. Resolves by opening the file and slicing
   * the range with {@link extractLineRange}; the stored bytes are never
   * mutated, so the pointer stays valid across idempotent re-mining.
   */
  readonly linePointer: string;
  readonly matchedTerms: ReadonlyArray<string>;
  readonly missingTerms: ReadonlyArray<string>;
  readonly supportCoverage: number;
  readonly terminalState: boolean;
  readonly whyRetrieved: ReadonlyArray<string>;
  readonly droppedCandidateReasons: ReadonlyArray<string>;
}

/**
 * One per-token recall-union record (recall-trust-suite, Feature C): a
 * document fetched specifically because it covers a significant term
 * the ranked result set left uncovered. Union records live in the pack
 * only — the primary `results` contract stays untouched.
 */
export interface EvidenceUnionRecord {
  readonly term: string;
  readonly path: string;
  readonly documentId: number;
  readonly chunkId: number;
}

export type CompletenessVerdict = "complete" | "partial" | "sparse";

/**
 * Search-completeness guard (Feature E): a deterministic verdict over
 * how well the returned results cover the query, plus the
 * false-absence guard — uncovered terms the corpus DOES contain. A
 * summarizer seeing a term in `uncoveredButPresentInCorpus` cannot
 * honestly claim the vault has nothing on it.
 */
export interface CompletenessReport {
  readonly verdict: CompletenessVerdict;
  readonly idfWeightedCoverage: number;
  readonly coveredTerms: ReadonlyArray<string>;
  readonly uncoveredTerms: ReadonlyArray<string>;
  readonly uncoveredButPresentInCorpus: ReadonlyArray<string>;
}

export interface EvidencePack {
  readonly significantTerms: ReadonlyArray<string>;
  readonly matchedTerms: ReadonlyArray<string>;
  readonly missingTerms: ReadonlyArray<string>;
  readonly supportCoverage: number;
  readonly records: ReadonlyArray<EvidenceRecord>;
  readonly droppedCandidates: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
  readonly abstention: string | null;
  /**
   * IDF-weighted support coverage (Feature C): the share of the query's
   * IDF mass the covered terms carry. Present only when the search ran
   * with coverage verification.
   */
  readonly idfWeightedCoverage?: number;
  /** Rare (high-signal) significant terms per the corpus statistics. */
  readonly rareTerms?: ReadonlyArray<string>;
  /** Rare terms no returned record covers — the abstention trigger. */
  readonly uncoveredRareTerms?: ReadonlyArray<string>;
  /** Per-token recall union for uncovered significant terms. */
  readonly unionRecords?: ReadonlyArray<EvidenceUnionRecord>;
  /**
   * Search-completeness guard (Feature E): verdict + false-absence
   * report from the same coverage engine. Present only when the search
   * ran with coverage verification.
   */
  readonly completeness?: CompletenessReport;
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
   * Graph-degree cardinality predicates (t_9bee8f0b). Each predicate
   * selects notes by backlink/outlink count (orphans `backlinks = 0`,
   * hubs `outlinks >= N`, etc.); predicates are ANDed and applied as a
   * post-rank phase backed by the link-graph degree index. Absent /
   * empty = no filter, byte-identical to prior behaviour.
   */
  readonly degreeFilters?: ReadonlyArray<DegreePredicate>;
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
  /**
   * Optional composite scope filter (t_37c05a34): session and project axes
   * layered on top of the owner axis (`agentScope`). When an axis is set, a
   * page that declares that axis is returned only if it matches; a page that
   * declares no value for the axis is shared and always returned. Absent /
   * empty ({}) applies no filtering, so results are byte-identical to today.
   * See src/core/scope-key.ts.
   */
  readonly scope?: { readonly session?: string; readonly project?: string };
  /**
   * Per-query override for the typed-edge relational arm (t_09b7ccea).
   * Absent uses the resolved config default (`relationalArmEnabled`). The
   * arm only engages in `rrf` fusion for a relationship-shaped query; off
   * (default) leaves RRF output byte-identical.
   */
  readonly relationalArm?: boolean;
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
  /**
   * Size of the ranked candidate pool the `limit` window was sliced out
   * of (what-the-index-already-knew, task F) - NOT the number of returned
   * rows, which is `results.length` (or `cards.length`). It answers the
   * one question the row count cannot: how many candidates were ranked
   * and then dropped. Always >= the returned row count, since those rows
   * are the pool's prefix; equal to it only when the pool fit inside the
   * limit. Zero when nothing matched.
   *
   * It is the pool retrieval actually ranked, not a corpus COUNT: the
   * lanes fetch a widened but bounded candidate set, so on a large vault
   * this is a lower bound on the number of matching chunks, never an
   * over-count.
   *
   * The pool is the post-rank set, so gate-excluded candidates are not
   * counted here - they are reported, with their reasons, on
   * {@link SearchOutcome.retrievalDecisionTrace}.
   */
  readonly total: number;
  /**
   * Layer-1 compact cards (progressive disclosure). Present only when the
   * caller set `disclosure: "cards"`; in that mode `results` is empty and
   * the cards carry the surfaced rows. Absent on the default `full` path,
   * keeping the legacy outcome shape byte-identical.
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
  /**
   * Per-pack retrieval trust receipts (t_5f61130a). Present only when the
   * retrieval trust gate ran (`recall.retrievalTrustGateEnabled`); absent
   * on the default path so the outcome shape stays byte-identical. Both
   * are compact-reference receipts (counts, reasons, id/path refs) - they
   * never duplicate result bodies. `retrievalDecisionTrace` records what
   * the gate excluded and why; `memoryTrustAssessment` summarizes the
   * pack's trust posture. Their concrete shapes live in
   * src/core/brain/trust/retrieval-receipts.ts.
   */
  readonly retrievalDecisionTrace?: RetrievalDecisionTrace;
  readonly memoryTrustAssessment?: MemoryTrustAssessment;
  /**
   * Summary-search router verdict (t_7b96f242). Present only when the query
   * was structurally routed to the summary surface (`"summary"`); absent on
   * the generic-surface path, keeping the default outcome shape
   * byte-identical. Advisory: it names the surface the query is shaped for
   * (see {@link QuerySurface}) and never alters ranking.
   */
  readonly surface?: QuerySurface;
}

/**
 * The closed set of embedding backends `makeProvider` can build.
 *
 * Named rather than written inline because a second reader now has to
 * exhaust it: the oversize-chunk census asks which backend prepends an
 * instruction prefix to the text it sends, and that question has to fail
 * to COMPILE when a backend is added rather than silently answer "none".
 */
export type EmbeddingProviderName = "openai-compat" | "disabled" | "local" | "zeroentropy";

export interface ResolvedEmbeddingConfig {
  readonly enabled: boolean;
  readonly provider: EmbeddingProviderName;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
  /**
   * Ordered API-key failover list (multi-key fallback). When present and
   * non-empty, the provider starts on the first key and, on an auth error
   * (HTTP 401/403), fails over to the next, pinning the first that works.
   * Absent/empty means single-key behaviour over `apiKey` (byte-identical).
   */
  readonly apiKeys?: ReadonlyArray<string>;
  readonly dimension: number | null;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly batchSize: number;
  /**
   * Per-request token budget for one embedding batch
   * (provenance-at-the-boundary E1). When set, a batch closes on whichever
   * cap fills first - {@link batchSize} items or this many estimated tokens
   * - so a run of long chunks cannot assemble a request that exceeds the
   * provider's per-request token ceiling. The estimate is `estimateTokens`
   * from `embeddings/signature.ts`, the same estimator the indexer's cost
   * gate uses, applied to the text as it will be sent (instruction prefix
   * included). Optional: when the `embedding_batch_tokens` key is absent the
   * field is absent too and batching is byte-identical to the fixed
   * `batchSize` stride. A single text whose own estimate exceeds the budget
   * is sent alone rather than dropped or split.
   */
  readonly batchTokens?: number;
  /**
   * Per-batch transient-retry budget (attempts, not extra retries) for
   * 429 / 5xx / network errors. Default 6, raised from the former hardcoded
   * 3 so an agent reindexing against a strict-RPM embedding account does not
   * exhaust the budget and silently drop chunks. Configurable via
   * `embedding_max_retries` / `OPEN_SECOND_BRAIN_EMBEDDING_MAX_RETRIES`.
   * Multi-key auth failover (`apiKeys`) is independent of this count.
   */
  readonly maxRetries: number;
  /**
   * Spend ceiling in USD for a single embedding run (Embedding Provider
   * Suite). 0 (default) disables the gate. When positive, an embedding
   * run whose estimated cost exceeds this is refused unless forced.
   */
  readonly costGateUsd: number;
  /**
   * Active instruction prefix for a search query
   * (memory-write-path-integrity B2). Resolved from the preset default and
   * the `embedding_prefix_query` config/env override; an empty string means
   * no prefix (byte-identical to pre-feature behaviour). Optional so every
   * existing config literal stays valid; the openai-compat provider treats
   * an absent value as empty.
   */
  readonly queryPrefix?: string;
  /** Active instruction prefix for an indexed passage; see {@link queryPrefix}. */
  readonly passagePrefix?: string;
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
  /**
   * Reranker backend (Retrieval & Ranking Quality, t_9f95ebb6).
   * "openai-compat" (default) resolves a remote `/rerank` endpoint;
   * "local" uses the bundled offline deterministic reranker, which needs
   * no base_url / model / key and never touches the network.
   */
  readonly kind: "openai-compat" | "local";
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
   * Typed-edge relational retrieval arm (t_09b7ccea). Off by default. When
   * true AND fusion is in `rrf` mode AND the query is relationship-shaped
   * (a wikilink seed plus an edge-type token from the schema vocabulary),
   * a bounded depth-2 typed-edge fan-out joins RRF as a fourth arm. Off, or
   * in linear fusion, or for a non-relational query, ranking is
   * byte-identical.
   */
  readonly relationalArmEnabled: boolean;
  /**
   * Retrieval trust gate (t_5f61130a, kernel 1). Off by default: when
   * true, a deterministic rank-adjustment sink runs between ranking and
   * result emission and the trust gate zero-ranks (excludes) quarantined
   * material classified structurally from the self-approval guardrail
   * state, untrusted-source provenance, and entity-contamination markers.
   * Excluded items are counted with reasons into the
   * retrieval_decision_trace receipt; every pack also carries a
   * memory_trust_assessment receipt. Flag off keeps ranking and the
   * outcome shape byte-identical.
   */
  readonly retrievalTrustGateEnabled: boolean;
  /**
   * Relation-only supersede fade (t_c4a9cef8), kernel 1's second
   * consumer. Off by default: when true, a candidate a surfaced
   * `superseded_by` relation marks superseded (the same source of truth
   * `attachTrustMetadata` uses) is faded by SUPERSEDE_FADE_MULTIPLIER on
   * both the semantic and pure-lexical paths. A pool with no such
   * relation ranks byte-identically, and the existing superseded-non-tip
   * tombstone drop is untouched.
   */
  readonly supersedeFadeEnabled: boolean;
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
  /**
   * Trigram candidate prefilter (Retrieval & Ranking Quality, t_4a672b84).
   * Off by default: when true and a query qualifies (a term of at least 3
   * chars, non-CJK), the trigram FTS5 shadow contributes an additional
   * candidate source that broadens large-vault keyword recall with
   * substring / partial-token matches (a strict superset of substring
   * matches - it never drops a result). Disabled -> byte-identical.
   */
  readonly trigramPrefilterEnabled: boolean;
  /** Minimum corpus chunk count before the trigram prefilter engages. */
  readonly trigramPrefilterMinChunks: number;
  /**
   * Skip the trigram source when its candidate set exceeds this fraction
   * of the corpus (low selectivity - not worth widening the pool). [0, 1].
   */
  readonly trigramPrefilterMaxSelectivity: number;
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
  /**
   * FTS5 tokenizer clause for the searchable `chunk_fts` table (Q1 of the
   * search config, t_618f7211), assembled from validated
   * `search_fts_diacritics` / `search_fts_stemmer` config keys. Absent
   * config yields the historical `unicode61 remove_diacritics 2`
   * byte-identically. Applied only when the index is (re)built, so a
   * change requires an explicit `o2b search reindex`; the CJK trigram
   * shadow index is untouched by this clause.
   */
  readonly ftsTokenize: string;
}

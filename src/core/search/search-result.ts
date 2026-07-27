/**
 * The shape of ONE ranked search hit: the result row plus the per-hit
 * score and trust metadata computed alongside it. Plain data — no
 * behaviour, no I/O.
 *
 * A LEAF by construction — it imports nothing from the search layer, so
 * the stages that consume a ranked hit (`rank-adjust.ts` and, through
 * its exclusion record, `../brain/trust/retrieval-receipts.ts`) can name
 * the row without pointing back at the `types.ts` aggregate that
 * re-exports it.
 */

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
  /** Observed-reuse boost (t_65588d8b); 0 when no verdicts apply. */
  readonly reuse: number;
  readonly link: number;
  readonly recency: number;
  readonly tier: number;
  readonly trend: number;
  readonly sessionFocus: number;
  /**
   * Query-side temporal-intent boost (t_58fc4720). Present ONLY when the
   * query declared a time window; absent - not zero - for every query
   * that declared none, so a breakdown without temporal intent stays
   * byte-identical to pre-suite behaviour.
   */
  readonly temporal?: number;
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
  /**
   * Belief lifecycle suite (A4, t_d9365884): when the hit is superseded,
   * the `superseded_by` successor target so recall carries a pointer to
   * the replacement. `null` when the hit is not superseded or declares no
   * successor target.
   */
  readonly replacement: string | null;
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
  /**
   * Transcript turn instant (unix seconds) this result was authored at
   * (conversation chronology, S1 / t_347e8224). Present only for a note
   * carrying an `authored_at` frontmatter instant; absent for every note
   * with no turn instant, so the result shape stays byte-identical for a
   * vault without transcript-authored notes. Exact hybrid-score ties are
   * ordered newer-first by this value.
   */
  readonly authoredAt?: number;
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

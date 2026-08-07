import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import { jaccard, tokenise } from "./similarity.ts";
import type { DefaultRelationType } from "../graph/relation-vocab.ts";
import type { BrainSearchResult } from "../search/search-result.ts";

export type RecallTelemetryMode = "search" | "context_pack" | "pre_compress" | "query";
export type RecallTelemetryStatus = "ok" | "empty" | "error" | "timeout";

export interface RecallTelemetryArtifactInput {
  readonly id: string;
  readonly path?: string;
  readonly score?: number;
}

/**
 * Recall-quality signals (what-the-index-already-knew, task G).
 *
 * SHADOW-ONLY INVARIANT, the same one `retrieval-plan.ts` states: this
 * lane READS an already-ranked, already-frozen result window and returns
 * numbers. It exposes no handle that could mutate ranking, weight
 * policy, or the returned rows, and it is invoked only from inside the
 * gated telemetry thunk - with the gate off, `emitGatedTelemetry` never
 * calls the builder, so nothing here executes on the default path.
 *
 * Every signal is a value the retrieval pipeline ALREADY computed and
 * then discarded before any surface could see it:
 *
 *   - alignment - the fused `score` and the per-lane `keywordScore` /
 *     `semanticScore` the ranker produced;
 *   - trust - the read-time {@link BrainSearchResult.trust} metadata,
 *     attached only when the caller set `trust`, so `assessed` doubles
 *     as the record of whether the caller asked at all;
 *   - contradiction - the typed `contradicts` relation edges the
 *     pipeline already surfaces on the row, counted with no dependency
 *     on the trust opt-in;
 *   - diversity - the same deterministic token-set Jaccard measure the
 *     MMR reranker applies pair-by-pair, aggregated over the surfaced
 *     window. It goes through the shared brain-layer tokeniser
 *     ({@link ./similarity.ts}) rather than the reranker's private copy,
 *     so this lane adds no second tokeniser; that tokeniser drops
 *     single-character tokens, which makes the number comparable across
 *     queries but not equal to a given MMR pair score. No embedding
 *     round trip, no word list, no clock.
 *
 * ONE record per query. The continuity log has no retention policy, so
 * per-result detail is refused outright: everything here is a pool-level
 * count or mean, and the only quadratic walk is bounded by
 * {@link RECALL_SIGNALS_DIVERSITY_MAX_ROWS}.
 *
 * Epistemic provenance is deliberately NOT derived here. Unlike the four
 * above it is not a value the retrieval path already holds: no
 * frontmatter is carried on the result row and none is stored on the
 * index, so deriving it would add one file read and one frontmatter
 * parse per surfaced document to a live query. The record already names
 * every surfaced artifact by path, so an analysis pass over the log
 * derives the same status against the vault at zero recall-time cost.
 *
 * Two further signals asked for by the original task are refused rather
 * than invented; the reasons are recorded in
 * `docs/brainstorm/what-the-index-already-knew/design.md` under "Out of
 * scope", and a census test asserts their names appear nowhere in `src/`.
 */

/** Decimal places every derived signal is rounded to before recording. */
const SIGNAL_DECIMALS = 4;
/**
 * Upper bound on the rows the pairwise diversity walk compares. The walk
 * is quadratic, so an unbounded `limit` would make a gated query pay
 * `limit^2` token-set comparisons; the top rows are the ones an operator
 * reads, so the walk stops there and `diversity.compared` records the
 * bound that was actually applied.
 */
export const RECALL_SIGNALS_DIVERSITY_MAX_ROWS = 10;
/** The typed edge that marks a surfaced row as declaring a contradiction. */
const CONTRADICTS_RELATION: DefaultRelationType = "contradicts";

export interface RecallAlignmentSignal {
  /** Fused score of the top-ranked surfaced row. */
  readonly top: number;
  /** Mean fused score across the surfaced window. */
  readonly mean: number;
  /**
   * Fused-score gap between rank 1 and rank 2 as returned. Absent - not
   * zero - for a single-row window, where there is no second row to
   * measure against. May be negative when a rerank reordered the window.
   */
  readonly margin?: number;
  /** Summed keyword-lane contribution across the surfaced window. */
  readonly keyword_sum: number;
  /** Summed semantic-lane contribution across the surfaced window. */
  readonly semantic_sum: number;
}

export interface RecallTrustSignal {
  /**
   * Rows carrying read-time trust metadata. Zero means the caller did
   * not opt into `trust`, so the counts below carry no information -
   * they are not a clean bill of health.
   */
  readonly assessed: number;
  readonly superseded: number;
  readonly conflict: number;
  /** Oldest assessed row in whole days. Absent when `assessed` is 0. */
  readonly max_age_days?: number;
}

export interface RecallContradictionSignal {
  /** Surfaced rows declaring at least one `contradicts` edge. */
  readonly rows: number;
  /** Total `contradicts` edges across the surfaced window. */
  readonly edges: number;
}

export interface RecallDiversitySignal {
  /** Rows the pairwise walk actually compared (the applied bound). */
  readonly compared: number;
  /** Pairs compared: `compared * (compared - 1) / 2`. */
  readonly pairs: number;
  /** Mean pairwise token-set overlap. Absent when `pairs` is 0. */
  readonly mean_similarity?: number;
  /** Largest pairwise token-set overlap. Absent when `pairs` is 0. */
  readonly max_similarity?: number;
}

export interface RecallQualitySignals {
  /** Rows in the surfaced window the signals were derived from. */
  readonly rows: number;
  readonly alignment: RecallAlignmentSignal;
  readonly trust: RecallTrustSignal;
  readonly contradiction: RecallContradictionSignal;
  readonly diversity: RecallDiversitySignal;
}

/**
 * Recorded in place of the signals when the surface returned something
 * the derivation cannot read. A check that cannot run says so rather
 * than recording zeros that would read as a measured result.
 */
export interface RecallSignalsUnmeasured {
  readonly unmeasured: "disclosure_cards";
}

/**
 * Progressive-disclosure `cards` mode returns projected cards and an
 * EMPTY `results` array, so none of the per-row values these signals are
 * derived from exist on that path.
 */
export const RECALL_SIGNALS_UNMEASURED_CARDS: RecallSignalsUnmeasured = Object.freeze({
  unmeasured: "disclosure_cards",
});

function roundSignal(value: number): number {
  const factor = 10 ** SIGNAL_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Derive the per-query recall signals from an already-ranked window.
 *
 * Returns `null` for an empty window: there is no pool to measure, and
 * the record's `result_count: 0` already states that. Pure - no I/O, no
 * clock - and non-mutating: the input array and its rows are read only.
 */
export function deriveRecallSignals(
  rows: ReadonlyArray<BrainSearchResult>,
): RecallQualitySignals | null {
  if (rows.length === 0) return null;

  let scoreSum = 0;
  let keywordSum = 0;
  let semanticSum = 0;
  let assessed = 0;
  let superseded = 0;
  let conflict = 0;
  let maxAgeDays = 0;
  let contradictionRows = 0;
  let contradictionEdges = 0;

  for (const row of rows) {
    scoreSum += row.score;
    keywordSum += row.keywordScore;
    semanticSum += row.semanticScore;
    if (row.trust !== undefined) {
      assessed += 1;
      if (row.trust.superseded) superseded += 1;
      if (row.trust.conflict) conflict += 1;
      if (row.trust.age_days > maxAgeDays) maxAgeDays = row.trust.age_days;
    }
    const edges = (row.relations ?? []).filter(
      (relation) => relation.relation === CONTRADICTS_RELATION,
    ).length;
    if (edges > 0) {
      contradictionRows += 1;
      contradictionEdges += edges;
    }
  }

  const top = rows[0]!;
  const second = rows[1];

  return Object.freeze({
    rows: rows.length,
    alignment: Object.freeze({
      top: roundSignal(top.score),
      mean: roundSignal(scoreSum / rows.length),
      ...(second !== undefined ? { margin: roundSignal(top.score - second.score) } : {}),
      keyword_sum: roundSignal(keywordSum),
      semantic_sum: roundSignal(semanticSum),
    }),
    trust: Object.freeze({
      assessed,
      superseded,
      conflict,
      ...(assessed > 0 ? { max_age_days: maxAgeDays } : {}),
    }),
    contradiction: Object.freeze({ rows: contradictionRows, edges: contradictionEdges }),
    diversity: derivePoolDiversity(rows),
  });
}

/**
 * Pool-level redundancy: the mean and maximum pairwise token-set Jaccard
 * over the top {@link RECALL_SIGNALS_DIVERSITY_MAX_ROWS} rows, using the
 * shared brain-layer tokeniser. A window with fewer than two rows has no
 * pair, so both means are absent rather than reported as a diversity of
 * zero, which would read as "maximally diverse".
 */
function derivePoolDiversity(rows: ReadonlyArray<BrainSearchResult>): RecallDiversitySignal {
  const compared = Math.min(rows.length, RECALL_SIGNALS_DIVERSITY_MAX_ROWS);
  if (compared < 2) return Object.freeze({ compared, pairs: 0 });

  const tokens = rows.slice(0, compared).map((row) => tokenise(row.content));
  let sum = 0;
  let max = 0;
  let pairs = 0;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const similarity = jaccard(tokens[i]!, tokens[j]!);
      sum += similarity;
      if (similarity > max) max = similarity;
      pairs += 1;
    }
  }
  return Object.freeze({
    compared,
    pairs,
    mean_similarity: roundSignal(sum / pairs),
    max_similarity: roundSignal(max),
  });
}

export interface RecallTelemetryInput {
  readonly createdAt?: string;
  readonly host: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly mode: RecallTelemetryMode;
  readonly status: RecallTelemetryStatus;
  readonly durationMs: number;
  readonly resultCount: number;
  readonly topArtifacts?: ReadonlyArray<RecallTelemetryArtifactInput>;
  readonly gaps?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Recall-quality signals for this query (task G). Additive and
   * optional: a caller that supplies none produces a payload
   * byte-identical to the pre-signal one - the key is absent, never
   * null - so `CONTINUITY_SCHEMA_VERSION` does not move.
   */
  readonly signals?: RecallQualitySignals | RecallSignalsUnmeasured;
}

export interface RecallTelemetryOptions {
  readonly host: string;
  readonly createdAt?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RecallTelemetryFilter {
  readonly mode?: RecallTelemetryMode;
  readonly status?: RecallTelemetryStatus;
  readonly host?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface RecallTelemetrySummary {
  readonly total: number;
  readonly by_mode: Partial<Record<RecallTelemetryMode, number>>;
  readonly by_status: Partial<Record<RecallTelemetryStatus, number>>;
  readonly total_results: number;
  readonly empty_runs: number;
  readonly gap_counts: Record<string, number>;
}

export function emitRecallTelemetry(vault: string, input: RecallTelemetryInput): ContinuityRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const topArtifacts = [...(input.topArtifacts ?? [])];
  const gaps = [...new Set((input.gaps ?? []).map((gap) => gap.trim()).filter(Boolean))];
  return appendContinuityRecord(vault, {
    kind: "recall_telemetry",
    createdAt,
    sourceRefs: topArtifacts.map((artifact) => ({
      id: artifact.id,
      ...(artifact.path ? { path: artifact.path } : {}),
    })),
    payload: {
      host: input.host,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      mode: input.mode,
      status: input.status,
      duration_ms: Math.max(0, Math.floor(input.durationMs)),
      result_count: Math.max(0, Math.floor(input.resultCount)),
      top_artifacts: topArtifacts.map((artifact) => ({
        id: artifact.id,
        ...(artifact.path ? { path: artifact.path } : {}),
        ...(artifact.score !== undefined ? { score: artifact.score } : {}),
      })),
      gaps,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.signals ? { signals: input.signals } : {}),
    },
  });
}

export function listRecallTelemetry(
  vault: string,
  filter: RecallTelemetryFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "recall_telemetry",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => matchesTelemetryFilter(record, filter));
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

export function summarizeRecallTelemetry(
  vault: string,
  filter: RecallTelemetryFilter = {},
): RecallTelemetrySummary {
  const records = listRecallTelemetry(vault, filter);
  const byMode: Partial<Record<RecallTelemetryMode, number>> = {};
  const byStatus: Partial<Record<RecallTelemetryStatus, number>> = {};
  const gapCounts: Record<string, number> = {};
  let totalResults = 0;
  let emptyRuns = 0;

  for (const record of records) {
    const mode = record.payload["mode"];
    if (isRecallTelemetryMode(mode)) byMode[mode] = (byMode[mode] ?? 0) + 1;
    const status = record.payload["status"];
    if (isRecallTelemetryStatus(status)) {
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (status === "empty") emptyRuns += 1;
    }
    const resultCount = record.payload["result_count"];
    if (typeof resultCount === "number") totalResults += resultCount;
    const gaps = record.payload["gaps"];
    if (Array.isArray(gaps)) {
      for (const gap of gaps) {
        if (typeof gap !== "string" || gap.length === 0) continue;
        gapCounts[gap] = (gapCounts[gap] ?? 0) + 1;
      }
    }
  }

  return Object.freeze({
    total: records.length,
    by_mode: Object.freeze(byMode),
    by_status: Object.freeze(byStatus),
    total_results: totalResults,
    empty_runs: emptyRuns,
    gap_counts: Object.freeze(gapCounts),
  });
}

export function isRecallTelemetryMode(value: unknown): value is RecallTelemetryMode {
  return (
    value === "search" || value === "context_pack" || value === "pre_compress" || value === "query"
  );
}

export function isRecallTelemetryStatus(value: unknown): value is RecallTelemetryStatus {
  return value === "ok" || value === "empty" || value === "error" || value === "timeout";
}

function matchesTelemetryFilter(record: ContinuityRecord, filter: RecallTelemetryFilter): boolean {
  const payload = record.payload;
  if (filter.mode !== undefined && payload["mode"] !== filter.mode) return false;
  if (filter.status !== undefined && payload["status"] !== filter.status) return false;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  return true;
}

/**
 * Cross-query demand log (t_97091fff).
 *
 * A persisted, deterministic record of every recall query against the
 * vault, together with two satisfaction signals already computed
 * elsewhere: the result count and the IDF-weighted coverage score from
 * {@link ../search/coverage.ts}. Aggregated over time, the log surfaces
 * the *demand* gap — queries operators keep asking that the vault
 * answers poorly (weak or empty) — as a prioritized backlog of what to
 * write into `Brain/` next.
 *
 * This is distinct from the existing structural gaps (dangling wikilink
 * targets in deep-synthesis) and from the in-the-moment per-query
 * coverage guard (coverage.ts / evidence-pack.ts): those look at one
 * query or one link at a time and are never persisted. Here the signal
 * is cross-query and durable.
 *
 * No LLM, no ranking model — pure counting and the reused coverage
 * score. Privacy: only the normalized significant terms are stored
 * (never the raw query), each run through the secret redactor, so a
 * query carrying a token or path cannot leak into the log.
 *
 * Storage: `Brain/log/query-demand.jsonl`, one JSON record per line,
 * rolling and byte-budget-capped (see {@link DEMAND_LOG_MAX_BYTES}).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { clamp01 } from "../math.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { redactRawOutput } from "../redactor.ts";
import { queryDemandLogPath } from "./paths.ts";
import { acquireLockSync } from "./sync-lockfile.ts";
import {
  COMPLETENESS_COMPLETE_THRESHOLD,
  COMPLETENESS_PARTIAL_THRESHOLD,
  significantTerms,
} from "../search/coverage.ts";
import type { CompletenessVerdict } from "../search/types.ts";

/** Longest single normalized term kept; longer tokens are dropped as a
 * privacy guard (a 40+ char alnum run is far likelier a secret/id than a
 * word). */
export const DEMAND_TERM_MAX_LEN = 40;

/** Most terms retained per record — bounds one pathological query's line
 * size while keeping the bucket key stable for realistic queries. */
export const DEMAND_MAX_TERMS_PER_RECORD = 24;

/** Compaction trigger: once the log file exceeds this many bytes, the
 * oldest lines are dropped so the tail fits in {@link DEMAND_LOG_COMPACT_BYTES}.
 * Bounds unbounded growth without reading the whole file on every append
 * (the common path only stats the file). */
export const DEMAND_LOG_MAX_BYTES = 1_000_000;

/** Target size after compaction — keep the newest lines whose combined
 * size is at most this. Kept below {@link DEMAND_LOG_MAX_BYTES} so
 * compaction is amortized, not run on every subsequent append. */
export const DEMAND_LOG_COMPACT_BYTES = 750_000;

/** A query must recur at least this many times to count as demand. */
export const DEMAND_DEFAULT_MIN_OCCURRENCES = 2;

/**
 * One persisted recall observation. `coverage` is absent when the caller
 * did not compute the evidence-pack coverage (the common non-verified
 * search path); the aggregator falls back to the result-presence signal
 * for those buckets.
 */
export interface QueryDemandRecord {
  readonly ts: string;
  readonly terms: ReadonlyArray<string>;
  readonly results: number;
  readonly coverage?: number;
}

export interface RecordQueryDemandInput {
  /** Raw query text — normalized/redacted to terms before it is stored. */
  readonly query?: string;
  /** Pre-normalized terms; used verbatim (after redaction) if given. */
  readonly terms?: ReadonlyArray<string>;
  readonly resultCount: number;
  /** IDF-weighted coverage (0..1) from coverage.ts, when available. */
  readonly coverage?: number | null;
  /** ISO timestamp; defaults to now. */
  readonly at?: string;
}

export interface QueryDemandFilter {
  readonly since?: string;
  readonly until?: string;
}

export interface AggregateQueryDemandOptions extends QueryDemandFilter {
  /** Minimum occurrences to surface a bucket (default 2). */
  readonly minOccurrences?: number;
  /**
   * Surface only buckets whose mean satisfaction is at or below this
   * (default {@link COMPLETENESS_COMPLETE_THRESHOLD}) — i.e. queries not
   * already answered well. Ranking by demand pushes the worst to the top.
   */
  readonly maxSatisfaction?: number;
  /** Cap on returned gaps. */
  readonly limit?: number;
}

export interface QueryDemandGap {
  /** Sorted normalized terms — the bucket key, split for display. */
  readonly terms: ReadonlyArray<string>;
  readonly occurrences: number;
  /** Mean IDF-weighted coverage over records that carried one, else null. */
  readonly meanCoverage: number | null;
  readonly meanResultCount: number;
  /** Records with zero results. */
  readonly emptyCount: number;
  readonly emptyRate: number;
  /**
   * Satisfaction in [0,1]: the coverage mean when any record carried
   * coverage, otherwise the fraction of runs that returned any result.
   */
  readonly satisfaction: number;
  /** Whether satisfaction came from coverage (true) or the result-count
   * fallback (false). */
  readonly coverageKnown: boolean;
  /** occurrences × (1 − satisfaction): recurring + unmet ranks highest. */
  readonly demandScore: number;
  /** Completeness verdict over the satisfaction score. */
  readonly verdict: CompletenessVerdict;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface QueryDemandReport {
  readonly totalRecords: number;
  readonly distinctQueries: number;
  readonly gaps: ReadonlyArray<QueryDemandGap>;
}

/** Length at/above which a mixed letter+digit token is treated as a
 * high-entropy secret/id (API key, UUID, hash) rather than a query word
 * and dropped. Real words this long are essentially never both alpha and
 * numeric. */
export const DEMAND_SECRET_TOKEN_MIN_LEN = 20;

/**
 * Normalize a raw query into the terms actually stored: the significant
 * terms (length ≥ 3, deduped) sorted for a stable bucket key, with the
 * privacy filters below applied. Capped at
 * {@link DEMAND_MAX_TERMS_PER_RECORD}.
 */
export function normalizeQueryTerms(query: string): string[] {
  return sanitizeTerms(significantTerms(query));
}

function sanitizeTerms(terms: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const raw of terms) {
    const term = raw.toLocaleLowerCase().trim();
    if (term.length < 3 || term.length > DEMAND_TERM_MAX_LEN) continue;
    if (isSecretShapedTerm(term)) continue;
    // Belt-and-suspenders: a term the key/value redactor still rewrites
    // is secret-shaped — never a legitimate query word, so drop it rather
    // than store a `***REDACTED***` bucket key.
    if (redactRawOutput(term) !== term) continue;
    out.add(term);
  }
  return [...out].toSorted().slice(0, DEMAND_MAX_TERMS_PER_RECORD);
}

/**
 * A bare token is secret-shaped when it is long AND mixes letters with
 * digits — the signature of an API key, UUID, or hash. The redactor's
 * passes are context-based (`key: value`, bearer headers, env), so a
 * single high-entropy word carries no shape they can match; this catches
 * it before it becomes a persisted bucket key. Kept deliberately narrow
 * (length gate + both classes) so ordinary words and short alnum terms
 * (`oauth2`, `sha256`, `utf8`) are never dropped.
 */
function isSecretShapedTerm(term: string): boolean {
  if (term.length < DEMAND_SECRET_TOKEN_MIN_LEN) return false;
  return /[a-z]/.test(term) && /[0-9]/.test(term);
}

/**
 * Append one recall observation to the demand log. Terms are derived
 * from `terms` (redacted) or `query` (normalized+redacted); a query with
 * no significant terms is not recorded (returns null). Best-effort by
 * contract — callers gate this behind opt-in telemetry and must not let
 * a log write fail the search.
 */
export function recordQueryDemand(
  vault: string,
  input: RecordQueryDemandInput,
): QueryDemandRecord | null {
  const terms =
    input.terms !== undefined ? sanitizeTerms(input.terms) : normalizeQueryTerms(input.query ?? "");
  if (terms.length === 0) return null;
  const record: QueryDemandRecord = {
    ts: normalizeDemandTimestamp(input.at),
    terms,
    results: Number.isFinite(input.resultCount) ? Math.max(0, Math.floor(input.resultCount)) : 0,
    ...(typeof input.coverage === "number" && Number.isFinite(input.coverage)
      ? { coverage: clamp01(input.coverage) }
      : {}),
  };
  const path = queryDemandLogPath(vault);
  mkdirSync(ensureInsideVault(dirname(path), vault), { recursive: true });
  const handle = acquireLockSync(path);
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    compactIfNeeded(path);
  } finally {
    handle.release();
  }
  return record;
}

/** Read all demand records, filtered by [since, until] and sorted by ts. */
export function readQueryDemand(
  vault: string,
  filter: QueryDemandFilter = {},
): ReadonlyArray<QueryDemandRecord> {
  const path = queryDemandLogPath(vault);
  if (!existsSync(path)) return Object.freeze([]);
  // Normalize the filter bounds to the same millisecond-precision form the
  // stored `ts` already uses (records are normalized at write time). The
  // comparison below is lexical, so a second-precision `--since
  // 2026-07-01T00:00:00Z` would otherwise drop every ms-precision record in
  // `[00:00:00.000Z, 00:00:00.999Z]` — `.` sorts before `Z`. Running the
  // bounds through the same normalizer keeps both sides at one precision.
  const since = filter.since !== undefined ? normalizeDemandTimestamp(filter.since) : undefined;
  const until = filter.until !== undefined ? normalizeDemandTimestamp(filter.until) : undefined;
  const out: QueryDemandRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = coerceRecord(line);
    if (record === null) continue;
    if (since !== undefined && record.ts < since) continue;
    if (until !== undefined && record.ts > until) continue;
    out.push(record);
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return Object.freeze(out);
}

/**
 * Aggregate the demand log into ranked knowledge gaps: recurring queries
 * the vault answers poorly. Buckets by the sorted-terms key, scores each
 * by occurrences × (1 − satisfaction), and returns the worst first.
 */
export function aggregateQueryDemand(
  vault: string,
  options: AggregateQueryDemandOptions = {},
): QueryDemandReport {
  const records = readQueryDemand(vault, {
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
  });
  const minOccurrences = Math.max(
    1,
    Math.floor(options.minOccurrences ?? DEMAND_DEFAULT_MIN_OCCURRENCES),
  );
  const maxSatisfaction = clamp01(options.maxSatisfaction ?? COMPLETENESS_COMPLETE_THRESHOLD);

  interface Bucket {
    terms: ReadonlyArray<string>;
    occurrences: number;
    resultSum: number;
    emptyCount: number;
    coverageSum: number;
    coverageSamples: number;
    firstSeen: string;
    lastSeen: string;
  }
  const buckets = new Map<string, Bucket>();
  for (const record of records) {
    const key = record.terms.join(" ");
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        terms: record.terms,
        occurrences: 0,
        resultSum: 0,
        emptyCount: 0,
        coverageSum: 0,
        coverageSamples: 0,
        firstSeen: record.ts,
        lastSeen: record.ts,
      };
      buckets.set(key, bucket);
    }
    bucket.occurrences += 1;
    bucket.resultSum += record.results;
    if (record.results === 0) bucket.emptyCount += 1;
    if (typeof record.coverage === "number") {
      bucket.coverageSum += record.coverage;
      bucket.coverageSamples += 1;
    }
    if (record.ts < bucket.firstSeen) bucket.firstSeen = record.ts;
    if (record.ts > bucket.lastSeen) bucket.lastSeen = record.ts;
  }

  const gaps: QueryDemandGap[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.occurrences < minOccurrences) continue;
    const coverageKnown = bucket.coverageSamples > 0;
    const meanCoverage = coverageKnown ? bucket.coverageSum / bucket.coverageSamples : null;
    // Prefer the reused coverage score; only when no record in this
    // bucket carried one do we fall back to "did it return anything".
    const satisfaction = coverageKnown
      ? meanCoverage!
      : (bucket.occurrences - bucket.emptyCount) / bucket.occurrences;
    if (satisfaction > maxSatisfaction) continue;
    gaps.push(
      Object.freeze({
        terms: bucket.terms,
        occurrences: bucket.occurrences,
        meanCoverage: meanCoverage === null ? null : round4(meanCoverage),
        meanResultCount: round4(bucket.resultSum / bucket.occurrences),
        emptyCount: bucket.emptyCount,
        emptyRate: round4(bucket.emptyCount / bucket.occurrences),
        satisfaction: round4(satisfaction),
        coverageKnown,
        demandScore: round4(bucket.occurrences * (1 - satisfaction)),
        verdict: verdictFor(satisfaction),
        firstSeen: bucket.firstSeen,
        lastSeen: bucket.lastSeen,
      }),
    );
  }

  gaps.sort(
    (a, b) =>
      b.demandScore - a.demandScore ||
      b.occurrences - a.occurrences ||
      a.terms.join(" ").localeCompare(b.terms.join(" ")),
  );
  const limited =
    options.limit !== undefined ? gaps.slice(0, Math.max(0, Math.floor(options.limit))) : gaps;

  return Object.freeze({
    totalRecords: records.length,
    distinctQueries: buckets.size,
    gaps: Object.freeze(limited),
  });
}

/**
 * Snake_case JSON projection of a report for the MCP tool and CLI
 * `--json` surfaces, matching the sibling recall-telemetry convention.
 * Kept here so both surfaces serialize identically.
 */
export function serializeQueryDemandReport(report: QueryDemandReport): Record<string, unknown> {
  return {
    total_records: report.totalRecords,
    distinct_queries: report.distinctQueries,
    gaps: report.gaps.map((gap) => ({
      terms: gap.terms,
      occurrences: gap.occurrences,
      mean_coverage: gap.meanCoverage,
      mean_result_count: gap.meanResultCount,
      empty_count: gap.emptyCount,
      empty_rate: gap.emptyRate,
      satisfaction: gap.satisfaction,
      coverage_known: gap.coverageKnown,
      demand_score: gap.demandScore,
      verdict: gap.verdict,
      first_seen: gap.firstSeen,
      last_seen: gap.lastSeen,
    })),
  };
}

function verdictFor(satisfaction: number): CompletenessVerdict {
  if (satisfaction >= COMPLETENESS_COMPLETE_THRESHOLD) return "complete";
  if (satisfaction >= COMPLETENESS_PARTIAL_THRESHOLD) return "partial";
  return "sparse";
}

function coerceRecord(line: string): QueryDemandRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const ts = obj["ts"];
  const terms = obj["terms"];
  const results = obj["results"];
  if (typeof ts !== "string") return null;
  if (!Array.isArray(terms) || !terms.every((t) => typeof t === "string")) return null;
  if (typeof results !== "number" || !Number.isFinite(results)) return null;
  const coverage = obj["coverage"];
  return {
    ts,
    terms: Object.freeze(terms as string[]),
    results: Math.max(0, Math.floor(results)),
    ...(typeof coverage === "number" && Number.isFinite(coverage)
      ? { coverage: clamp01(coverage) }
      : {}),
  };
}

/**
 * Drop the oldest lines once the file grows past
 * {@link DEMAND_LOG_MAX_BYTES}, keeping the newest lines that fit in
 * {@link DEMAND_LOG_COMPACT_BYTES}. Called under the append lock. The
 * common path only stats the file — no read — so per-append cost stays
 * O(1) until the rare compaction.
 */
function compactIfNeeded(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= DEMAND_LOG_MAX_BYTES) return;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > DEMAND_LOG_COMPACT_BYTES && kept.length > 0) break;
    kept.push(line);
    bytes += lineBytes;
  }
  kept.reverse();
  atomicWriteFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
}

/**
 * Normalize a caller-supplied (or absent) timestamp into a canonical
 * millisecond-precision ISO string. `readQueryDemand` and
 * `aggregateQueryDemand` compare `ts` as raw strings (sort + range
 * filter), which is only stable when every record uses the same precision
 * — `2026-07-01T00:00:00.000Z` must sort after `2026-07-01T00:00:00Z`,
 * but lexically `.` < `Z` flips them. Parsing-and-reformatting through
 * `Date` collapses the difference and also rejects non-ISO input by
 * falling back to now, so a malformed `at` can't silently misorder the
 * log. Non-finite `Date` (invalid input) resolves to the current time.
 */
function normalizeDemandTimestamp(at: string | undefined): string {
  if (at === undefined) return new Date().toISOString();
  const parsed = new Date(at);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? parsed.toISOString() : new Date().toISOString();
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

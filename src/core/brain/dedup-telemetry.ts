/**
 * Ingest dedup observability (no-dead-ends, Unit F).
 *
 * The three ingest paths that DROP an item on a repeat -
 * `captureSessionLifecycleEvent`, `scanInline`, `importSession` - each
 * already counted the drops and returned the count in a CLI/JSON/MCP
 * response. That count then died one call deep: nothing persisted it, so
 * a spike in re-ingest pressure could not be observed over time. This
 * module is the missing persistence: one append-only `ingest_dedup`
 * continuity record per ingest RUN, read back by {@link
 * summarizeIngestDedup} on the analytics surface. It follows the
 * `generation_report` model (emit / list / summarize over the continuity
 * store) rather than inventing a shape.
 *
 * EXACT HASH ONLY. Every count here comes from a sha-256 `dedup_hash`
 * collision - the only mechanism in this codebase that actually drops an
 * ingested item. The two semantic layers (`detectSemanticDedup`,
 * `detectEntityAliasCandidates`) are opt-in, proposal-only NOMINATION
 * systems: they nominate merge candidates and never drop anything. So no
 * field here reports a semantic figure, and every field that counts drops
 * carries `exact` in its name, so nothing this module writes can be read
 * as "semantically dropped".
 *
 * The per-source dimension answers the operator question "which source is
 * being re-ingested". It is taken from the identity each call site already
 * keys its provenance by: the session id for the two session paths, and
 * the vault-relative note path for the inline scan. Those are exactly the
 * units an operator can act on (stop replaying that session; fix that
 * note).
 *
 * Error discipline. A caller bug (an unknown surface, a negative or
 * fractional count, a blank ref) raises {@link IngestDedupTelemetryError}
 * eagerly, BEFORE the gate - a miscounted telemetry row is worse than a
 * loud failure, and those inputs are computed locally so they are
 * deterministic. Only the disk write runs inside `emitGatedTelemetry`,
 * which keeps the fail-open guarantee that telemetry can never fail the
 * ingest it observes.
 */

import { emitGatedTelemetry } from "./continuity/emit.ts";
import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord, ContinuitySourceRef } from "./continuity/types.ts";

/** Continuity record kind this module owns. */
export const INGEST_DEDUP_RECORD_KIND = "ingest_dedup";

/** The ingest runs that can drop an item on an exact-hash collision. */
export const INGEST_DEDUP_SURFACES = Object.freeze([
  "session_lifecycle",
  "scan_inline",
  "session_import",
] as const);

export type IngestDedupSurface = (typeof INGEST_DEDUP_SURFACES)[number];

/**
 * Largest per-source map a single record carries. A vault-wide re-scan can
 * touch thousands of notes; the map keeps the heaviest re-ingest offenders
 * (which is the operator question) and names how many refs it dropped
 * rather than growing an unbounded payload. The run TOTAL is a separate
 * field and stays exact regardless of the clip.
 */
export const MAX_TRACKED_DEDUP_SOURCES = 50;

export class IngestDedupTelemetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestDedupTelemetryError";
  }
}

/** One ingest source and how many of its items collided on an exact hash. */
export interface IngestDedupSourceCount {
  /** Session id, or vault-relative note path - whatever the run keys provenance by. */
  readonly ref: string;
  readonly exactDeduped: number;
}

export interface IngestDedupReportInput {
  readonly surface: IngestDedupSurface;
  /** Every source the run considered; a zero-count source is legal and contributes nothing. */
  readonly sources: ReadonlyArray<IngestDedupSourceCount>;
  readonly createdAt?: string;
}

/**
 * Persist one run's exact-hash dedup counts.
 *
 * Returns `null` - writing NOTHING - when the run deduped nothing. A zero
 * row would make a real measured zero indistinguishable from an absent
 * measurement, so absence is the honest encoding of "nothing collided".
 * Also returns `null` when the write itself fails, so telemetry never
 * fails the ingest.
 */
export function emitIngestDedupReport(
  vault: string,
  input: IngestDedupReportInput,
): ContinuityRecord | null {
  assertKnownSurface(input.surface);
  const totals = mergeSources(input.sources);

  let exactDeduped = 0;
  for (const count of totals.values()) exactDeduped += count;
  if (exactDeduped === 0) return null;

  const ranked = [...totals.entries()]
    .filter(([, count]) => count > 0)
    .toSorted(([leftRef, leftCount], [rightRef, rightCount]) =>
      rightCount === leftCount ? leftRef.localeCompare(rightRef) : rightCount - leftCount,
    );
  const tracked = ranked.slice(0, MAX_TRACKED_DEDUP_SOURCES);
  const omitted = ranked.length - tracked.length;
  const createdAt = input.createdAt ?? new Date().toISOString();

  return emitGatedTelemetry(INGEST_DEDUP_GATE, () =>
    appendContinuityRecord(vault, {
      kind: INGEST_DEDUP_RECORD_KIND,
      createdAt,
      sourceRefs: buildSourceRefs(input.surface, tracked),
      payload: {
        surface: input.surface,
        exact_deduped: exactDeduped,
        by_source: Object.fromEntries(tracked),
        ...(omitted > 0 ? { by_source_omitted: omitted } : {}),
      },
    }),
  );
}

/**
 * The gate is permanently open: unlike the opt-in traces, the dedup count
 * is a first-class observability surface whose whole point is that a spike
 * is visible without the operator having enabled anything in advance. The
 * emit still routes through `emitGatedTelemetry` for the second guarantee
 * that helper provides - fail-open, so a broken continuity store degrades
 * observability instead of breaking ingest.
 */
const INGEST_DEDUP_GATE = true;

function assertKnownSurface(surface: IngestDedupSurface): void {
  if (!(INGEST_DEDUP_SURFACES as ReadonlyArray<string>).includes(surface)) {
    throw new IngestDedupTelemetryError(
      `unknown ingest dedup surface ${JSON.stringify(surface)}; ` +
        `expected one of ${INGEST_DEDUP_SURFACES.join(", ")}`,
    );
  }
}

/** Collapse repeated refs into one count each, validating as it goes. */
function mergeSources(sources: ReadonlyArray<IngestDedupSourceCount>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const source of sources) {
    const ref = typeof source.ref === "string" ? source.ref.trim() : "";
    if (ref.length === 0) {
      throw new IngestDedupTelemetryError(
        `ingest dedup source ref must be a non-empty string; got ${JSON.stringify(source.ref)}`,
      );
    }
    const count = source.exactDeduped;
    if (!Number.isInteger(count) || count < 0) {
      throw new IngestDedupTelemetryError(
        `ingest dedup count for ${JSON.stringify(ref)} must be a non-negative integer; ` +
          `got ${JSON.stringify(count)}`,
      );
    }
    totals.set(ref, (totals.get(ref) ?? 0) + count);
  }
  return totals;
}

function buildSourceRefs(
  surface: IngestDedupSurface,
  tracked: ReadonlyArray<readonly [string, number]>,
): ReadonlyArray<ContinuitySourceRef> {
  return Object.freeze(tracked.map(([ref]) => Object.freeze({ id: ref, kind: surface })));
}

export interface IngestDedupFilter {
  readonly surface?: IngestDedupSurface;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

/** List `ingest_dedup` records newest-first, after applying filters. */
export function listIngestDedupReports(
  vault: string,
  filter: IngestDedupFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: INGEST_DEDUP_RECORD_KIND,
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter(
    (record) => filter.surface === undefined || record.payload["surface"] === filter.surface,
  );
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

/** One point of the re-ingest trend: a single run's exact-hash drop count. */
export interface IngestDedupTrendPoint {
  readonly at: string;
  readonly surface: string;
  readonly exact_deduped: number;
}

/** How much re-ingest pressure one source accounts for, across runs. */
export interface IngestDedupSourceRollup {
  readonly ref: string;
  readonly surface: string;
  readonly exact_deduped: number;
  readonly records: number;
}

export interface IngestDedupSummary {
  readonly total_records: number;
  /** Items dropped on an exact sha-256 collision. Never a semantic figure. */
  readonly total_exact_deduped: number;
  readonly by_surface: Readonly<Record<string, number>>;
  /** Heaviest re-ingested sources first - the "which source" answer. */
  readonly by_source: ReadonlyArray<IngestDedupSourceRollup>;
  /** One point per run, oldest first, so a spike is visible over time. */
  readonly trend: ReadonlyArray<IngestDedupTrendPoint>;
}

/** Aggregate the persisted dedup records into a trend plus a per-source ranking. */
export function summarizeIngestDedup(
  vault: string,
  filter: IngestDedupFilter = {},
): IngestDedupSummary {
  const records = listIngestDedupReports(vault, filter).toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const bySurface: Record<string, number> = {};
  const bySource = new Map<string, { rollup: IngestDedupSourceRollup }>();
  const trend: IngestDedupTrendPoint[] = [];
  let totalExact = 0;

  for (const record of records) {
    const payload = record.payload;
    const surface = typeof payload["surface"] === "string" ? payload["surface"] : "unknown";
    const exact = numberOr0(payload["exact_deduped"]);
    totalExact += exact;
    bySurface[surface] = (bySurface[surface] ?? 0) + exact;
    trend.push(Object.freeze({ at: record.createdAt, surface, exact_deduped: exact }));

    for (const [ref, count] of readSourceMap(payload["by_source"])) {
      // Axis label folded into the key so the same ref on two surfaces
      // never merges into one misleading rollup.
      const key = `${surface}\0${ref}`;
      const previous = bySource.get(key)?.rollup;
      bySource.set(key, {
        rollup: Object.freeze({
          ref,
          surface,
          exact_deduped: (previous?.exact_deduped ?? 0) + count,
          records: (previous?.records ?? 0) + 1,
        }),
      });
    }
  }

  const ranked = [...bySource.values()]
    .map((entry) => entry.rollup)
    .toSorted((left, right) =>
      right.exact_deduped === left.exact_deduped
        ? left.ref.localeCompare(right.ref)
        : right.exact_deduped - left.exact_deduped,
    );

  return Object.freeze({
    total_records: records.length,
    total_exact_deduped: totalExact,
    by_surface: Object.freeze(bySurface),
    by_source: Object.freeze(ranked),
    trend: Object.freeze(trend),
  });
}

function readSourceMap(value: unknown): ReadonlyArray<readonly [string, number]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const out: Array<readonly [string, number]> = [];
  for (const [ref, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count)) out.push([ref, count] as const);
  }
  return out;
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

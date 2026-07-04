/**
 * Memory-operation cost meter (article: "Memory cost meter").
 *
 * The recall-telemetry surface (`recall-telemetry.ts`) accounts only for
 * READS - the `search | context_pack | pre_compress | query` modes. There
 * was no write-side accounting, so "is my agent write-heavy?" - the
 * question the source article argues is the real one ("how often does your
 * agent write memory, how often does it read memory, and what does the
 * tool charge for?") - could not be answered from the vault.
 *
 * This module folds WRITE volume against the existing read telemetry and
 * surfaces a write-vs-read ratio plus a rough cost signal per period, so
 * an operator can spot "write-heavy chaos" before the bill does.
 *
 * WRITE sources (what the meter counts):
 *   - Brain daily-log write verbs (`Brain/log/<date>`): `feedback`
 *     (brain_feedback), `apply-evidence` (brain_apply_evidence), and
 *     `note` (brain_note).
 *   - Native host-memory bridge writes: `host_memory_write` continuity
 *     records (the create-note-style writes Hermes bridges into the vault).
 *
 * NOT counted (documented honestly rather than silently): `brain_create_note`
 * file creation, which writes a note file but emits no log/continuity event
 * today - there is nothing to fold. When it grows a telemetry event this
 * meter should pick it up via a new {@link MemoryWriteKind}.
 *
 * The meter is READ-ONLY and deterministic: it aggregates events already on
 * disk, never emits its own record and never calls a model.
 */

import { listContinuityRecords } from "./continuity/store.ts";
import { HOST_MEMORY_WRITE_KIND } from "./host-memory-write.ts";
import { listLogDates, readLogDay } from "./log-jsonl.ts";
import { summarizeRecallTelemetry, type RecallTelemetryMode } from "./recall-telemetry.ts";

/** Countable memory-write categories the meter folds against reads. */
export type MemoryWriteKind = "feedback" | "apply_evidence" | "note" | "host_memory_write";

/**
 * Brain daily-log event kinds that represent an agent-driven memory
 * SAVE, mapped to the meter's stable snake_case write-kind labels. Log
 * kinds absent from this map (dream, promote, retire, ...) are lifecycle
 * transitions, not writes, and are ignored.
 */
const LOG_EVENT_TO_WRITE_KIND: Readonly<Record<string, MemoryWriteKind>> = Object.freeze({
  feedback: "feedback",
  "apply-evidence": "apply_evidence",
  note: "note",
});

export interface MemoryWriteFilter {
  /** Inclusive lower ISO-8601 timestamp bound. */
  readonly since?: string;
  /** Inclusive upper ISO-8601 timestamp bound. */
  readonly until?: string;
}

export interface MemoryWriteSummary {
  readonly total: number;
  readonly by_kind: Partial<Record<MemoryWriteKind, number>>;
}

/**
 * Count memory-write operations over a period. Reads the Brain daily log
 * for the agent write verbs and the continuity log for host-bridge writes,
 * bounded by the same inclusive `[since, until]` window the recall summary
 * uses so the two sides stay comparable.
 */
export function summarizeMemoryWrites(
  vault: string,
  filter: MemoryWriteFilter = {},
): MemoryWriteSummary {
  const byKind: Partial<Record<MemoryWriteKind, number>> = {};
  let total = 0;
  const bump = (kind: MemoryWriteKind): void => {
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    total += 1;
  };

  // Brain daily-log write verbs. Skip whole day files outside the window
  // before reading them, then bound each entry by its exact timestamp.
  const sinceDay = filter.since?.slice(0, 10);
  const untilDay = filter.until?.slice(0, 10);
  for (const date of listLogDates(vault)) {
    if (sinceDay !== undefined && date < sinceDay) continue;
    if (untilDay !== undefined && date > untilDay) continue;
    for (const entry of readLogDay(vault, date).entries) {
      const kind = LOG_EVENT_TO_WRITE_KIND[entry.eventType];
      if (kind === undefined) continue;
      if (!withinBounds(entry.timestamp, filter)) continue;
      bump(kind);
    }
  }

  // Native host-memory bridge writes (continuity records). The store's
  // since/until filter already applies the same inclusive bounds.
  const hostWrites = listContinuityRecords(vault, {
    kind: HOST_MEMORY_WRITE_KIND,
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  });
  for (let i = 0; i < hostWrites.length; i += 1) bump("host_memory_write");

  return Object.freeze({ total, by_kind: Object.freeze(byKind) });
}

/** Per-operation cost weights ("what the tool charges" per write / read). */
export interface MemoryCostWeights {
  readonly write: number;
  readonly read: number;
}

/** Unit weights: one cost unit per operation regardless of direction. */
export const DEFAULT_MEMORY_COST_WEIGHTS: MemoryCostWeights = Object.freeze({ write: 1, read: 1 });

/**
 * Default write-heavy threshold on the write/read ratio. `1` means "more
 * writes than reads is write-heavy" - the article's "write-heavy chaos"
 * baseline. Operators tune it per their tool's pricing.
 */
export const DEFAULT_WRITE_HEAVY_RATIO = 1;

export interface MemoryCostMeterOptions {
  readonly since?: string;
  readonly until?: string;
  /** Override per-operation weights; missing fields fall back to unit weights. */
  readonly weights?: Partial<MemoryCostWeights>;
  /** Ratio above which the period is flagged write-heavy. Default 1. */
  readonly writeHeavyRatio?: number;
}

export interface MemoryCostMeter {
  readonly period: { readonly since: string | null; readonly until: string | null };
  readonly writes: MemoryWriteSummary;
  readonly reads: {
    readonly total: number;
    readonly by_mode: Partial<Record<RecallTelemetryMode, number>>;
  };
  /**
   * writes / reads, rounded to 2 decimals. `null` when there are no reads
   * in the period (division undefined) - inspect `write_heavy` instead.
   */
  readonly write_read_ratio: number | null;
  /**
   * `true` when the ratio exceeds `writeHeavyRatio`, or when there are
   * writes but zero reads (the extreme write-heavy case).
   */
  readonly write_heavy: boolean;
  readonly weights: MemoryCostWeights;
  readonly cost: { readonly write: number; readonly read: number; readonly total: number };
}

/**
 * Fold write volume against read telemetry into a single cost meter for a
 * period. Reads come from {@link summarizeRecallTelemetry}; writes from
 * {@link summarizeMemoryWrites}. The cost signal is a weighted op count -
 * deliberately rough: it models "some tools charge on write, some on
 * read" without pretending to be a billing integration.
 */
export function computeMemoryCostMeter(
  vault: string,
  options: MemoryCostMeterOptions = {},
): MemoryCostMeter {
  const filter: MemoryWriteFilter = {
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
  };
  const writes = summarizeMemoryWrites(vault, filter);
  const readSummary = summarizeRecallTelemetry(vault, filter);
  const reads = { total: readSummary.total, by_mode: readSummary.by_mode };

  const weights = resolveWeights(options.weights);
  const threshold = resolveWriteHeavyRatio(options.writeHeavyRatio);

  const ratio = reads.total === 0 ? null : round2(writes.total / reads.total);
  const writeHeavy = reads.total === 0 ? writes.total > 0 : (ratio as number) > threshold;

  const writeCost = round2(writes.total * weights.write);
  const readCost = round2(reads.total * weights.read);

  return Object.freeze({
    period: Object.freeze({
      since: options.since ?? null,
      until: options.until ?? null,
    }),
    writes,
    reads: Object.freeze({ total: reads.total, by_mode: reads.by_mode }),
    write_read_ratio: ratio,
    write_heavy: writeHeavy,
    weights,
    cost: Object.freeze({
      write: writeCost,
      read: readCost,
      total: round2(writeCost + readCost),
    }),
  });
}

function withinBounds(ts: string, filter: MemoryWriteFilter): boolean {
  if (filter.since !== undefined && ts < filter.since) return false;
  if (filter.until !== undefined && ts > filter.until) return false;
  return true;
}

function resolveWeights(weights: Partial<MemoryCostWeights> | undefined): MemoryCostWeights {
  return Object.freeze({
    write: finiteOrDefault(weights?.write, DEFAULT_MEMORY_COST_WEIGHTS.write),
    read: finiteOrDefault(weights?.read, DEFAULT_MEMORY_COST_WEIGHTS.read),
  });
}

function resolveWriteHeavyRatio(ratio: number | undefined): number {
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0
    ? ratio
    : DEFAULT_WRITE_HEAVY_RATIO;
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

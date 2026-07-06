/**
 * Usage-driven working-memory decay (Recall & Working-Memory Quality
 * Suite, t_c27e1c3f).
 *
 * Continuity records are append-only and immutable (deduped by a content
 * `recordId()`), so they can never be mutated to carry a usage counter.
 * Decay is therefore a pure, replayable READ-SIDE weight in (0, 1]
 * derived from two signals:
 *
 *   - AGE: how long ago the record was created (or last surfaced);
 *   - USAGE: how often and how recently the record's SOURCES were
 *     surfaced, read only from existing `recall_telemetry` records.
 *
 * The usage signal is keyed by the surfaced artifact identity (id and
 * path). A record whose sources never appear in recall telemetry - e.g.
 * a `pre_compact_extract` decision keyed by session/turn rather than a
 * vault path - simply has no usage and decays by AGE alone. There is no
 * fabricated coupling: absent usage is reported as absent, never guessed.
 *
 * Read-only by construction; this module never writes to the store.
 */

import { clamp01 } from "../../math.ts";
import { listRecallTelemetry } from "../recall-telemetry.ts";
import type { NormalizedContinuityRecord } from "./read-model.ts";

const DAY_MS = 86_400_000;

/** Tunables for the decay curve. All have deterministic defaults. */
export interface DecayWeightOptions {
  /** Exponential half-life of the age decay, in days. Default 30. */
  readonly halfLifeDays?: number;
  /** Per-log-access multiplier gain on the age-decayed base. Default 0.25. */
  readonly frequencyGain?: number;
  /** Lower clamp so a weight is always strictly positive. Default 0.02. */
  readonly minWeight?: number;
}

// Working-memory continuity decays faster than search activation
// (`src/core/search/activation/decay.ts` uses 60 days): a decision or
// commitment that has gone un-recalled for a month is already a weak
// working-memory signal, whereas search activation tracks longer-lived
// document relevance. The two half-lives are intentionally independent.
const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_FREQUENCY_GAIN = 0.25;
const DEFAULT_MIN_WEIGHT = 0.02;

/** The age and usage signal a decay weight is computed from. */
export interface UsageSignal {
  /** Record creation time, epoch ms. */
  readonly createdAtMs: number;
  /** How many times the record's sources were surfaced in recall. */
  readonly accessCount: number;
  /** Most recent surfacing time, epoch ms, or null when never surfaced. */
  readonly lastAccessAtMs: number | null;
}

/**
 * Pure decay weight in (0, 1]. The reference age is measured from the
 * last access when the record was ever surfaced, else from creation, so
 * a recently-used old record stays fresh. Frequency raises the weight
 * monotonically (bounded by the 1.0 cap); nothing here reads the clock
 * or any external state, so identical inputs always give identical
 * output.
 */
export function decayWeight(
  signal: UsageSignal,
  nowMs: number,
  opts: DecayWeightOptions = {},
): number {
  const halfLifeMs = Math.max(1, (opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) * DAY_MS);
  const frequencyGain = Math.max(0, opts.frequencyGain ?? DEFAULT_FREQUENCY_GAIN);
  const minWeight = clamp01(opts.minWeight ?? DEFAULT_MIN_WEIGHT);

  const referenceMs = signal.lastAccessAtMs ?? signal.createdAtMs;
  const ageMs = Math.max(0, nowMs - referenceMs);
  const base = Math.pow(0.5, ageMs / halfLifeMs);
  const frequencyMultiplier = 1 + frequencyGain * Math.log1p(Math.max(0, signal.accessCount));
  const raw = base * frequencyMultiplier;
  return Math.min(1, Math.max(minWeight, raw));
}

/** Aggregated surfacing signal for one artifact identity. */
export interface SourceUsage {
  readonly accessCount: number;
  readonly lastAccessAtMs: number;
}

interface MutableUsage {
  accessCount: number;
  lastAccessAtMs: number;
}

/** Filter forwarded to the telemetry scan (time window). */
export interface UsageSignalFilter {
  readonly since?: string;
  readonly until?: string;
}

/**
 * Build the usage map from `recall_telemetry` records. Each surfaced
 * artifact contributes one access; its `id` and `path` are registered
 * against the SAME aggregate object, so a record referencing either key
 * resolves to one usage entry (never double-counted). Last-access is the
 * max telemetry timestamp that surfaced the artifact.
 */
export function deriveUsageSignals(
  vault: string,
  filter: UsageSignalFilter = {},
): ReadonlyMap<string, SourceUsage> {
  const byKey = new Map<string, MutableUsage>();
  const telemetry = listRecallTelemetry(vault, {
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  });
  for (const record of telemetry) {
    const ts = Date.parse(record.createdAt);
    if (Number.isNaN(ts)) continue;
    for (const artifact of readArtifacts(record.payload["top_artifacts"])) {
      const id = artifact.id;
      const path = artifact.path;
      const existing =
        (id !== null ? byKey.get(id) : undefined) ?? (path !== null ? byKey.get(path) : undefined);
      const usage: MutableUsage = existing ?? { accessCount: 0, lastAccessAtMs: 0 };
      usage.accessCount += 1;
      usage.lastAccessAtMs = Math.max(usage.lastAccessAtMs, ts);
      if (id !== null) byKey.set(id, usage);
      if (path !== null) byKey.set(path, usage);
    }
  }
  return byKey;
}

/**
 * Aggregate the usage of a record across its source refs. Refs are
 * matched by `id` or `path`; the matched usage objects are deduped by
 * identity so an artifact registered under both keys counts once.
 * Returns zero access and null last-access when nothing matched - the
 * age-only decay case.
 */
export function usageForRecord(
  record: NormalizedContinuityRecord,
  signals: ReadonlyMap<string, SourceUsage>,
): { readonly accessCount: number; readonly lastAccessAtMs: number | null } {
  const matched = new Set<SourceUsage>();
  for (const ref of record.sourceRefs) {
    const id = readString(ref["id"]);
    const path = readString(ref["path"]);
    const usage =
      (id !== null ? signals.get(id) : undefined) ??
      (path !== null ? signals.get(path) : undefined);
    if (usage !== undefined) matched.add(usage);
  }
  if (matched.size === 0) return { accessCount: 0, lastAccessAtMs: null };
  let accessCount = 0;
  let lastAccessAtMs = 0;
  for (const usage of matched) {
    accessCount += usage.accessCount;
    lastAccessAtMs = Math.max(lastAccessAtMs, usage.lastAccessAtMs);
  }
  return { accessCount, lastAccessAtMs };
}

/** A record paired with its computed decay weight and the usage behind it. */
export interface DecayRankedRecord {
  readonly record: NormalizedContinuityRecord;
  readonly weight: number;
  readonly accessCount: number;
  readonly lastAccessAtMs: number | null;
}

/**
 * Rank records by descending decay weight. Pure and stable: ties keep
 * the input order, so a fixed store and `nowMs` always rank identically.
 */
export function rankByUsageDecay(
  records: ReadonlyArray<NormalizedContinuityRecord>,
  signals: ReadonlyMap<string, SourceUsage>,
  nowMs: number,
  opts: DecayWeightOptions = {},
): ReadonlyArray<DecayRankedRecord> {
  const ranked = records.map((record, index): DecayRankedRecord & { index: number } => {
    const usage = usageForRecord(record, signals);
    const createdAtMs = Date.parse(record.createdAt);
    const signal: UsageSignal = {
      createdAtMs: Number.isNaN(createdAtMs) ? nowMs : createdAtMs,
      accessCount: usage.accessCount,
      lastAccessAtMs: usage.lastAccessAtMs,
    };
    return {
      index,
      record,
      weight: decayWeight(signal, nowMs, opts),
      accessCount: usage.accessCount,
      lastAccessAtMs: usage.lastAccessAtMs,
    };
  });
  ranked.sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.index - b.index));
  return Object.freeze(ranked.map(({ index: _index, ...rest }) => Object.freeze(rest)));
}

interface ArtifactRef {
  readonly id: string | null;
  readonly path: string | null;
}

function readArtifacts(value: unknown): ReadonlyArray<ArtifactRef> {
  if (!Array.isArray(value)) return [];
  const refs: ArtifactRef[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = readString(record["id"]);
    const path = readString(record["path"]);
    if (id === null && path === null) continue;
    refs.push({ id, path });
  }
  return refs;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

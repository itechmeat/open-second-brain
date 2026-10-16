/**
 * The capacity gate: one measured-or-refused decision about whether this
 * vault has room for more bytes.
 *
 * ## Fresh at decision time
 *
 * The decision RE-MEASURES the vault. The stored `storage_usage`
 * aggregate is advisory - a sample taken yesterday says nothing about a
 * vault an agent wrote into this morning - so a gate that decided from
 * it would enforce a stale-counter lie. The forecast supplies the trend;
 * the fresh census supplies the bytes the tiers compare against. A gate
 * that needed no fresh bytes is an unbounded one, and it does not
 * measure at all: no cap, no cost.
 *
 * ## Two skip lines, two callers
 *
 * By default only a measured `critical` tier skips - the posture the
 * interactive ingest wall keeps, where `critical` is the refusal line.
 * A caller may also pass `pausePercent` (`storage.pause_percent`, the
 * maintenance lane's knob): any measured percent at or past that line
 * then skips too, one band before the wall, so background production
 * backs off while interactive ingest still works. An unmeasurable store
 * leaves the gate OPEN with the refused surfaces named, exactly as the
 * maintenance lane's host-pressure gate stays open when the machine
 * cannot be read: refusing to work forever on a vault one directory
 * cannot be listed in would be a worse failure than the gate not
 * closing. Only a MEASURED breach skips.
 */

import { loadGateStorageConfig, StorageGateConfigError } from "./gate-config.ts";
import type { StorageForecastTier } from "./forecast.ts";
import { STORAGE_FORECAST_TIER, forecastStorageUsage } from "./forecast.ts";
import { measureStorageUsage, type StorageUsage } from "./usage.ts";

/** The closed decision vocabulary. */
export const CAPACITY_GATE_DECISION = Object.freeze({
  run: "run",
  skip: "skip",
} as const);

export type CapacityGateDecisionKind =
  (typeof CAPACITY_GATE_DECISION)[keyof typeof CAPACITY_GATE_DECISION];

/** The fresh measurement the decision rests on, when one was taken. */
export interface CapacityGateReading {
  readonly measuredBytes: number;
  readonly capBytes: number;
  readonly percentUsed: number | null;
  readonly daysToCap: number | null;
  readonly slopeBytesPerDay: number | null;
  /** ISO-8601 stamp of the fresh census, from its injected `now`. */
  readonly measuredAt: string;
}

/** One gate decision: whether to run, on which tier, on what reading. */
export interface CapacityGateDecision {
  readonly decision: CapacityGateDecisionKind;
  readonly tier: StorageForecastTier;
  /**
   * Why no number could be attached - the refused surface names, when
   * the tier is `unmeasurable`. Surface names only, never paths.
   */
  readonly reason?: string;
  /** The fresh census behind the decision; absent for unbounded and unmeasurable. */
  readonly reading?: CapacityGateReading;
  /**
   * The fresh census itself, when one was taken - present for
   * `unmeasurable` too, because a partial census is still a census. The
   * usage sampler records it instead of re-walking the vault (see
   * `sampleStorageUsage`), so a decision costs one walk and never two.
   */
  readonly census?: StorageUsage;
  /**
   * The percent-of-cap line the caller asked background work to pause
   * at, when one was passed. Rides every decision it shaped - `run` as
   * much as `skip` - so a report can show how far the vault stands from
   * the pause line, not only the tier it measured.
   */
  readonly pausePercent?: number;
}

export interface EvaluateCapacityGateOptions {
  /** The configured cap in bytes, or `null`/absent for an unbounded vault. */
  readonly capBytes?: number | null;
  /** Threshold overrides; every one defaults to the forecast constant. */
  readonly warnPercent?: number;
  readonly criticalPercent?: number;
  /**
   * The percent-of-cap line background work pauses at. Absent, only the
   * critical tier skips (the interactive ingest wall's posture); the
   * maintenance lane passes the configured `storage.pause_percent`, so
   * background production backs off one band before the wall.
   */
  readonly pausePercent?: number;
  readonly warnDays?: number;
  readonly criticalDays?: number;
  /** Wall clock for the fresh census's stamp; defaults to the current time. */
  readonly now?: Date;
  /**
   * The explicit machine-config file the caller resolved from, so a
   * `search_db_path` in it moves the measured store the same way it moves
   * the indexer (`measureStorageUsage`'s option). Absent, the default file.
   */
  readonly configPath?: string;
}

/**
 * Decide whether `vault` has room, from a fresh census.
 *
 * Unbounded stores run without measuring. Everything else is measured
 * now; a census that could not read every surface runs with the refusal
 * named, and a measured critical tier is the only skip.
 */
export function evaluateCapacityGate(
  vault: string,
  opts: EvaluateCapacityGateOptions = {},
): CapacityGateDecision {
  const capBytes = opts.capBytes ?? null;
  if (capBytes === null) {
    return { decision: CAPACITY_GATE_DECISION.run, tier: STORAGE_FORECAST_TIER.unbounded };
  }

  const fresh = measureStorageUsage(vault, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  if (!fresh.complete) {
    return {
      decision: CAPACITY_GATE_DECISION.run,
      tier: STORAGE_FORECAST_TIER.unmeasurable,
      reason: `unmeasured surfaces: ${fresh.unmeasured.map((u) => u.surface).join(", ")}`,
      census: fresh,
    };
  }

  const forecast = forecastStorageUsage(vault, {
    capBytes,
    latestUsage: fresh,
    ...(opts.warnPercent !== undefined ? { warnPercent: opts.warnPercent } : {}),
    ...(opts.criticalPercent !== undefined ? { criticalPercent: opts.criticalPercent } : {}),
    ...(opts.warnDays !== undefined ? { warnDays: opts.warnDays } : {}),
    ...(opts.criticalDays !== undefined ? { criticalDays: opts.criticalDays } : {}),
  });

  // A measured critical tier skips for every caller. A percent at or
  // past the caller's pause line skips too, but only for the caller that
  // asked for the band: the ingest wall (no pausePercent) keeps its
  // critical-only posture.
  const pauseBreached =
    opts.pausePercent !== undefined &&
    forecast.percentUsed !== null &&
    forecast.percentUsed >= opts.pausePercent;

  const decision: CapacityGateDecision = {
    decision:
      forecast.tier === STORAGE_FORECAST_TIER.critical || pauseBreached
        ? CAPACITY_GATE_DECISION.skip
        : CAPACITY_GATE_DECISION.run,
    tier: forecast.tier,
    reading: {
      measuredBytes: fresh.totalBytes,
      capBytes,
      percentUsed: forecast.percentUsed,
      daysToCap: forecast.daysToCap,
      slopeBytesPerDay: forecast.slopeBytesPerDay,
      measuredAt: fresh.measuredAt,
    },
    census: fresh,
    ...(opts.pausePercent !== undefined ? { pausePercent: opts.pausePercent } : {}),
  };
  return decision;
}

export interface EvaluateIngestAdmissionOptions {
  /** Wall clock for the fresh census; defaults to the current time. */
  readonly now?: Date;
  /** The explicit machine-config file; see {@link EvaluateCapacityGateOptions.configPath}. */
  readonly configPath?: string;
}

/** One admission evaluation: a gate decision, or the refusal that replaces one. */
export interface IngestAdmission {
  /**
   * The gate decision, when a configured cap was measured. `null` means
   * no measurement was taken - an unbounded vault, or a storage block the
   * wall cannot see through (see {@link configRefusal}).
   */
  readonly decision: CapacityGateDecision | null;
  /**
   * Present when the `storage:` block (or the file it sits in) cannot be
   * read, parsed or validated: the wall refuses ingest, naming the field,
   * exactly as `brain_ingest_source` refuses with `config_invalid`. Every
   * other block is never read here, so a typo elsewhere cannot wedge the
   * wall either way.
   */
  readonly configRefusal?: string;
}

/**
 * The write-admission check behind `brain_ingest_source`, resolved once
 * for every background route that ingests - the capture inbox drain's
 * source-reference route included.
 *
 * An unbounded vault admits (`null`: no cap, no gate, no byte walk). A
 * configured cap is measured fresh, and only a MEASURED critical tier is
 * the refusal - exactly the interactive wall's posture, no pause line:
 * a capture an agent could not ingest by hand must not be sneaked in by
 * a drain, and a capture the wall would admit must not be refused by
 * one.
 *
 * The policy is read from the `storage:` block alone
 * ({@link loadGateStorageConfig}, the reader `brain_ingest_source` uses),
 * so the two walls apply one rule: a malformed unrelated block is never
 * read and cannot wedge the capture inbox shut, while a storage block the
 * wall cannot see through refuses ingest by name - reading it as "no cap"
 * would run writes past an operator's bound.
 */
export function evaluateIngestAdmission(
  vault: string,
  opts: EvaluateIngestAdmissionOptions = {},
): IngestAdmission {
  let storage;
  try {
    storage = loadGateStorageConfig(vault);
  } catch (err) {
    if (!(err instanceof StorageGateConfigError)) throw err;
    return { decision: null, configRefusal: err.message };
  }
  if (storage.cap_bytes === null) return { decision: null };
  return {
    decision: evaluateCapacityGate(vault, {
      now: opts.now ?? new Date(),
      ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
      capBytes: storage.cap_bytes,
      warnPercent: storage.warn_percent,
      criticalPercent: storage.critical_percent,
      warnDays: storage.warn_days,
      criticalDays: storage.critical_days,
    }),
  };
}

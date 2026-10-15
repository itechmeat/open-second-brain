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
 * ## Never skip on a refusal
 *
 * An unmeasurable store leaves the gate OPEN with the refused surfaces
 * named, exactly as the maintenance lane's host-pressure gate stays open
 * when the machine cannot be read: refusing to work forever on a vault
 * one directory cannot be listed in would be a worse failure than the
 * gate not closing. Only a MEASURED critical tier skips.
 */

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
   * `unmeasurable` too, because a partial census is still a census.
   * The usage sampler records it instead of re-walking the vault (see
   * `sampleStorageUsage`), so a decision costs one walk and never two.
   */
  readonly census?: StorageUsage;
}

export interface EvaluateCapacityGateOptions {
  /** The configured cap in bytes, or `null`/absent for an unbounded vault. */
  readonly capBytes?: number | null;
  /** Threshold overrides; every one defaults to the forecast constant. */
  readonly warnPercent?: number;
  readonly criticalPercent?: number;
  readonly warnDays?: number;
  readonly criticalDays?: number;
  /** Wall clock for the fresh census's stamp; defaults to the current time. */
  readonly now?: Date;
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

  const fresh = measureStorageUsage(vault, opts.now !== undefined ? { now: opts.now } : {});
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

  const decision: CapacityGateDecision = {
    decision:
      forecast.tier === STORAGE_FORECAST_TIER.critical
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
  };
  return decision;
}

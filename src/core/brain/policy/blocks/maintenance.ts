/**
 * The `maintenance:` block (t_992f0c33) — the two knobs of the
 * quiet-window lane that are policy rather than invocation.
 *
 * One reason to change: what stops the lane from starting heavy work.
 * The window and the busy threshold stay CLI flags because they belong
 * to the schedule that invokes the lane; these two belong to the vault,
 * because both answer a question the invoking cron line cannot: how much
 * of this machine the operator is willing to let a background pass take,
 * and how many times a task may fail before re-running it is no longer a
 * retry but a loop.
 *
 * Out-of-range values are hard errors. Every reader here follows the
 * policy stated in `../field-checks.ts`: a knob that silently clamped
 * would be indistinguishable from the operator never having set it, and
 * for a gate that is the worst possible failure - the operator would
 * believe a bound is in force that is not.
 */

import type {
  BrainConfig,
  BrainMaintenanceConfig,
  ResolvedBrainMaintenanceConfig,
} from "../../types.ts";
import { readBoundedInt } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "maintenance";

/**
 * Floor of the host-pressure threshold, as a percentage of usable CPU
 * capacity. One rather than zero: at zero the gate would close on a
 * perfectly idle host too, which is not a pressure gate but a way to
 * disable the lane - and the way to disable the lane is to stop invoking
 * it, where the decision is visible.
 */
export const MAINTENANCE_HOST_PRESSURE_PERCENT_MIN = 1;

/**
 * Ceiling of the same threshold. Ten times subscribed is far past any
 * host an operator would still call usable, so a larger number is a typo
 * (a ratio written where a percentage belongs) rather than an intent.
 */
export const MAINTENANCE_HOST_PRESSURE_PERCENT_MAX = 1000;

/**
 * Consecutive journaled failures after which a task is refused without
 * `--force`.
 *
 * Three, and the two neighbouring values are why. At one, any transient
 * fault - a provider 503, a momentarily full disk, a lock lost to a
 * concurrent editor - becomes a standing refusal an operator has to
 * clear by hand; that converts a self-healing outage into a manual one.
 * Three does not abolish that property, it only raises the bar: an
 * outage spanning three scheduled runs reaches the limit too, and then
 * the task is refused until an operator retries it. What makes that
 * acceptable is the shape of the escape rather than the number - the
 * refusal is per task, the other tasks keep running, and `--retry
 * <task>` attempts the refused one without switching off the window,
 * busy and host-pressure gates the operator configured. At five or ten,
 * a deterministically broken task keeps
 * costing a full lane slot on every scheduled run for days, and because
 * the lane orders tasks stale-first a permanently failing task floats to
 * the FRONT of every pass - so it spends the lease before the healthy
 * tasks get it. Three attempts, each with its own fresh safeguard
 * deadline, is past the range a single transient fault spans and short of
 * that starvation; it is also the retry count this repository already
 * treats as "tried enough" in both of its lock ladders
 * (`src/core/reliability/lock.ts`, `src/core/search/store/writer-lock.ts`).
 */
export const MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT = 3;

/** One is the hair trigger: refuse after a single failure. Permitted, not advised. */
export const MAINTENANCE_FAILURE_STREAK_LIMIT_MIN = 1;

/** Past the journal's own useful depth, a larger limit stops meaning anything. */
export const MAINTENANCE_FAILURE_STREAK_LIMIT_MAX = 100;

const KNOWN_KEYS = ["host_pressure_percent", "failure_streak_limit"] as const;

/**
 * Defaults for an absent block. `host_pressure_percent` is `null` rather
 * than a number: the fourth gate has no neutral default, because any
 * number would start refusing work on vaults whose operator never asked
 * for the gate. Unset means the gate is not configured and never fires,
 * exactly as an unconfigured window is always open.
 */
export const BRAIN_MAINTENANCE_DEFAULTS: ResolvedBrainMaintenanceConfig = Object.freeze({
  host_pressure_percent: null,
  failure_streak_limit: MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT,
}) as ResolvedBrainMaintenanceConfig;

/** Merge a parsed `maintenance` block (or `undefined`) with the defaults. */
export function resolveMaintenance(cfg: BrainConfig): ResolvedBrainMaintenanceConfig {
  const m = cfg.maintenance;
  if (m === undefined) return BRAIN_MAINTENANCE_DEFAULTS;
  return {
    host_pressure_percent:
      m.host_pressure_percent ?? BRAIN_MAINTENANCE_DEFAULTS.host_pressure_percent,
    failure_streak_limit: m.failure_streak_limit ?? BRAIN_MAINTENANCE_DEFAULTS.failure_streak_limit,
  };
}

export function parseMaintenanceBlock(ctx: BlockParseContext): BrainMaintenanceConfig | undefined {
  const map = openBlock(ctx, BLOCK);
  if (map === undefined) return undefined;

  const hostPressurePercent = readBoundedInt(
    map,
    "host_pressure_percent",
    MAINTENANCE_HOST_PRESSURE_PERCENT_MIN,
    MAINTENANCE_HOST_PRESSURE_PERCENT_MAX,
    "maintenance.host_pressure_percent",
    ctx.source,
  );
  const failureStreakLimit = readBoundedInt(
    map,
    "failure_streak_limit",
    MAINTENANCE_FAILURE_STREAK_LIMIT_MIN,
    MAINTENANCE_FAILURE_STREAK_LIMIT_MAX,
    "maintenance.failure_streak_limit",
    ctx.source,
  );
  warnUnknownKeys(ctx, map, KNOWN_KEYS, BLOCK);
  return {
    ...(hostPressurePercent !== undefined ? { host_pressure_percent: hostPressurePercent } : {}),
    ...(failureStreakLimit !== undefined ? { failure_streak_limit: failureStreakLimit } : {}),
  };
}

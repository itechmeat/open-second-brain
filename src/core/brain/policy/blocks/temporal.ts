/**
 * The `temporal:` block — staleness windows and the calendar conventions
 * the brief/report surfaces align to.
 *
 * One reason to change: how the vault's notion of "stale" and "this week"
 * is configured. Every knob is purely structural; none of them detects
 * anything from prose.
 */

import type { BrainConfig, BrainTemporalConfig, ResolvedBrainTemporalConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "temporal";

/** Sub-keys whose value is a plain positive day count. */
const STALE_DAY_KEYS = ["stale_pref_days", "stale_signal_days", "stale_log_days"] as const;

/**
 * Default `temporal:` block (v0.10.18). Drives the temporal +
 * synthesis subsystem. Absent block falls back here via
 * `resolveTemporal`. All knobs are purely structural:
 *
 *   - `stale_pref_days: 90` - 3 months without activity before a
 *     preference is reported as stale.
 *   - `stale_signal_days: 30` - 1 month without activity for signals.
 *   - `stale_log_days: 180` - 6 months for Brain/log files.
 *   - `weekly_start_dow: 1` - ISO-8601 weekday number (1 = Monday,
 *     7 = Sunday). Configurable for vaults that prefer Sunday-start
 *     weeks without any language-specific detection.
 *   - `daily_window_offset_hours: 0` - daily-brief windows align
 *     with UTC midnight by default.
 */
export const BRAIN_TEMPORAL_DEFAULTS: ResolvedBrainTemporalConfig = Object.freeze({
  stale_pref_days: 90,
  stale_signal_days: 30,
  stale_log_days: 180,
  weekly_start_dow: 1,
  daily_window_offset_hours: 0,
}) as ResolvedBrainTemporalConfig;

/**
 * Merge a parsed `temporal` block (or `undefined`) with
 * `BRAIN_TEMPORAL_DEFAULTS`.
 */
export function resolveTemporal(cfg: BrainConfig): ResolvedBrainTemporalConfig {
  const tp = cfg.temporal;
  if (tp === undefined) return BRAIN_TEMPORAL_DEFAULTS;
  return {
    stale_pref_days: tp.stale_pref_days ?? BRAIN_TEMPORAL_DEFAULTS.stale_pref_days,
    stale_signal_days: tp.stale_signal_days ?? BRAIN_TEMPORAL_DEFAULTS.stale_signal_days,
    stale_log_days: tp.stale_log_days ?? BRAIN_TEMPORAL_DEFAULTS.stale_log_days,
    weekly_start_dow: tp.weekly_start_dow ?? BRAIN_TEMPORAL_DEFAULTS.weekly_start_dow,
    daily_window_offset_hours:
      tp.daily_window_offset_hours ?? BRAIN_TEMPORAL_DEFAULTS.daily_window_offset_hours,
  };
}

/**
 * Shape:
 *   temporal:
 *     stale_pref_days: 90              # positive integer
 *     stale_signal_days: 30            # positive integer
 *     stale_log_days: 180              # positive integer
 *     weekly_start_dow: 1              # 1..7 (ISO-8601 weekday)
 *     daily_window_offset_hours: 0     # -23..23
 */
export function parseTemporalBlock(ctx: BlockParseContext): BrainTemporalConfig | undefined {
  const tpObj = openBlock(ctx, BLOCK);
  if (tpObj === undefined) return undefined;

  const partial: Record<string, unknown> = {};
  for (const key of STALE_DAY_KEYS) {
    if (!(key in tpObj)) continue;
    const v = tpObj[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new BrainConfigError("must be a positive integer", `temporal.${key}`, ctx.source);
    }
    partial[key] = v;
  }
  if ("weekly_start_dow" in tpObj) {
    const v = tpObj["weekly_start_dow"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 7) {
      throw new BrainConfigError(
        "must be an ISO-8601 weekday number (1..7)",
        "temporal.weekly_start_dow",
        ctx.source,
      );
    }
    partial["weekly_start_dow"] = v;
  }
  if ("daily_window_offset_hours" in tpObj) {
    const v = tpObj["daily_window_offset_hours"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < -23 || v > 23) {
      throw new BrainConfigError(
        "must be an integer in [-23, 23]",
        "temporal.daily_window_offset_hours",
        ctx.source,
      );
    }
    partial["daily_window_offset_hours"] = v;
  }
  warnUnknownKeys(
    ctx,
    tpObj,
    [...STALE_DAY_KEYS, "weekly_start_dow", "daily_window_offset_hours"],
    BLOCK,
  );
  return partial as BrainTemporalConfig;
}

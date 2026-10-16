/**
 * The storage-capacity doctor check: how full a CAPPED vault is.
 *
 * The check is inert without a cap. An unbounded vault has no capacity
 * question to answer, and reporting "you are at 3 percent of no cap"
 * would be noise - the same reason the maintenance pressure gate never
 * fires unconfigured. The moment `storage.cap_bytes` is set, the check
 * measures the vault the way the capacity gate does and reports:
 *
 *   - past the critical percent or horizon: an ERROR - a write the gate
 *     refuses is a condition the operator has to see before the next
 *     tool call explains it for them;
 *   - past the warn band: a WARNING - the trend, while there is still
 *     time to act on it;
 *   - an unmeasurable store: an UNCERTAIN entry naming the refused
 *     surfaces, never a quiet pass - a census that could not read a
 *     surface cannot claim the vault has room.
 *
 * The reading is a whole-vault byte figure: it moves when a page the
 * caller may not read appears or goes, and no filtered form of it exists.
 * Below local reach (`ctx.reach`) it is therefore not reported - the same
 * local-reach rule `brain_storage` refuses its census under - and the
 * check lands the UNCERTAIN entry naming the reach instead, never a
 * quiet pass and never the figures. The check's own shell callers pass
 * no reach, which reads as local, so the operator's report is unchanged.
 *
 * The store is measured at `ctx.dbPath` when the pass carries one (the
 * store the operator's searches actually use) and through the default
 * resolution otherwise. The reading re-measures rather than trusting the
 * stored `storage_usage` aggregate, for the same reason the capacity
 * gate does: the aggregate is advisory, the census is the fact.
 */

import { resolveStorage } from "../policy.ts";
import { TRANSPORT_REACH } from "../../graph/transport-reach.ts";
import {
  STORAGE_FORECAST_TIER,
  forecastStorageUsage,
  type StorageForecastTier,
} from "../storage/forecast.ts";
import { measureStorageUsage } from "../storage/usage.ts";
import { brainDirs } from "../paths.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** The newest reading is past the warn band of the configured cap. */
export const STORAGE_CAPACITY_WARN_CODE = "storage-capacity-warn";

/** The newest reading is past the critical band: writes get refused. */
export const STORAGE_CAPACITY_CRITICAL_CODE = "storage-capacity-critical";

/** The census could not read every surface, so fullness is unknown. */
export const STORAGE_CAPACITY_UNMEASURED_CODE = "storage-capacity-unmeasured";

/** The command both issue codes point at: the report surface. */
const STORAGE_NEXT_COMMAND = "o2b brain storage";

/** Render a forecast tier's numbers into one operator-readable sentence. */
function describeReading(
  tier: StorageForecastTier,
  percent: number | null,
  days: number | null,
): string {
  const parts: string[] = [];
  if (percent !== null) parts.push(`${percent.toFixed(1)} percent of the configured cap`);
  if (days !== null) parts.push(`${days.toFixed(1)} days to the cap at the measured trend`);
  if (parts.length === 0) parts.push(`tier ${tier}`);
  return parts.join(", ");
}

export const storageCapacityCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    if (ctx.config === undefined) return;
    const storage = resolveStorage(ctx.config);
    if (storage.cap_bytes === null) return;

    // The whole-vault reading is a local-reach fact (`brain_storage`'s
    // rule). Below local reach it is not taken for the caller at all, so
    // this answers in the uncertain stream under the same unmeasured
    // code - fullness unknown, stated by name, no figures - and the warn
    // and critical issues are never emitted, because either would carry
    // the census in its message.
    if (ctx.reach !== undefined && ctx.reach !== TRANSPORT_REACH.local) {
      pushUncertain(out.uncertain, {
        code: STORAGE_CAPACITY_UNMEASURED_CODE,
        path: brainDirs(ctx.vault).brain,
        message:
          "storage capacity is not evaluated at this reach, so whether the " +
          "vault is within its cap is unknown",
      });
      return;
    }

    const usage = measureStorageUsage(ctx.vault, {
      now: ctx.now,
      ...(ctx.dbPath !== undefined ? { storePath: ctx.dbPath } : {}),
      ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
    });
    if (!usage.complete) {
      pushUncertain(out.uncertain, {
        code: STORAGE_CAPACITY_UNMEASURED_CODE,
        path: brainDirs(ctx.vault).brain,
        message:
          `storage capacity could not be measured: the census was refused for ` +
          `${usage.unmeasured.map((u) => u.surface).join(", ")}, so whether the vault ` +
          `is within its ${storage.cap_bytes} byte cap is unknown`,
      });
      return;
    }

    const forecast = forecastStorageUsage(ctx.vault, {
      capBytes: storage.cap_bytes,
      latestUsage: usage,
      warnPercent: storage.warn_percent,
      criticalPercent: storage.critical_percent,
      warnDays: storage.warn_days,
      criticalDays: storage.critical_days,
    });
    if (forecast.tier === STORAGE_FORECAST_TIER.critical) {
      out.issues.push({
        severity: "error",
        code: STORAGE_CAPACITY_CRITICAL_CODE,
        message:
          `storage usage is ${describeReading(forecast.tier, forecast.percentUsed, forecast.daysToCap)} ` +
          `(${forecast.measuredBytes} of ${storage.cap_bytes} bytes); writes gated on capacity ` +
          `are refused past this line - reclaim space or raise the cap, then see ${STORAGE_NEXT_COMMAND}`,
      });
      return;
    }
    if (forecast.tier === STORAGE_FORECAST_TIER.warn) {
      out.issues.push({
        severity: "warning",
        code: STORAGE_CAPACITY_WARN_CODE,
        message:
          `storage usage is ${describeReading(forecast.tier, forecast.percentUsed, forecast.daysToCap)} ` +
          `(${forecast.measuredBytes} of ${storage.cap_bytes} bytes) - see ${STORAGE_NEXT_COMMAND}`,
      });
    }
  },
};

/**
 * Doctor finding: another device's entries in this machine's device-local
 * state directory (design D1, task 2.12).
 *
 * The directory `o2b store path` reports as `device_state_dir` belongs to
 * one machine and is never synced: it holds this device's persisted clock
 * and its shard append locks. When it holds a clock or locks keyed by
 * another device id, the directory (or the whole state base) was put in a
 * sync folder, and two machines now share clocks and locks that must stay
 * apart. The finding names the foreign ids (`store/device-state-scan.ts`)
 * and the remedy; this device's own entries and the store-wide ones are
 * never reported.
 *
 * Silent when no store is known on this machine, when its state directory
 * does not exist, and when this machine has no device id (nothing then
 * tells its own entries from another's). Read-only.
 */

import { readDeviceId } from "../../config.ts";
import { foreignDeviceEntries } from "../../store/device-state-scan.ts";
import { describeConfiguredStoreLocation } from "../../store/store-location.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";

/** The device-local state directory holds entries keyed by another device id. */
export const STORE_DEVICE_STATE_FOREIGN_CODE = "store-device-state-foreign";

/** Entries named per device before the rest are only counted. */
const SAMPLE = 3;

function located(ctx: StoreSideCheckContext): { stateDir: string; device: string } | null {
  try {
    const { deviceStateDir } = describeConfiguredStoreLocation(ctx.configPath);
    if (deviceStateDir.scope !== "store" || !deviceStateDir.exists) return null;
    const device = readDeviceId(ctx.configPath);
    return device === null ? null : { stateDir: deviceStateDir.path, device };
  } catch {
    // An unreadable config or store root is the store section's finding.
    return null;
  }
}

export const deviceStateCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    const where = located(ctx);
    if (where === null) return;
    const foreign = foreignDeviceEntries(where.stateDir, where.device);
    if (foreign.length === 0) return;
    const listed = foreign
      .map(({ device, entries }) => {
        const more = entries.length > SAMPLE ? ` and ${entries.length - SAMPLE} more` : "";
        return `${device} (${entries.slice(0, SAMPLE).join(", ")}${more})`;
      })
      .join("; ");
    out.issues.push({
      severity: "warning",
      code: STORE_DEVICE_STATE_FOREIGN_CODE,
      path: where.stateDir,
      message:
        `the device-local state directory of this machine (device ${where.device}) holds ` +
        `entries of ${foreign.length} other device(s): ${listed}. This directory must never ` +
        "be synced: it was put in a sync folder, so machines share clocks and locks that must " +
        "stay apart. Remove it (or the state directory above it) from the sync tool's folders, " +
        "sync only the store's partition folders, then delete the other devices' entries here",
    });
  },
};

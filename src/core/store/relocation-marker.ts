/**
 * The light half of the store relocation (`store-relocation.ts`): the
 * device-local lock a relocation holds, which every store append reads,
 * and (re-exported from `relocation-target.ts`) the marker a moved root
 * carries. Kept apart so the appender depends on nothing of the
 * relocation itself.
 */

import { join } from "node:path";

import { resolveLockWaitBudgetMs } from "../brain/sync-lockfile.ts";
import { sleepSync } from "../fs-atomic.ts";
import { processLockHeld } from "./process-lock.ts";

export {
  followRelocation,
  readRelocatedMarker,
  readRelocationMarker,
  relocatedRootOf,
  relocationOf,
  relocationUnavailableReason,
  type FollowedRelocation,
  type RelocatedMarker,
  type RelocationMarkerRead,
  type RelocationOf,
  type RelocationRefused,
} from "./relocation-target.ts";

/** The device-local lock a relocation holds and every append checks. */
export function relocationLockTarget(deviceStateDir: string): string {
  return join(deviceStateDir, "relocation");
}

/**
 * Whether a relocation of the store with this device-local directory runs
 * now. The process-lock reader tells a holder that is absent from one it
 * cannot examine (that one counts as held), so no other check comes first.
 */
export function relocationRunning(deviceStateDir: string): boolean {
  return processLockHeld(relocationLockTarget(deviceStateDir));
}

/**
 * Wait while a relocation of the store with this device-local directory
 * runs, within the shared lock budget; throws when it is still running
 * after it.
 */
export function waitForRelocation(
  deviceStateDir: string,
  budgetMs = resolveLockWaitBudgetMs(),
): void {
  const started = Date.now();
  while (relocationRunning(deviceStateDir)) {
    if (Date.now() - started >= budgetMs) {
      const err: NodeJS.ErrnoException = new Error(
        "the brain store is being moved into the vault on this machine; retry in a moment",
      );
      err.code = "ELOCKED";
      throw err;
    }
    sleepSync(50);
  }
}

/**
 * The cohort status (`cohort-status.ts`) of this machine's vault, for the
 * doctor and the store status block (change stale-device-retirement,
 * design D7): null unless this device switched to the store and the vault
 * still holds the legacy `Brain/` tree. Read-only: no shard is recorded as
 * seen, and a store or config problem answers null.
 */

import { pathPresent } from "../vault-unexaminable.ts";
import { join } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { readDeviceId } from "../config.ts";
import { withoutSeenRecording } from "../store/seen-shards.ts";
import { deviceSwitchedHere } from "../store/store-only.ts";
import { inspectStore, type StoreHandle } from "../store/store-open.ts";
import { deviceStateDirFor, resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import { readCohortStatus, type CohortStatus } from "./cohort-status.ts";

/** This machine's store as the migration readers take it, or null. */
export function migrationStoreHere(configPath: string | undefined): StoreHandle | null {
  try {
    const inspection = inspectStore(resolveConfiguredStoreRoot(configPath).root);
    const device = readDeviceId(configPath);
    if (inspection === null || device === null) return null;
    return { ...inspection, device, deviceStateDir: deviceStateDirFor(inspection.storeId) };
  } catch {
    return null;
  }
}

export function cohortStatusHere(
  vault: string | null,
  configPath: string | undefined,
  now: Date,
): CohortStatus | null {
  if (vault === null || !pathPresent(vault, join(vault, BRAIN_ROOT_REL))) return null;
  return withoutSeenRecording(() => {
    const store = migrationStoreHere(configPath);
    if (store === null) return null;
    try {
      if (!deviceSwitchedHere(store, store.device)) return null;
      return readCohortStatus(store, vault, now);
    } catch {
      return null;
    }
  });
}

/**
 * Forget this machine's cached owner check (change `dream-session-trigger`,
 * design D2): the day check trusts, for the rest of a UTC day, what its
 * first look found (this device is not the owner, `dream.auto` is off).
 * A verb that changes either on this machine (taking or giving up the
 * dream owner role, setting `dream.auto`) clears that answer, so the next
 * session start of the same day looks again instead of waiting for the
 * next day.
 */

import { existsSync } from "node:fs";

import { discoverConfig } from "../../config.ts";
import { dreamTriggerLocation, updateDreamTriggerRecord } from "./record.ts";

/** Clear the cached owner check of this machine's record. Best effort: never throws. */
export function forgetDreamOwnerCheck(configPath: string | undefined): void {
  try {
    const { storeRoot, recordPath: path } = dreamTriggerLocation(discoverConfig(configPath));
    // No record, no cached answer: nothing is made.
    if (!existsSync(path)) return;
    updateDreamTriggerRecord(path, storeRoot, (r) =>
      r.owner_checked_day === null ? null : { ...r, owner_checked_day: null },
    );
  } catch {
    // The cached answer lasts until the next UTC day, as before.
  }
}

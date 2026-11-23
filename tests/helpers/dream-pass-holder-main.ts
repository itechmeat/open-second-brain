/**
 * A separate process that holds the dream pass lock of one device, for the
 * tests that need a live holder other than the test process itself.
 *
 *   bun tests/helpers/dream-pass-holder-main.ts '<store handle json>' <hold ms> [<until file>]
 *
 * It takes the lock through the product's own `withDreamPassLock`, writes
 * `held` to its stdout once it holds it, keeps it for `<hold ms>`
 * (blocking, as a pass does) and releases it on a normal exit. Given an
 * `<until file>`, it releases as soon as that file exists, and `<hold ms>`
 * only caps the hold. Killed, it leaves its holder record behind, as a
 * crashed pass does.
 */
import { existsSync, writeSync } from "node:fs";

import { withDreamPassLock } from "../../src/core/brain/dream-owner/owner.ts";
import { sleepSync } from "../../src/core/fs-atomic.ts";
import type { StoreHandle } from "../../src/core/store/store-open.ts";

const [handleJson, holdMs, untilFile] = process.argv.slice(2);
const raw = JSON.parse(handleJson!) as Omit<StoreHandle, "partitions"> & { partitions: string[] };
const store = { ...raw, partitions: new Set(raw.partitions) } as StoreHandle;
withDreamPassLock(store, () => {
  writeSync(1, "held\n");
  const deadline = Date.now() + Number(holdMs);
  if (untilFile === undefined) sleepSync(Number(holdMs));
  else while (!existsSync(untilFile) && Date.now() < deadline) sleepSync(5);
});

/**
 * Test helper for a machine that holds fewer partitions than the store it
 * was set up with. Partitions are sticky per machine (`held-ledger.ts`): a
 * partition this machine opened or initialised and then lost makes the
 * store unopenable. A test that models a machine which never held
 * `private` (a second machine, or one set up with `--partitions shared`)
 * removes the partition AND this machine's list of held partitions; the
 * next open lists what the store shows then.
 */
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { HELD_LEDGER_DIR } from "../../src/core/store/held-ledger.ts";
import { storesStateDir } from "../../src/core/store/store-paths.ts";

/** Forget, on this machine, which partitions of any store it has held. */
export function forgetHeldPartitions(): void {
  rmSync(join(storesStateDir(), HELD_LEDGER_DIR), { recursive: true, force: true });
}

/** Remove `partition` from the store at `root` as if this machine never held it. */
export function neverHeld(root: string, partition: "shared" | "private" = "private"): void {
  rmSync(join(root, partition), { recursive: true, force: true });
  forgetHeldPartitions();
}

/** Move `partition` of the store at `root` to `aside` as if this machine never held it. */
export function moveNeverHeld(root: string, aside: string, partition: "private" = "private"): void {
  renameSync(join(root, partition), aside);
  forgetHeldPartitions();
}

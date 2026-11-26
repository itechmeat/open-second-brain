/**
 * The owner's state after 2.0.0, carried to 2.0.1 by real processes
 * (release 2.0.1). Two machines ran Open Second Brain 1.98.0 on one vault
 * (`fixtures/legacy-v1.98-two-machines`); machine A then switched with its
 * brain store at the per-user default folder outside the vault, where 2.0.0
 * put it, and B stayed on the legacy layout. The only transport is a copy
 * of the vault folder:
 *
 *  1. A's session start on 2.0.1 moves nothing and says, in its one line,
 *     that the store is outside the vault and which command moves it;
 *  2. `o2b store move-into-vault` on A, with no session running, moves the
 *     store into the vault's `.open-second-brain-store/` folder and keeps
 *     the old folder as a recovery copy;
 *  3. the vault copies to B; B's session start joins the store as a later
 *     machine;
 *  4. after copies both ways both machines hold the same record ids.
 *
 * Every wait is a watch on a worker log with a deadline.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STORE_RELOCATED_FILE, STORE_VAULT_DIR } from "../../src/core/store/constants.ts";
import { defaultStoreRoot } from "../../src/core/store/store-paths.ts";
import {
  copyVault,
  logFinished,
  machine,
  migrationWorkerDone,
  recordIds,
  recordIdsUnder,
  REMOVE_SCRATCH_TIMEOUT_MS,
  removeScratch,
  runO2b,
  scratch,
  sessionStart,
  workerLog,
  type Machine,
} from "./fixtures/update-machine.ts";

// Two CLI runs, a hook and one worker; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(240_000);

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "legacy-v1.98-two-machines",
);
const DEVICE_A = "aaaa0001";
const DEVICE_B = "bbbb0002";

let parent: string | null = null;
afterEach(async () => {
  const done = parent;
  parent = null;
  await removeScratch(done);
}, REMOVE_SCRATCH_TIMEOUT_MS);

/** The 2.0.0 default store root of a machine: its per-user data folder. */
function externalStore(m: Machine): string {
  return defaultStoreRoot({ platform: process.platform, home: m.env["HOME"]!, env: m.env });
}

describe("a machine that switched on 2.0.0 with its store outside the vault", () => {
  test("moves only by the command; the other machine then joins the store", async () => {
    parent = scratch("osb-update-200-");
    const a = machine(parent, "a", FIXTURE, DEVICE_A);
    const b = machine(parent, "b", FIXTURE, DEVICE_B);
    const outside = externalStore(a);

    // 2.0.0 on A: the store at the per-user default, and A switched to it.
    const at200 = { OPEN_SECOND_BRAIN_STORE_ROOT: outside };
    expect((await runO2b(a, ["store", "init"], at200)).code).toBe(0);
    const migrated = await runO2b(a, ["brain", "migrate-store"], at200);
    expect(migrated.code).toBe(0);
    expect(recordIdsUnder(outside).length).toBeGreaterThan(0);

    // 1. A session start on 2.0.1 moves nothing and names the command.
    const context = await sessionStart(a, "record");
    expect(context).toContain("outside the vault");
    expect(context).toContain("o2b store move-into-vault");
    expect(existsSync(join(a.vault, STORE_VAULT_DIR))).toBe(false);
    expect(existsSync(join(outside, STORE_RELOCATED_FILE))).toBe(false);

    // 2. The command, with no session running: every record moves, as it is.
    const before = recordIdsUnder(outside);
    const moved = await runO2b(a, ["store", "move-into-vault"]);
    expect(moved.stderr).toBe("");
    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain("Moved the brain store into the vault in");
    expect(moved.stdout).toContain(`Recovery copy: ${outside}`);
    expect(existsSync(join(outside, STORE_RELOCATED_FILE))).toBe(true);
    expect(recordIds(a)).toEqual(before);

    // 3. The vault reaches B; B joins the store it carried.
    copyVault(a, b);
    await sessionStart(b, "run");
    const logB = await logFinished(workerLog(b), migrationWorkerDone);
    expect(logB).toContain("outcome applied");

    // 4. Copies both ways: one record set.
    copyVault(b, a);
    copyVault(a, b);
    const idsA = recordIds(a);
    expect(idsA.length).toBeGreaterThan(before.length);
    expect(recordIds(b)).toEqual(idsA);
  });
});

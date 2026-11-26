/**
 * Two machines updated from 1.x one after the other, sharing nothing but
 * the vault (release 2.0.1). Both ran Open Second Brain 1.98.0 on one vault
 * (`fixtures/legacy-v1.98-two-machines`, the files that release wrote on
 * machine A and machine B, carried between them by copy). No `store_root`
 * is set anywhere, and the only transport is a copy of the vault folder:
 *
 *  1. A's first session start migrates A into the store in the vault's
 *     `.open-second-brain-store/` folder and writes the view; the legacy
 *     tree stays, because B still writes it;
 *  2. the vault copies to B; B's first session start finds the store,
 *     joins it with its own records and, every device having switched,
 *     removes B's copy of the tree;
 *  3. both write, the vault copies back, and A's next start after the
 *     hourly retry removes A's copy of the tree too;
 *  4. both machines end with equal record sets, the view, no legacy tree
 *     and nothing in the per-user data folder.
 *
 * The hour is stood for by moving A's last attempt record back in time;
 * every wait is a watch on a worker log, or on the store for the end of
 * an index rebuild a start handed off, with a deadline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STORE_VAULT_DIR } from "../../src/core/store/constants.ts";
import { VIEW_DEFAULT_DIR } from "../../src/core/view/constants.ts";
import {
  ageRemovalAttempt,
  copyVault,
  dataFolderEntries,
  logFinished,
  machine,
  migrationWorkerDone,
  recordIds,
  removalLog,
  removalWorkerDone,
  REMOVE_SCRATCH_TIMEOUT_MS,
  removeScratch,
  scratch,
  selfHealsSettled,
  sessionStart,
  workerLog,
} from "./fixtures/update-machine.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "legacy-v1.98-two-machines",
);
/** The device ids the two 1.98.0 installs wrote their log shards under. */
const DEVICE_A = "aaaa0001";
const DEVICE_B = "bbbb0002";

let parent: string | null = null;
afterEach(async () => {
  const done = parent;
  parent = null;
  await removeScratch(done);
}, REMOVE_SCRATCH_TIMEOUT_MS);

describe("two machines updated from 1.98.0 by vault copy", () => {
  // Three session starts and their detached workers in sequence, all real
  // child processes; a slow runner needs more than the default (cli-timeout.ts).
  test(
    "both end on one store in the vault, with the view and no legacy tree",
    async () => {
      parent = scratch("osb-update-2x-");
      const a = machine(parent, "a", FIXTURE, DEVICE_A);
      const b = machine(parent, "b", FIXTURE, DEVICE_B);

      // 1. A updates first: migrated and viewed; the tree waits for B.
      await sessionStart(a, "run");
      const logA = await logFinished(workerLog(a), migrationWorkerDone);
      expect(logA).toContain("outcome applied");
      expect(logA).toContain("the automatic removal of the legacy tree: pending");
      expect(existsSync(join(a.vault, "Brain"))).toBe(true);
      expect(existsSync(join(a.vault, VIEW_DEFAULT_DIR, "about-me.md"))).toBe(true);

      // 2. The vault reaches B; B joins the store it carried and removes its tree.
      copyVault(a, b);
      await sessionStart(b, "run");
      const logB = await logFinished(workerLog(b), migrationWorkerDone);
      expect(logB).toContain("outcome applied");
      expect(logB).toContain("the automatic removal of the legacy tree: removed");
      expect(existsSync(join(b.vault, "Brain"))).toBe(false);

      // 3. Writes on both sides travel back; an hour later A's tree leaves.
      copyVault(b, a);
      ageRemovalAttempt(a, 61);
      const third = new Date();
      await sessionStart(a, "run");
      const removal = await logFinished(removalLog(a), removalWorkerDone);
      expect(removal).toContain("the automatic removal of the legacy tree: removed");
      // The start may also hand an index rebuild to a detached child, which
      // records its end in the store after the start returned: the last
      // copies wait for it, as a sync tool would carry that record later.
      await selfHealsSettled(a, third);
      copyVault(a, b);
      copyVault(b, a);

      // 4. The end state on both machines.
      for (const m of [a, b]) {
        expect(existsSync(join(m.vault, "Brain"))).toBe(false);
        expect(existsSync(join(m.vault, ".open-second-brain"))).toBe(false);
        expect(existsSync(join(m.vault, STORE_VAULT_DIR, "shared", "store.json"))).toBe(true);
        const aboutMe = readFileSync(join(m.vault, VIEW_DEFAULT_DIR, "about-me.md"), "utf8");
        expect(aboutMe).toContain("Use plain words.");
        expect(aboutMe).toContain("Write the test before the fix.");
        expect(dataFolderEntries(m)).toEqual([]);
      }
      expect(readFileSync(join(a.vault, "Notes", "mine.md"), "utf8")).toBe("# My note\n");
      const idsA = recordIds(a);
      expect(idsA.length).toBeGreaterThan(0);
      expect(recordIds(b)).toEqual(idsA);
    },
    240_000, // three sessions on two machines, each with its own detached worker
  );
});

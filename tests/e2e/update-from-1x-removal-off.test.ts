/**
 * An update from 1.x with the automatic removal turned off (release
 * 2.0.1): the vault written by Open Second Brain 1.98.0 meets one session
 * start of this release with `auto_legacy_removal: false`. The migration
 * and the view still run; the legacy tree stays in the vault. The same
 * update with the removal on is `update-from-1x-converts-brain.test.ts`;
 * the machine is `fixtures/update-machine.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VIEW_DEFAULT_DIR } from "../../src/core/view/constants.ts";
import {
  logFinished,
  migrationWorkerDone,
  REMOVE_SCRATCH_TIMEOUT_MS,
  removeScratch,
  sessionStart,
  v198Machine,
  workerExited,
  workerLog,
} from "./fixtures/update-machine.ts";

let parent: string | null = null;
afterEach(async () => {
  const done = parent;
  parent = null;
  await removeScratch(done);
}, REMOVE_SCRATCH_TIMEOUT_MS);

describe("an update from 1.98.0", () => {
  // One session start and its detached migration worker, both real child
  // processes; a slow runner needs more than the default (cli-timeout.ts).
  test(
    "with auto_legacy_removal off the brain migrates and the tree stays",
    async () => {
      const one = v198Machine("auto_legacy_removal: false\n");
      parent = one.parent;
      const m = one.machine;

      await sessionStart(m, "run");
      const log = await logFinished(workerLog(m), migrationWorkerDone);
      // The worker's last write is the release of its claim as it exits,
      // after the log's last line: the scratch must not go before it.
      await workerExited(m);
      expect(log).toContain("outcome applied");
      expect(log).not.toContain("the automatic removal of the legacy tree");

      expect(existsSync(join(m.vault, "Brain"))).toBe(true);
      expect(existsSync(join(m.vault, VIEW_DEFAULT_DIR, "about-me.md"))).toBe(true);
    },
    120_000, // one migration in a detached worker; each wait inside allows 90 s
  );
});

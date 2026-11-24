/**
 * An update from 1.x converts the brain by itself (release 2.0.1): a vault
 * written by Open Second Brain 1.98.0 (`fixtures/legacy-v1.98-vault`, the
 * files that release's own `o2b init`, `o2b brain init`, `o2b brain
 * feedback` and `o2b brain note` wrote, unchanged) meets one session start
 * of this release on a machine with no `store_root`, and with no manual
 * command:
 *
 *  1. the records move into the brain store, which takes its default place
 *     in the vault's hidden `.open-second-brain-store/` folder, and nothing
 *     is written to the per-user data folder;
 *  2. the legacy tree leaves the vault, since this machine is the whole
 *     cohort (`store-migration/auto-removal.ts`), and the removal leaves
 *     the store folder and the view folder alone;
 *  3. the human view is written into the vault's default view folder
 *     (`brain-view/`), with the confirmed rules on `about-me.md`;
 *  4. the person's own notes are untouched;
 *  5. the next session start says so in one line, and the one after it
 *     says nothing more.
 *
 * The same update with the removal turned off is
 * `update-from-1x-removal-off.test.ts`. The machine is
 * `fixtures/update-machine.ts`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { STORE_VAULT_DIR } from "../../src/core/store/constants.ts";
import { VIEW_DEFAULT_DIR } from "../../src/core/view/constants.ts";
import {
  dataFolderEntries,
  logFinished,
  migrationWorkerDone,
  recordIds,
  removeScratch,
  sessionStart,
  v198Machine,
  workerLog,
} from "./fixtures/update-machine.ts";

// One migration in a detached worker; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(120_000);

let parent: string | null = null;
afterEach(() => {
  removeScratch(parent);
  parent = null;
});

function oneMachine() {
  const m = v198Machine();
  parent = m.parent;
  return m.machine;
}

describe("an update from 1.98.0", () => {
  test("one session start migrates, removes the legacy tree and writes the view", async () => {
    const m = oneMachine();
    expect(existsSync(join(m.vault, "Brain", "_brain.yaml"))).toBe(true);

    await sessionStart(m, "run");
    const log = await logFinished(workerLog(m), migrationWorkerDone);
    expect(log).toContain("outcome applied");
    expect(log).toContain("the automatic removal of the legacy tree: removed");

    // Requirement 6: no machine file is left in the vault, the view is.
    expect(existsSync(join(m.vault, "Brain"))).toBe(false);
    expect(existsSync(join(m.vault, ".open-second-brain"))).toBe(false);
    const view = join(m.vault, VIEW_DEFAULT_DIR);
    const aboutMe = readFileSync(join(view, "about-me.md"), "utf8");
    expect(aboutMe).toContain("Use plain words.");
    expect(aboutMe).toContain("Write the test before the fix.");
    expect(existsSync(join(view, "decisions.md"))).toBe(true);
    expect(readFileSync(join(m.vault, "Notes", "mine.md"), "utf8")).toBe("# My note\n");
    // The store sits in the vault's hidden folder, and only there.
    expect(recordIds(m).length).toBeGreaterThan(0);
    expect(existsSync(join(m.vault, STORE_VAULT_DIR, "shared", "store.json"))).toBe(true);
    expect(dataFolderEntries(m)).toEqual([]);

    // The next start says it once, without the rollback advice.
    const next = await sessionStart(m, "record");
    expect(next).toContain(
      "moved this machine's brain into the brain store and the legacy Brain/ tree out of the vault",
    );
    expect(next).not.toContain("--rollback");
    const after = await sessionStart(m, "record");
    expect(after).not.toContain("Brain/ tree");
  });
});

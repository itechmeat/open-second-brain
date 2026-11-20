/**
 * What a removal of the legacy tree says it did, and the device-local
 * folder a second machine keeps after the removal on the first one synced
 * the tree away: the vault's sync never carried that machine's own search
 * index and caches, so the deletion did not reach them either.
 *
 *  - The report names what it deleted as rebuildable, with the size, and
 *    says everything else was moved; a long list is a count and its first
 *    few entries.
 *  - On the second machine the doctor names the leftover folder with its
 *    size and the command that clears it, and that command (the removal)
 *    clears it although the cohort no longer matters: the tree is gone.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { LEGACY_LOCAL_FILES_LEFT_CODE } from "../../../src/core/brain/doctor/migration-check.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { migrateStore, removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { removedLines, summariseList } from "../../../src/cli/brain/verbs/migrate-store-forms.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";
import { setSilenceDays } from "./fixtures/silence.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function retire(machine: Machine, device: string): void {
  appendRecord(machine.store(), {
    partition: "shared",
    stream: "settings",
    kind: "device-retire",
    agent: "t",
    body: { authority: "human", device },
  });
}

/** Two switched machines; dev-a removed the legacy tree, and the deletion reached dev-b by sync. */
function treeLeftOnBoth(): { a: Machine; b: Machine } {
  fleet = makeFleet(["dev-a", "dev-b"]);
  const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
  a.use();
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  fleet.syncVaultFile("dev-a", "dev-b", "Brain/vault-id.json");
  fleet.syncStore("dev-a", "dev-b");
  b.use();
  expect(migrateStore(b.vault, FAST).ok).toBe(true);
  fleet.syncStore("dev-b", "dev-a");
  a.use();
  retire(a, "dev-c");
  const removed = removeLegacy(a.vault);
  if (!removed.removed) throw new Error(`not removed on dev-a: ${removed.reason}`);
  fleet.syncStore("dev-a", "dev-b");
  // The sync deletes on dev-b what it carried: Brain/ and every synced
  // file of .open-second-brain/. What it never carried stays: this
  // machine's search index and its inject cache.
  rmSync(join(b.vault, "Brain"), { recursive: true, force: true });
  const local = join(b.vault, ".open-second-brain");
  for (const name of readdirSync(local))
    rmSync(join(local, name), { recursive: true, force: true });
  writeFileSync(join(local, "brain.sqlite"), Buffer.alloc(300_000, 1));
  mkdirSync(join(local, "inject-cache"), { recursive: true });
  writeFileSync(join(local, "inject-cache", "digest.json"), "{}\n");
  b.use();
  return { a, b };
}

describe("the report of a removal", () => {
  test("names what it deleted as rebuildable, with the size, and says the rest was moved", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    setSilenceDays(a, 0);
    const removed = removeLegacy(a.vault, { force: true });
    if (!removed.removed) throw new Error("not removed");

    expect(removed.skipped_sizes.map((s) => s.path).toSorted()).toEqual(
      [...removed.skipped].toSorted(),
    );
    expect(removed.skipped_bytes).toBe(removed.skipped_sizes.reduce((n, s) => n + s.bytes, 0));
    const text = removedLines(removed).join("\n");
    expect(text).not.toContain("nothing was deleted");
    expect(text).toContain(`Deleted ${removed.skipped.length} rebuildable file(s)`);
    expect(text).toContain(".open-second-brain/brain.sqlite (");
    expect(text).toContain("Everything else was moved into the archive, not deleted.");
  });

  test("a long list is its count and the first few entries", () => {
    const pages = Array.from({ length: 400 }, (_, i) => `Brain/log/day-${i}.md`);
    expect(summariseList(pages)).toBe(
      "Brain/log/day-0.md, Brain/log/day-1.md, Brain/log/day-2.md, Brain/log/day-3.md, " +
        "Brain/log/day-4.md and 395 more",
    );
    expect(summariseList(["a", "b"])).toBe("a, b");
  });
});

describe("a machine whose tree left by sync", () => {
  test("the doctor names the leftover device-local folder, its size and the command", () => {
    const { b } = treeLeftOnBoth();

    const found = (runDoctor(b.vault).uncertain ?? []).find(
      (u) => u.code === LEGACY_LOCAL_FILES_LEFT_CODE,
    );
    expect(found?.message).toContain(".open-second-brain/brain.sqlite (300 KB)");
    expect(found?.message).toContain(".open-second-brain/inject-cache");
    expect(found?.message).toContain("o2b brain migrate-store --remove-legacy");
    // A caller below local reach gets the count and the size, no names.
    const withheld = (runDoctor(b.vault, { withholdsPrivate: true }).uncertain ?? []).find(
      (u) => u.code === LEGACY_LOCAL_FILES_LEFT_CODE,
    );
    expect(withheld?.message).toContain("2 entries");
    expect(withheld?.message).not.toContain("brain.sqlite");
    expect(withheld?.message).not.toContain("inject-cache");
    expect(withheld?.path).toBeUndefined();
    // Advice only: nothing was removed by the doctor.
    expect(existsSync(join(b.vault, ".open-second-brain", "brain.sqlite"))).toBe(true);
  });

  test("the removal clears it, the cohort notwithstanding, and the doctor is silent after", () => {
    const { b } = treeLeftOnBoth();
    // A cohort device still pending would keep a tree in place; this vault
    // has none left to keep.
    setSilenceDays(b, 0);

    const removed = removeLegacy(b.vault);
    if (!removed.removed) throw new Error(`not removed on dev-b: ${removed.reason}`);
    expect(removed.tree_already_left).toBe(true);
    expect(removed.moved).toEqual([".open-second-brain"]);
    expect(removed.skipped).toContain(".open-second-brain/brain.sqlite");
    expect(existsSync(join(b.vault, ".open-second-brain"))).toBe(false);
    expect(removedLines(removed)[0]).toContain("The legacy tree had already left the vault");
    // The cohort as it stands, on this machine too: both switched, the
    // one retired by hand named as such (it used to read "switched: dev-a").
    const text = removedLines(removed).join("\n");
    expect(text).toContain("switched: dev-a, dev-b");
    expect(text).toContain("retired by hand: dev-c");
    expect((runDoctor(b.vault).uncertain ?? []).map((u) => u.code)).not.toContain(
      LEGACY_LOCAL_FILES_LEFT_CODE,
    );
  });
});

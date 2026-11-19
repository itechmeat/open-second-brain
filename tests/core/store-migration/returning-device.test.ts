/**
 * A device retired by silence that comes back (change
 * stale-device-retirement, design D8), in every form, without silent loss:
 *
 *  a. on an old release, after the removal: it writes `Brain/` again; the
 *     doctor names it as retired by silence and says what to do, and the
 *     switched machine still imports what it writes there;
 *  b. on the new release with its local copy of the tree: its migration as
 *     a later machine imports the records it wrote offline;
 *  b. on the new release with its tree gone: it is store-only by the
 *     no-legacy-tree rule, and the start records no switch for it (a vault
 *     with no tree carries no identity to match a removal record to).
 *
 * (c, pending again at once while the tree is in the vault, is in
 * cohort-status.test.ts, cohort-doctor.test.ts and removal-silence.test.ts.)
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { ensureVaultCurrent } from "../../../src/core/maintenance/ensure-current.ts";
import { recordFreshInstallSwitch } from "../../../src/core/store/fresh-switch.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { LEGACY_TREE_REAPPEARED_CODE } from "../../../src/core/brain/doctor/migration-check.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { isDeviceSwitched } from "../../../src/core/store-migration/migration-records.ts";
import { migrateStore, removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";
import { setSilenceDays } from "./fixtures/silence.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here run full migrations and the doctor, seconds each on a loaded
// machine; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
// This machine's clock, frozen while each test runs: every store record the
// test writes carries it, so it is the newest evidence and the reference.
const NOW = new Date("2026-11-19T00:00:00Z");
beforeEach(() => {
  setSystemTime(NOW);
});
const OFFLINE_LOG = "Brain/log/2026-11-18.dev-c.jsonl";
const OFFLINE_ROW = JSON.stringify({
  ts: "2026-11-18T09:00:00Z",
  kind: "note",
  payload: { text: "written offline" },
  prev: null,
  h: "0".repeat(64),
});
/** The imported record's legacy item: the shard's first line. */
const OFFLINE_KEY = `${OFFLINE_LOG}#1`;

let fleet: Fleet | null = null;
afterEach(() => {
  setSystemTime();
  fleet?.cleanup();
  fleet = null;
});

/** dev-a migrated and removed the tree with dev-b and dev-c retired by silence; returns its archive. */
function removedWithSilence(names: ReadonlyArray<string>): { a: Machine; archive: string } {
  fleet = makeFleet(names);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  setSilenceDays(a, 10);
  const removed = removeLegacy(a.vault, { now: NOW });
  if (!removed.removed) throw new Error(`not removed: ${removed.reason}`);
  expect(removed.retired_by_silence.map((d) => d.device)).toEqual(["dev-b", "dev-c"]);
  return { a, archive: removed.archive };
}

describe("a device retired by silence comes back on an old release", () => {
  test("the doctor names it as retired by silence and says what to do; its writes are imported", () => {
    const { a } = removedWithSilence(["dev-a"]);
    // dev-c, still on an old release, writes the legacy layout and sync delivers it.
    a.write(OFFLINE_LOG, `${OFFLINE_ROW}\n`);
    const back = runDoctor(a.vault, { now: NOW }).warnings.find(
      (w) => w.code === LEGACY_TREE_REAPPEARED_CODE,
    );
    expect(back?.message).toContain("dev-c");
    expect(back?.message).toContain("retired by silence");
    expect(back?.message).toContain("update Open Second Brain on that machine");
    expect(back?.message).toContain("as a later machine");
    expect(back?.message).toContain("`o2b brain migrate-store --remove-legacy`");
    // The switched machine still imports what it writes there: nothing is lost.
    expect(migrateStore(a.vault, FAST).ok).toBe(true);
    expect(a.byKey().has(OFFLINE_KEY)).toBe(true);
  });
});

describe("a device retired by silence comes back on the new release", () => {
  test("with its local copy of the tree, its migration imports what it wrote offline", () => {
    const { a, archive } = removedWithSilence(["dev-a", "dev-c"]);
    const c = fleet!.machine("dev-c");
    // The vault identity reached dev-c before it went offline.
    cpSync(join(archive, "Brain", "vault-id.json"), join(c.vault, "Brain", "vault-id.json"));
    c.write(OFFLINE_LOG, `${OFFLINE_ROW}\n`);
    fleet!.syncStore("dev-a", "dev-c");
    c.use();
    const outcome = migrateStore(c.vault, FAST);
    expect(outcome.ok).toBe(true);
    expect(isDeviceSwitched(c.store(), "dev-c")).toBe(true);
    expect(c.byKey().has(OFFLINE_KEY)).toBe(true);
    // And it reaches dev-a with the store.
    fleet!.syncStore("dev-c", "dev-a");
    a.use();
    expect(a.byKey().has(OFFLINE_KEY)).toBe(true);
  });

  test("a vault with no tree is never taken for the removed one: the start records no switch", async () => {
    removedWithSilence(["dev-a", "dev-c"]);
    const c = fleet!.machine("dev-c");
    // One store serves every vault of a machine. dev-c's vault holds no
    // tree and no identity marker: the removed vault after the sync tool
    // applied the removal, or another vault whose tree has not arrived yet.
    rmSync(join(c.vault, "Brain"), { recursive: true, force: true });
    rmSync(join(c.vault, ".open-second-brain"), { recursive: true, force: true });
    fleet!.syncStore("dev-a", "dev-c");
    c.use();
    await ensureVaultCurrent(c.vault, { background: false });
    expect(isDeviceSwitched(c.store(), "dev-c")).toBe(false);
    expect(existsSync(join(c.vault, "Brain"))).toBe(false);
    // It still writes the store only, by the no-legacy-tree rule.
    expect(storeOnlyMode({ vault: c.vault }).reason).toBe("no-legacy-tree");
    // `o2b store init` on that machine records its switch, on the owner's word.
    expect(recordFreshInstallSwitch({ vault: c.vault })).toBe("recorded");
    expect(isDeviceSwitched(c.store(), "dev-c")).toBe(true);
  });
});

/**
 * The switch of a fresh install (design D14 item 1): with no legacy tree
 * and a store, `o2b init` records this device's `device-switched`, so a
 * `Brain/` an older writer creates later cannot flip the machine back. The
 * switch is read from this device's own `device-switched` only; a
 * `migration-done` alone does not switch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { recordFreshInstallSwitch } from "../../../src/core/store/fresh-switch.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";
import { storeOnlyModeInFreshProcess } from "../../helpers/fresh-process.ts";
import { neverHeld } from "../../helpers/held-partitions.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function switchRecords(e: StoreEnv): string[] {
  return readPartition(join(e.storeRoot, "shared"))
    .flatMap((shard) => shard.records)
    .filter((r) => r.kind === "device-switched")
    .map((r) => r.body["device"] as string);
}

describe("recordFreshInstallSwitch", () => {
  test("records the switch once; a Brain/ created later leaves the machine store-only", () => {
    env = makeStoreEnv("osb-fresh-switch-", { legacyTree: false });
    expect(recordFreshInstallSwitch({ vault: env.vault })).toBe("recorded");
    expect(recordFreshInstallSwitch({ vault: env.vault })).toBe("already-switched");
    expect(switchRecords(env)).toEqual(["dev-a"]);
    mkdirSync(join(env.vault, "Brain"), { recursive: true });
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({
      storeOnly: true,
      reason: "device-switched",
    });
    // A later process, which never saw the switch, reads it from the record.
    expect(storeOnlyModeInFreshProcess(env.vault)).toEqual({
      storeOnly: true,
      reason: "device-switched",
    });
  });

  test("a switched machine whose store partitions are gone stays store-only", () => {
    env = makeStoreEnv("osb-fresh-switch-", { legacyTree: false });
    expect(recordFreshInstallSwitch({ vault: env.vault })).toBe("recorded");
    mkdirSync(join(env.vault, "Brain"), { recursive: true });
    expect(storeOnlyMode({ vault: env.vault }).storeOnly).toBe(true);
    // Sync removed the partitions (or has not delivered them yet).
    rmSync(join(env.storeRoot, "shared"), { recursive: true, force: true });
    neverHeld(env.storeRoot);
    expect(storeOnlyModeInFreshProcess(env.vault).storeOnly).toBe(true);
  });

  test("a machine with a legacy tree switches through the migration, not here", () => {
    env = makeStoreEnv("osb-fresh-switch-");
    mkdirSync(join(env.vault, "Brain", "inbox"), { recursive: true });
    writeFileSync(join(env.vault, "Brain", "inbox", "2026-11-01-a.md"), "---\nid: sig-a\n---\n");
    expect(recordFreshInstallSwitch({ vault: env.vault })).toBe("legacy-tree");
    expect(switchRecords(env)).toEqual([]);
  });

  test("a Brain/ of only what bootstrap writes is a fresh install and switches here", () => {
    // The default fixture tree is exactly a bootstrap's.
    env = makeStoreEnv("osb-fresh-switch-");
    expect(recordFreshInstallSwitch({ vault: env.vault })).toBe("recorded");
    expect(switchRecords(env)).toEqual(["dev-a"]);
  });

  test("no store or no device id records nothing", () => {
    env = makeStoreEnv("osb-fresh-switch-", { legacyTree: false, partitions: [] });
    expect(recordFreshInstallSwitch({ vault: env.vault })).toBe("no-store");
    process.env["O2B_DEVICE_ID"] = "";
    expect(recordFreshInstallSwitch({ vault: env.vault })).toBe("no-device");
  });
});

describe("the switch reader", () => {
  test("a migration-done of this device alone does not switch it", () => {
    env = makeStoreEnv("osb-fresh-switch-");
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: "migration-done",
      agent: "o2b",
      body: { authority: "human", vault_id: null, device: "dev-a", cuts: {}, imported: 0 },
    });
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({ storeOnly: false });
  });
});

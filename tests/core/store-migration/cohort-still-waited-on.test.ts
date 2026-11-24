/**
 * Who the legacy-tree removal still waits for (patch 2.0.1, review round
 * 4): one rule (`deviceStillWaitedOn`) answers it for the wait for a
 * device's switch record, for the shards its cut names and for its missing
 * cut, and a switch record answers a migration mark only when it is not
 * older than the mark.
 *
 *  - a device that rolled back and migrated again is waited on while only
 *    its rollback, older than its new mark, has arrived;
 *  - a device a person retired is waited on by none of the waits, the cut
 *    shards included, and by all of them again once it writes after it;
 *  - a retired device that switched without a cut and came back records
 *    its cut itself;
 *  - a device's check for its own cut stays open while it lacks `shared`.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AUTO_LEGACY_REMOVAL_ENV } from "../../../src/core/config.ts";
import { appendRecord, type AppendInput } from "../../../src/core/store/appender.ts";
import { STORE_ROOT_ENV, STORE_VAULT_DIR } from "../../../src/core/store/constants.ts";
import { retireDevice } from "../../../src/core/store/device-roster.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  runAutoStoreMigration,
} from "../../../src/core/store-migration/auto-worker.ts";
import {
  runAutoLegacyRemoval,
  shouldStartAutoLegacyRemoval,
} from "../../../src/core/store-migration/auto-removal.ts";
import { cohortRecordsInFlight } from "../../../src/core/store-migration/cohort-in-flight.ts";
import * as migrationRecords from "../../../src/core/store-migration/migration-records.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeVaultFleet, type VaultFleet, type VaultMachine } from "./fixtures/vault-fleet.ts";

// Whole migrations run here; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HOUR_MS = 3_600_000;

let fleet: VaultFleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function start(m: VaultMachine): void {
  m.use();
  expect(runAutoStoreMigration(m.vault, { settleMs: 0 }).outcome).toBe(
    AUTO_MIGRATION_OUTCOME.applied,
  );
}

function inFlight(m: VaultMachine): ReturnType<typeof cohortRecordsInFlight> {
  m.use();
  return cohortRecordsInFlight(m.vault, openStore({ root: m.vaultStore, device: m.name }), m.name);
}

/** Store files of `device` other than its settings shard: not delivered yet. */
function storeButSettingsOf(device: string): (rel: string) => boolean {
  return (rel) =>
    rel.startsWith(`${STORE_VAULT_DIR}/`) &&
    rel.split("/").at(-2) === device &&
    !rel.includes("/settings/");
}

/** A record `writer` writes into the store at `on`'s vault folder, stamped by `clock`. */
function writeAs(
  on: VaultMachine,
  writer: string,
  input: Pick<AppendInput, "stream" | "kind" | "body">,
  clock: number,
): void {
  on.use();
  appendRecord(
    openStore({ root: on.vaultStore, device: writer }),
    { partition: "shared", agent: "@t", ...input },
    { now: () => clock },
  );
}

/** A note `writer` writes, stamped by `clock`: any record of it after a retirement brings it back. */
function noteAs(on: VaultMachine, writer: string, clock: number): void {
  writeAs(
    on,
    writer,
    { stream: "events", kind: "log-event", body: { event_type: "note", text: "back" } },
    clock,
  );
}

function retire(on: VaultMachine, device: string): void {
  on.use();
  retireDevice(openStore({ root: on.vaultStore, device: on.name }), {
    device,
    agent: "@t",
    vault: on.vault,
  });
}

/** Append a migration mark of `device`, written at `at`, to its newest legacy log shard on `on`. */
function markInLog(on: VaultMachine, device: string, at: number): void {
  const dir = join(on.vault, "Brain", "log");
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith(`.${device}.jsonl`))
    .toSorted()
    .at(-1);
  if (newest === undefined) throw new Error(`no log shard of ${device} on ${on.name}`);
  const line = {
    ts: new Date(at).toISOString(),
    kind: "snapshot",
    payload: { run_id: `store-migration-again-${device}`, reason: "store-migration" },
  };
  appendFileSync(join(dir, newest), `${JSON.stringify(line)}\n`);
}

/** A switched, then B as a later machine; everything of B reaches A but `skip`. */
function twoSwitched(skip?: (rel: string) => boolean): [VaultMachine, VaultMachine, VaultFleet] {
  const made = makeVaultFleet(["dev-a", "dev-b"]);
  fleet = made;
  const [a, b] = [made.machine("dev-a"), made.machine("dev-b")];
  start(a);
  made.syncVault("dev-a", "dev-b");
  start(b);
  made.syncVault("dev-b", "dev-a", skip === undefined ? {} : { skip });
  return [a, b, made];
}

/** {@link twoSwitched}, with B's switch record carrying no cut (a release before 2.0.1). */
function uncutLaterDevice(): [VaultMachine, VaultMachine, VaultFleet] {
  const made = makeVaultFleet(["dev-a", "dev-b"]);
  fleet = made;
  const [a, b] = [made.machine("dev-a"), made.machine("dev-b")];
  start(a);
  made.syncVault("dev-a", "dev-b");
  const real = migrationRecords.deviceSwitchedBody;
  const spy = spyOn(migrationRecords, "deviceSwitchedBody").mockImplementation((vaultId, device) =>
    real(vaultId, device),
  );
  try {
    start(b);
  } finally {
    spy.mockRestore();
  }
  made.syncVault("dev-b", "dev-a", { skip: storeButSettingsOf("dev-b") });
  return [a, b, made];
}

function ownCuts(m: VaultMachine): number {
  m.use();
  return migrationRecords
    .switchRecordsWithCuts(openStore({ root: m.vaultStore, device: m.name }))
    .filter((r) => r.device === m.name).length;
}

describe("a device that rolled back and migrated again", () => {
  test("is waited on while only its rollback, older than its new mark, has arrived", () => {
    const [a, b, sync] = twoSwitched();
    expect(inFlight(a).reasons).toEqual([]);
    // B rolls back, ten minutes on its own clock after everything so far.
    const rollback = Date.now() + 10 * 60_000;
    writeAs(
      b,
      "dev-b",
      {
        stream: migrationRecords.MIGRATION_STREAM,
        kind: migrationRecords.DEVICE_UNSWITCHED_KIND,
        body: migrationRecords.deviceSwitchedBody(null, "dev-b"),
      },
      rollback,
    );
    sync.syncVault("dev-b", "dev-a");
    // On the legacy layout again: its old mark is older than its rollback.
    expect(inFlight(a).reasons).toEqual([]);
    // B migrates again a minute later: the new mark reaches A, its store does not.
    markInLog(b, "dev-b", rollback + 60_000);
    sync.syncVault("dev-b", "dev-a", { dropHidden: true });
    const held = inFlight(a);
    expect(held.devices).toEqual(["dev-b"]);
    expect(held.reasons.join(" ")).toContain("its switch record has not arrived");
  });
});

describe("a retired device whose switch record arrived and one shard of its cut did not", () => {
  test("is not waited on, and is waited on again once it writes after the retirement", () => {
    const [a] = twoSwitched(storeButSettingsOf("dev-b"));
    const held = inFlight(a);
    expect(held.devices).toEqual(["dev-b"]);
    expect(held.reasons.join(" ")).toContain("of the migration of device dev-b have not arrived");
    retire(a, "dev-b");
    expect(inFlight(a).reasons).toEqual([]);
    noteAs(a, "dev-b", Date.now() + HOUR_MS);
    expect(inFlight(a).devices).toEqual(["dev-b"]);
  });
});

describe("a device that switched without a cut, was retired and came back", () => {
  test("is waited on for its cut again, and records the cut itself", () => {
    const [a, b, sync] = uncutLaterDevice();
    retire(a, "dev-b");
    expect(inFlight(a).reasons).toEqual([]);
    // The retirement reaches B, which runs and writes after it.
    sync.syncVault("dev-a", "dev-b");
    const back = Date.now() + HOUR_MS;
    noteAs(b, "dev-b", back);
    // Every record of B arrives; what its migration wrote is still not named.
    sync.syncVault("dev-b", "dev-a");
    const held = inFlight(a);
    expect(held.devices).toEqual(["dev-b"]);
    expect(held.reasons.join(" ")).toContain("2.0.1");
    // B's own check records the cut it owes, and A stops waiting once it arrives.
    b.use();
    runAutoLegacyRemoval(b.vault, { now: new Date(back + 60_000) });
    expect(ownCuts(b)).toBe(1);
    sync.syncVault("dev-b", "dev-a");
    expect(inFlight(a).reasons).toEqual([]);
  });
});

describe("a device's check for its own cut", () => {
  test("stays open while this machine does not hold the shared partition", () => {
    const [, b] = uncutLaterDevice();
    b.use();
    // A store root of B's that holds only `private/` so far: sync has not
    // delivered `shared/`, and this root never held it.
    const root = join(b.home, "store-root");
    mkdirSync(root, { recursive: true });
    cpSync(join(b.vaultStore, "private"), join(root, "private"), { recursive: true });
    const saved = {
      removal: process.env[AUTO_LEGACY_REMOVAL_ENV],
      root: process.env[STORE_ROOT_ENV],
    };
    process.env[AUTO_LEGACY_REMOVAL_ENV] = "false";
    process.env[STORE_ROOT_ENV] = root;
    try {
      const now = Date.now();
      expect(shouldStartAutoLegacyRemoval(b.vault, undefined, new Date(now))).toBe(true);
      expect(runAutoLegacyRemoval(b.vault, { now: new Date(now) })).toBeNull();
      // Asked again at the hourly retry, not ended.
      expect(shouldStartAutoLegacyRemoval(b.vault, undefined, new Date(now + 2 * HOUR_MS))).toBe(
        true,
      );
      // `shared/` arrives: the next check records the cut, and ends.
      cpSync(join(b.vaultStore, "shared"), join(root, "shared"), { recursive: true });
      expect(runAutoLegacyRemoval(b.vault, { now: new Date(now + 2 * HOUR_MS) })).toBeNull();
      expect(
        migrationRecords
          .switchRecordsWithCuts(openStore({ root, device: "dev-b" }))
          .filter((r) => r.device === "dev-b"),
      ).toHaveLength(1);
      expect(shouldStartAutoLegacyRemoval(b.vault, undefined, new Date(now + 4 * HOUR_MS))).toBe(
        false,
      );
    } finally {
      for (const [key, value] of [
        [AUTO_LEGACY_REMOVAL_ENV, saved.removal],
        [STORE_ROOT_ENV, saved.root],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

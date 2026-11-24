/**
 * What lets two machines that share only their vault agree (patch 2.0.1):
 *
 *  - the store id, when one machine has not received the oldest legacy
 *    log shard yet but both hold the vault's identity marker;
 *  - the store id and the identity marker of a vault that had none, when
 *    an older log shard arrives after the store was created;
 *  - whether a device's migration records have arrived before the legacy
 *    tree leaves: a first machine whose run was resumed after its
 *    `migration-done`, and a later device that switched on a release that
 *    recorded no cut, are waited on until what they wrote has arrived; a
 *    device that completed, rolled back and switched again without a cut
 *    is waited on too; a device whose switch record never arrived is
 *    released by a person's retirement, and waited on again once it writes;
 *  - the cut such a device publishes, whatever its own removal setting.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ensureBrainStore } from "../../../src/core/brain/init-store.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { readVaultIdentity, writeVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { legacyLogSeed } from "../../../src/core/brain/vault-seed.ts";
import { AUTO_LEGACY_REMOVAL_ENV } from "../../../src/core/config.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { ulidFromSeed } from "../../../src/core/store/ulid.ts";
import { STORE_VAULT_DIR } from "../../../src/core/store/constants.ts";
import { retireDevice } from "../../../src/core/store/device-roster.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { inspectStore, openStore } from "../../../src/core/store/store-open.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  runAutoStoreMigration,
} from "../../../src/core/store-migration/auto-worker.ts";
import {
  runAutoLegacyRemoval,
  shouldStartAutoLegacyRemoval,
} from "../../../src/core/store-migration/auto-removal.ts";
import { cohortRecordsInFlight } from "../../../src/core/store-migration/cohort-in-flight.ts";
import { MIGRATION_STEP } from "../../../src/core/store-migration/migrate.ts";
import * as migrationRecords from "../../../src/core/store-migration/migration-records.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeVaultFleet, type VaultFleet, type VaultMachine } from "./fixtures/vault-fleet.ts";

// Whole migrations run here; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fleet: VaultFleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function start(m: VaultMachine, stopAt?: string): ReturnType<typeof runAutoStoreMigration> {
  m.use();
  return runAutoStoreMigration(m.vault, {
    settleMs: 0,
    ...(stopAt === undefined
      ? {}
      : {
          hooks: {
            atStep: (step: string) => {
              if (step === stopAt) throw new Error(`stopped at ${step}`);
            },
          },
        }),
  });
}

function inFlight(m: VaultMachine): ReturnType<typeof cohortRecordsInFlight> {
  m.use();
  const store = openStore({ root: m.vaultStore, device: m.name });
  return cohortRecordsInFlight(m.vault, store, m.name);
}

/** Store files of `device` other than its settings shard: not delivered yet. */
function storeButSettingsOf(device: string): (rel: string) => boolean {
  return (rel) =>
    rel.startsWith(`${STORE_VAULT_DIR}/`) &&
    rel.split("/").at(-2) === device &&
    !rel.includes("/settings/");
}

/** The vault-relative path of the store shard holding a record whose line contains `text`. */
function shardHolding(m: VaultMachine, text: string): string {
  for (const partition of ["shared", "private"] as const) {
    for (const shard of readPartition(join(m.vaultStore, partition))) {
      if (shard.all.some((r) => JSON.stringify(r).includes(text))) {
        return `${STORE_VAULT_DIR}/${partition}/${shard.rel}`;
      }
    }
  }
  throw new Error(`no store record contains ${text}`);
}

describe("the store id two machines create before they see each other's", () => {
  test("is one id when one of them lacks the oldest log shard and both hold the marker", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    // B's sync has not delivered the oldest day of the log yet.
    rmSync(join(b.vault, "Brain", "log", "2026-10-01.jsonl"));
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(inspectStore(b.vaultStore)!.storeId).toBe(inspectStore(a.vaultStore)!.storeId);
  });
});

describe("a store created in the vault before the vault had an identity marker", () => {
  test("pins the marker it took its id from: an older log shard arriving later changes neither", () => {
    fleet = makeVaultFleet(["dev-a"], { identityMarker: false });
    const a = fleet.machine("dev-a");
    a.use();
    // The oldest day of the log has not arrived yet when the store is made.
    const oldest = join(a.vault, "Brain", "log", "2026-10-01.jsonl");
    const aside = join(a.home, "oldest.jsonl");
    renameSync(oldest, aside);
    const created = ensureBrainStore();
    expect(created.status).toBe("created");
    // The marker was minted before the store, and the id derives from it.
    const pinned = readVaultIdentity(a.vault)!.vault_id;
    expect(created.storeId).toBe(ulidFromSeed(pinned));
    // The oldest shard arrives; every later marker writer keeps the marker.
    renameSync(aside, oldest);
    writeVaultIdentity(a.vault, { seed: legacyLogSeed(a.vault) });
    expect(readVaultIdentity(a.vault)!.vault_id).toBe(pinned);
    // A peer that receives the marker before the store derives the same id.
    expect(ulidFromSeed(readVaultIdentity(a.vault)!.vault_id)).toBe(
      inspectStore(a.vaultStore)!.storeId,
    );
  });
});

describe("a first machine whose run resumed after its migration-done", () => {
  test("is waited on until what it imported after that record has arrived", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    expect(start(a, MIGRATION_STEP.migrationDone).outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    // B, still on the legacy layout, writes; sync brings it to A, and A's store to B.
    b.use();
    writeSignal(b.vault, {
      topic: "late-b",
      signal: "positive",
      agent: "@t",
      principle: "Written on dev-b after dev-a recorded its completion",
      created_at: "2026-11-24T10:00:00Z",
      date: "2026-11-24",
      slug: "late-b",
    });
    fleet.syncVault("dev-b", "dev-a");
    fleet.syncVault("dev-a", "dev-b");
    // A resumes: it imports B's item after its kept migration-done, and switches.
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    const late = shardHolding(a, "late-b");
    // Only A's switch record reaches B, not the shard with that import.
    fleet.syncVault("dev-a", "dev-b", {
      skip: (rel) => rel.startsWith(`${STORE_VAULT_DIR}/`) && !rel.includes("/settings/dev-a/"),
    });
    expect(readFileSync(join(b.vault, ...late.split("/")), "utf8")).not.toContain("late-b");
    const held = inFlight(b);
    expect(held.devices).toEqual(["dev-a"]);
    expect(held.reasons.join(" ")).toContain("of the migration of device dev-a have not arrived");
    fleet.syncVault("dev-a", "dev-b");
    expect(inFlight(b).reasons).toEqual([]);
  });
});

/**
 * A switched first, then B as a later machine of a release before 2.0.1
 * (its switch record carries no cut), and B's switch record on A before
 * the other records B's migration wrote.
 */
function uncutLaterDevice(): [VaultMachine, VaultMachine, VaultFleet] {
  const made = makeVaultFleet(["dev-a", "dev-b"]);
  fleet = made;
  const [a, b] = [made.machine("dev-a"), made.machine("dev-b")];
  expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
  made.syncVault("dev-a", "dev-b");
  const real = migrationRecords.deviceSwitchedBody;
  const spy = spyOn(migrationRecords, "deviceSwitchedBody").mockImplementation((vaultId, device) =>
    real(vaultId, device),
  );
  try {
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
  } finally {
    spy.mockRestore();
  }
  made.syncVault("dev-b", "dev-a", { skip: storeButSettingsOf("dev-b") });
  return [a, b, made];
}

describe("a later device that switched on a release that recorded no cut", () => {
  test("is waited on until it records its cut, then until that cut has arrived", () => {
    const [a, b, sync] = uncutLaterDevice();
    const before = inFlight(a);
    expect(before.devices).toEqual(["dev-b"]);
    expect(before.reasons.join(" ")).toContain("2.0.1");

    // B on this release records its cut at its next removal attempt, once.
    b.use();
    runAutoLegacyRemoval(b.vault, { now: new Date() });
    runAutoLegacyRemoval(b.vault, { now: new Date(Date.now() + 2 * 3_600_000) });
    b.use();
    const own = migrationRecords
      .switchRecordsWithCuts(openStore({ root: b.vaultStore, device: "dev-b" }))
      .filter((r) => r.device === "dev-b");
    expect(own).toHaveLength(1);

    sync.syncVault("dev-b", "dev-a", { skip: storeButSettingsOf("dev-b") });
    const cut = inFlight(a);
    expect(cut.devices).toEqual(["dev-b"]);
    expect(cut.reasons.join(" ")).toContain("of the migration of device dev-b have not arrived");
    sync.syncVault("dev-b", "dev-a");
    expect(inFlight(a).reasons).toEqual([]);
  });

  test("is no longer waited on once a person retires it as gone for good", () => {
    const [a] = uncutLaterDevice();
    expect(inFlight(a).devices).toEqual(["dev-b"]);
    a.use();
    retireDevice(openStore({ root: a.vaultStore, device: "dev-a" }), {
      device: "dev-b",
      agent: "@t",
      vault: a.vault,
    });
    expect(inFlight(a).reasons).toEqual([]);
  });
});

describe("a device that completed its migration, rolled back and switched again", () => {
  test("is waited on: its old completion says nothing of the switch after the rollback", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const b = fleet.machine("dev-b");
    // B is the first machine: its migration-done record stands.
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    b.use();
    const store = openStore({ root: b.vaultStore, device: "dev-b" });
    expect(migrationRecords.devicesSwitchedWithoutCut(store).has("dev-b")).toBe(false);
    const body = migrationRecords.deviceSwitchedBody(null, "dev-b");
    const record = (kind: string): void => {
      appendRecord(store, {
        partition: "shared",
        stream: migrationRecords.MIGRATION_STREAM,
        kind,
        agent: "@t",
        body,
      });
    };
    // A rollback, then a switch of a release that recorded no cut.
    record(migrationRecords.DEVICE_UNSWITCHED_KIND);
    record(migrationRecords.DEVICE_SWITCHED_KIND);
    expect(migrationRecords.devicesSwitchedWithoutCut(store).has("dev-b")).toBe(true);
  });
});

describe("a device whose migration mark arrived and whose store never did", () => {
  test("is released by a person's retirement, and waited on again once it writes after it", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    fleet.syncVault("dev-a", "dev-b");
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // Only the legacy log, with B's mark, reaches A; none of B's store does.
    fleet.syncVault("dev-b", "dev-a", { dropHidden: true });
    const held = inFlight(a);
    expect(held.devices).toEqual(["dev-b"]);
    expect(held.reasons.join(" ")).toContain("o2b store move-into-vault");
    a.use();
    const here = openStore({ root: a.vaultStore, device: "dev-a" });
    retireDevice(here, { device: "dev-b", agent: "@t", vault: a.vault });
    expect(inFlight(a).reasons).toEqual([]);
    // A record of B's written after the retirement arrives: B is back.
    a.use();
    appendRecord(openStore({ root: a.vaultStore, device: "dev-b" }), {
      partition: "shared",
      stream: "events",
      agent: "@t",
      kind: "log-event",
      body: { event_type: "note", text: "back" },
    });
    expect(inFlight(a).devices).toEqual(["dev-b"]);
  });
});

describe("the cut a later device of a release that recorded none publishes", () => {
  test("is published though that device's own removal is off", () => {
    const [, b] = uncutLaterDevice();
    b.use();
    const saved = process.env[AUTO_LEGACY_REMOVAL_ENV];
    process.env[AUTO_LEGACY_REMOVAL_ENV] = "false";
    try {
      const now = new Date();
      // A start asks for a worker: the cut, not the removal.
      expect(shouldStartAutoLegacyRemoval(b.vault, undefined, now)).toBe(true);
      expect(runAutoLegacyRemoval(b.vault, { now })).toBeNull();
      b.use();
      const own = migrationRecords
        .switchRecordsWithCuts(openStore({ root: b.vaultStore, device: "dev-b" }))
        .filter((r) => r.device === "dev-b");
      expect(own).toHaveLength(1);
      // Asked once: the removal itself stays off and the tree stays.
      expect(
        shouldStartAutoLegacyRemoval(b.vault, undefined, new Date(now.getTime() + 7_200_000)),
      ).toBe(false);
      expect(existsSync(join(b.vault, "Brain"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[AUTO_LEGACY_REMOVAL_ENV];
      else process.env[AUTO_LEGACY_REMOVAL_ENV] = saved;
    }
  });
});

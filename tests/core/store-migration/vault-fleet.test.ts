/**
 * The brain store travels with the vault (patch 2.0.1): two machines that
 * exchange ONLY their vault folder, by a plain file copy, never the store
 * on its own. Covered:
 *
 *  - both on the legacy layout, A then B update: A creates the store in
 *    the vault's reserved folder, B finds it there and joins it;
 *  - the owner's state: A already switched on 2.0.0 with its store at the
 *    per-user default outside the vault, B still legacy and waiting: A's
 *    starts move nothing and say so once a day; `o2b store move-into-vault`
 *    on A moves the store into the vault, B joins it;
 *  - writes in both directions end in equal folds on both machines;
 *  - a transport that drops hidden folders ends in the plain waiting
 *    message (session notice once a day, status, doctor), not divergence;
 *  - concurrent first starts make one store, not two;
 *  - device-local state never lands in the vault folder.
 *
 * The crash at every relocation boundary is `store-relocation.test.ts`;
 * the command's refusals are `move-into-vault.test.ts`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { writeSignal } from "../../../src/core/brain/signal.ts";
import { collectRuntimeNotices } from "../../../src/core/brain/runtime-notices.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { STORE_RELOCATED_FILE, STORE_VAULT_DIR } from "../../../src/core/store/constants.ts";
import { foldSignals } from "../../../src/core/store/fold-signals.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { storesStateDir, isPathInside } from "../../../src/core/store/store-paths.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
import { processDirsEnv } from "../../../src/core/platform-dirs.ts";
import { deviceSwitchedHere } from "../../../src/core/store/store-only.ts";
import { inspectStore } from "../../../src/core/store/store-open.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  runAutoStoreMigration,
} from "../../../src/core/store-migration/auto-worker.ts";
import { readAutoMigrationWaiting } from "../../../src/core/store-migration/auto-state.ts";
import { migrateStore } from "../../../src/core/store-migration/outcome.ts";
import { cohortRecordsInFlight } from "../../../src/core/store-migration/cohort-in-flight.ts";
import {
  runAutoLegacyRemoval,
  takeAutoRemovalNotice,
} from "../../../src/core/store-migration/auto-removal.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { moveStoreIntoVault } from "../../../src/core/store-migration/move-into-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeVaultFleet, type VaultFleet, type VaultMachine } from "./fixtures/vault-fleet.ts";

// Whole migrations run here; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fleet: VaultFleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function start(m: VaultMachine): ReturnType<typeof runAutoStoreMigration> {
  m.use();
  return runAutoStoreMigration(m.vault, { settleMs: 0 });
}

function capture(m: VaultMachine, slug: string): void {
  m.use();
  writeSignal(m.vault, {
    topic: slug,
    signal: "positive",
    agent: "@t",
    principle: `Written on ${m.name}: ${slug}`,
    created_at: "2026-11-24T10:00:00Z",
    date: "2026-11-24",
    slug,
  });
}

/** What both machines must agree on: every record id, and the signals fold. */
function foldOf(m: VaultMachine): { ids: string[]; signals: string[] } {
  m.use();
  const records = m.records();
  const fold = foldSignals(records);
  return {
    ids: records.map((r) => r.id).toSorted(),
    signals: [...fold.signals.keys()].toSorted(),
  };
}

/** Every file under the vault's store folder, relative to it. */
function vaultStoreFiles(m: VaultMachine): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(m.vaultStore, path).split(sep).join("/"));
    }
  };
  walk(m.vaultStore);
  return out;
}

/** The only files the vault's store folder may hold: the format and identity files, shards, blobs. */
const STORE_FILE =
  /^(FORMAT\.md|(shared|private)\/(FORMAT\.md|store\.json|blobs\/[0-9a-f]{2}\/[0-9a-f]{64}|[a-z-]+(\/[a-z0-9-]+)?\/[a-z0-9-]+\/\d{4}-\d{2}\.jsonl))$/;

function expectNoDeviceLocalState(m: VaultMachine): void {
  const files = vaultStoreFiles(m);
  expect(files.filter((f) => !STORE_FILE.test(f))).toEqual([]);
  expect(files.some((f) => f.endsWith(STORE_RELOCATED_FILE))).toBe(false);
  m.use();
  // The device-local directory of every store lies outside the vault.
  expect(isPathInside(storesStateDir(processDirsEnv()), m.vault, process.platform)).toBe(false);
}

/** The owner's 2.0.0 state on `a`: switched, its store at the per-user default outside the vault. */
function switchedOn200(a: VaultMachine): void {
  a.use();
  initStore({ root: a.externalStore });
  const outcome = migrateStore(a.vault, { resume: true, settleMs: 0 });
  expect(outcome.mode).toBe("migration");
  expect(a.root()).toBe(a.externalStore);
}

describe("both machines on the legacy layout", () => {
  test("A updates and creates the store in the vault; B finds it there and joins it", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(a.root()).toBe(a.vaultStore);
    expect(existsSync(a.externalStore)).toBe(false);

    fleet.syncVault("dev-a", "dev-b");
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(b.root()).toBe(b.vaultStore);
    expect(inspectStore(b.vaultStore)!.storeId).toBe(inspectStore(a.vaultStore)!.storeId);
    expect(deviceSwitchedHere(openStore({ root: b.vaultStore, device: "dev-b" }), "dev-b")).toBe(
      true,
    );

    capture(a, "from-a");
    capture(b, "from-b");
    fleet.syncVault("dev-a", "dev-b");
    fleet.syncVault("dev-b", "dev-a");
    const [fa, fb] = [foldOf(a), foldOf(b)];
    expect(fa).toEqual(fb);
    expect(fa.signals.length).toBeGreaterThan(0);
    expectNoDeviceLocalState(a);
    expectNoDeviceLocalState(b);
  });
});

describe("the owner's state: A switched on 2.0.0 outside the vault, B still legacy", () => {
  test("A's starts move nothing; the command on A moves the store, B joins it, folds end equal", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    switchedOn200(a);
    capture(a, "a-on-200");
    const before = foldOf(a);

    // B sees A's mark in the synced legacy log and waits, plainly, naming
    // the command A needs.
    fleet.syncVault("dev-a", "dev-b");
    const waiting = start(b);
    expect(waiting.outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    expect(readAutoMigrationWaiting(b.vault)?.awaitsStore).toBe(true);
    expect(readAutoMigrationWaiting(b.vault)?.reason).toContain("o2b store move-into-vault");
    capture(b, "b-while-waiting");

    // A starts on the new release: nothing moves.
    a.use();
    expect(start(a).outcome).not.toBe(AUTO_MIGRATION_OUTCOME.failed);
    a.use();
    expect(a.root()).toBe(a.externalStore);
    expect(existsSync(a.vaultStore)).toBe(false);
    expect(existsSync(join(a.externalStore, STORE_RELOCATED_FILE))).toBe(false);

    // A person runs the command on A, with the agent sessions closed.
    const moved = moveStoreIntoVault();
    expect(moved.kind).toBe("moved");
    a.use();
    expect(a.root()).toBe(a.vaultStore);
    expect(existsSync(join(a.externalStore, STORE_RELOCATED_FILE))).toBe(true);
    const after = foldOf(a);
    // Same store, same record ids, same device: the bytes moved.
    expect(after.ids).toEqual(before.ids);
    expect(inspectStore(a.vaultStore)!.storeId).toBe(
      JSON.parse(readFileSync(join(a.externalStore, STORE_RELOCATED_FILE), "utf8")).store_id,
    );

    // The vault carries the store to B, which joins it as a later machine.
    fleet.syncVault("dev-a", "dev-b");
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(b.root()).toBe(b.vaultStore);

    // Writes in both directions, then the vault both ways: equal folds.
    capture(a, "a-after");
    capture(b, "b-after");
    fleet.syncVault("dev-a", "dev-b");
    fleet.syncVault("dev-b", "dev-a");
    // A imports B's late legacy write at its next start (the transition).
    start(a);
    fleet.syncVault("dev-a", "dev-b");
    const [fa, fb] = [foldOf(a), foldOf(b)];
    expect(fa).toEqual(fb);
    for (const slug of ["a-on-200", "b-while-waiting", "a-after", "b-after"]) {
      expect(fa.signals.some((id) => id.includes(slug))).toBe(true);
    }
    // Nothing is in flight any more, so the legacy removal may go on.
    a.use();
    expect(
      cohortRecordsInFlight(a.vault, openStore({ root: a.vaultStore, device: "dev-a" })).reasons,
    ).toEqual([]);
    expectNoDeviceLocalState(a);
    expectNoDeviceLocalState(b);
  });

  test("while A's store has not arrived, the removal predicate holds B's view of A as in flight", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    switchedOn200(a);
    a.use();
    expect(moveStoreIntoVault().kind).toBe("moved");
    // Only the legacy log reaches B; the store folder does not.
    fleet.syncVault("dev-a", "dev-b", { dropHidden: true });
    b.use();
    // B makes a store of its own by hand (the only way it would): A's
    // switch record is not in it, so A counts as in flight.
    initStore({ root: b.vaultStore });
    const here = openStore({ root: b.vaultStore, device: "dev-b" });
    const inFlight = cohortRecordsInFlight(b.vault, here, "dev-b");
    expect(inFlight.devices).toEqual(["dev-a"]);
  });
});

describe("the automatic removal and records in flight", () => {
  test("the tree waits while B's switch has not arrived on A, and leaves once it has", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    fleet.syncVault("dev-a", "dev-b");
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // B's migration mark reaches A with the legacy log; its store folder,
    // where its switch record is, does not.
    fleet.syncVault("dev-b", "dev-a", { dropHidden: true });
    a.use();
    // The migrations above stamped their records with the wall clock, and
    // the silence rule measures against the newest evidence not later than
    // `now`: a fixed date would leave those records in its future and
    // judge the fixture's dev-c (last seen 2026-09-01) by the fixture's
    // own old dates, not silent, once the wall clock passed that date.
    const now = new Date();
    const waiting = runAutoLegacyRemoval(a.vault, { now });
    expect(waiting?.outcome).toBe("pending");
    expect(waiting?.in_flight).toBe(true);
    expect(waiting?.pending?.map((d) => d.device)).toEqual(["dev-b"]);
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
    const line = takeAutoRemovalNotice(a.vault, undefined, now);
    expect(line?.message).toContain("until the records of device dev-b have arrived");
    expect(line?.message).toContain(".open-second-brain-store/");

    // The store folder arrives: nothing is in flight, and the tree leaves.
    fleet.syncVault("dev-b", "dev-a");
    a.use();
    const removed = runAutoLegacyRemoval(a.vault, { now: new Date(now.getTime() + 3_600_000) });
    expect(removed?.outcome).toBe("removed");
    expect(existsSync(join(a.vault, "Brain"))).toBe(false);
    expect(existsSync(a.vaultStore)).toBe(true);
  });
});

/** dev-b's store shards other than its settings shard (where its switch record is). */
function devBShardsButSettings(rel: string): boolean {
  return (
    rel.startsWith(`${STORE_VAULT_DIR}/`) &&
    rel.split("/").at(-2) === "dev-b" &&
    !rel.includes("/settings/")
  );
}

describe("a later device whose switch record arrived before its other records", () => {
  test("is in flight until every shard its migration wrote has arrived", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    fleet.syncVault("dev-a", "dev-b");
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // The sync delivers B's settings shard, where its switch record is,
    // and not yet the other shards B's migration wrote.
    fleet.syncVault("dev-b", "dev-a", { skip: devBShardsButSettings });
    a.use();
    const store = openStore({ root: a.vaultStore, device: "dev-a" });
    const held = cohortRecordsInFlight(a.vault, store, "dev-a");
    expect(held.devices).toEqual(["dev-b"]);
    expect(held.reasons.join(" ")).toContain("of the migration of device dev-b have not arrived");

    fleet.syncVault("dev-b", "dev-a");
    a.use();
    const after = openStore({ root: a.vaultStore, device: "dev-a" });
    expect(cohortRecordsInFlight(a.vault, after, "dev-a").reasons).toEqual([]);
  });
});

describe("a transport that drops hidden folders", () => {
  test("B waits and says so plainly: once a day at session start, in status and in doctor", async () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    fleet.syncVault("dev-a", "dev-b", { dropHidden: true });
    expect(existsSync(b.vaultStore)).toBe(false);
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    // No second store: B creates nothing while A's has not arrived.
    expect(existsSync(b.vaultStore)).toBe(false);

    b.use();
    const first = collectRuntimeNotices(b.vault, { oneTime: true });
    const line = first.find((n) => n.code === "store_migration_waiting");
    expect(line?.message).toContain(STORE_VAULT_DIR);
    expect(line?.message).toContain("hidden folders");
    expect(line?.message).toContain("dev-a");
    // Once a day: the next session start the same day says nothing more.
    const second = collectRuntimeNotices(b.vault, { oneTime: true });
    expect(second.some((n) => n.code === "store_migration_waiting")).toBe(false);
    // The status block and the doctor say it every time.
    const status = JSON.stringify(buildStoreStatusBlock({ vault: b.vault, configPath: null }));
    expect(status).toContain("hidden folders");
    const report = await runDoctor(b.vault);
    expect(JSON.stringify(report)).toContain("hidden folders");

    // A transport that carries hidden folders ends the wait.
    fleet.syncVault("dev-a", "dev-b");
    b.use();
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    capture(a, "x-a");
    capture(b, "x-b");
    fleet.syncVault("dev-a", "dev-b");
    fleet.syncVault("dev-b", "dev-a");
    expect(foldOf(a)).toEqual(foldOf(b));
  });
});

describe("concurrent first starts", () => {
  test("two machines that create the store before either sees the other's make one store", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // The id comes from the vault's synced identity: the same on both.
    expect(inspectStore(a.vaultStore)!.storeId).toBe(inspectStore(b.vaultStore)!.storeId);
    fleet.syncVault("dev-a", "dev-b");
    fleet.syncVault("dev-b", "dev-a");
    // Both keep writing after the sync: no identity refusal.
    capture(a, "c-a");
    capture(b, "c-b");
    fleet.syncVault("dev-a", "dev-b");
    fleet.syncVault("dev-b", "dev-a");
    expect(foldOf(a)).toEqual(foldOf(b));
    expectNoDeviceLocalState(a);
    expectNoDeviceLocalState(b);
  });

  test("a vault without an identity marker: still one store, however the files arrive", () => {
    fleet = makeVaultFleet(["dev-a", "dev-b", "dev-d"], { identityMarker: false });
    const [a, b, d] = [fleet.machine("dev-a"), fleet.machine("dev-b"), fleet.machine("dev-d")];
    expect(existsSync(join(a.vault, "Brain", "vault-id.json"))).toBe(false);
    // Neither has seen the other.
    expect(start(a).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(start(b).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    const id = inspectStore(a.vaultStore)!.storeId;
    expect(inspectStore(b.vaultStore)!.storeId).toBe(id);
    // The marker A's migration minted reaches D before A's store and mark do.
    fleet.syncVault("dev-a", "dev-d", { skip: (rel) => rel !== "Brain/vault-id.json" });
    expect(existsSync(join(d.vault, "Brain", "vault-id.json"))).toBe(true);
    expect(start(d).outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(inspectStore(d.vaultStore)!.storeId).toBe(id);
  });
});

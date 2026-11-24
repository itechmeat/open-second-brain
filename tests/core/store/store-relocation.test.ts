/**
 * The move of a 2.0.0 store from the per-user folder into the vault's
 * reserved folder (`store-relocation.ts`, run only by
 * `o2b store move-into-vault`): a crash at every boundary, a holder
 * killed mid-move, a stale process holding a handle on the old root, an
 * older-release process appending to the old root after the move, and a
 * store with another id already in the vault folder.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_RELOCATED_FILE } from "../../../src/core/store/constants.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import {
  inspectStore,
  openStore,
  RelocatedStoreUnavailableError,
} from "../../../src/core/store/store-open.ts";
import { deviceStateDirFor } from "../../../src/core/store/store-paths.ts";
import { processDirsEnv } from "../../../src/core/platform-dirs.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import {
  carryLateWrites,
  lateWritesPending,
  pendingRelocation,
  relocateStore,
  relocationLockTarget,
  RELOCATION_STEP,
  type RelocationStep,
} from "../../../src/core/store/store-relocation.ts";
import { readStoreBindings } from "../../../src/core/store/store-identity.ts";
import * as config from "../../../src/core/config.ts";
import { runAutoStoreMigration } from "../../../src/core/store-migration/auto-worker.ts";
import {
  moveStoreIntoVault,
  readRelocationState,
  relocationSurface,
} from "../../../src/core/store-migration/move-into-vault.ts";
import { migrateStore } from "../../../src/core/store-migration/outcome.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import {
  makeVaultFleet,
  type VaultFleet,
  type VaultMachine,
} from "../store-migration/fixtures/vault-fleet.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fleet: VaultFleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

/** A machine in the owner's 2.0.0 state: switched, its store outside the vault. */
function onOldDefault(): VaultMachine {
  fleet = makeVaultFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  initStore({ root: a.externalStore });
  const outcome = migrateStore(a.vault, { resume: true, settleMs: 0 });
  expect(outcome.mode).toBe("migration");
  return a;
}

function ids(root: string): string[] {
  return (["shared", "private"] as const)
    .flatMap((p) => readPartition(join(root, p)).flatMap((s) => s.all))
    .map((r) => r.id)
    .toSorted();
}

function note(a: VaultMachine, text: string): string {
  a.use();
  const store = openStore({ root: a.root(), device: "dev-a" });
  return appendRecord(store, {
    partition: "shared",
    stream: "events",
    agent: "@t",
    kind: "log-event",
    body: { event_type: "note", text },
  }).record.id;
}

const STEPS: ReadonlyArray<RelocationStep> = Object.values(RELOCATION_STEP);

describe("a crash at each boundary", () => {
  for (const step of STEPS) {
    test(`at ${step}: the next start finishes the move with nothing lost`, () => {
      const a = onOldDefault();
      const before = ids(a.externalStore);
      const storeId = inspectStore(a.externalStore)!.storeId;
      expect(() =>
        relocateStore({
          atStep: (at) => {
            if (at === step) throw new Error(`crash at ${at}`);
          },
        }),
      ).toThrow(`crash at ${step}`);
      a.use();
      const committed = step === RELOCATION_STEP.committed;
      // Before the commit the old root is still the store; at it, the vault folder is.
      expect(a.root()).toBe(committed ? a.vaultStore : a.externalStore);
      // A write between the crash and the next run lands where the root says.
      const between = note(a, "between");
      // A session start (the migration worker) does not take the move up.
      runAutoStoreMigration(a.vault, { settleMs: 0 });
      a.use();
      expect(a.root()).toBe(committed ? a.vaultStore : a.externalStore);
      // The next run of the command finishes it.
      expect(moveStoreIntoVault().kind).toBe(committed ? "nothing" : "moved");
      a.use();
      expect(a.root()).toBe(a.vaultStore);
      expect(pendingRelocation()).toBeNull();
      expect(inspectStore(a.vaultStore)!.storeId).toBe(storeId);
      const after = ids(a.vaultStore);
      for (const id of [...before, between]) expect(after).toContain(id);
      // The old root is inactive: a later write never reaches it.
      const oldIds = ids(a.externalStore);
      note(a, "later");
      expect(ids(a.externalStore)).toEqual(oldIds);
    });
  }

  test("a relocation whose process died leaves no holder: the next one takes over", () => {
    const a = onOldDefault();
    const storeId = inspectStore(a.externalStore)!.storeId;
    // The holder file of a process that is gone (pid 2^22 + 1 is never live here).
    const target = relocationLockTarget(deviceStateDirFor(storeId, processDirsEnv()));
    writeFileSync(
      `${target}.holder`,
      JSON.stringify({ pid: 4194305, started: "gone", at: Date.now(), token: "x" }),
    );
    // Writers do not wait for a dead holder.
    note(a, "while-dead-holder");
    const outcome = relocateStore();
    expect(outcome.kind).toBe("relocated");
  });
});

describe("a process that opened the store before the move", () => {
  test("appends to the vault folder after it, never to the old root", () => {
    const a = onOldDefault();
    a.use();
    const stale = openStore({ root: a.externalStore, device: "dev-a" });
    const oldIds = ids(a.externalStore);
    expect(relocateStore().kind).toBe("relocated");
    const id = appendRecord(stale, {
      partition: "shared",
      stream: "events",
      agent: "@t",
      kind: "log-event",
      body: { event_type: "note", text: "stale handle" },
    }).record.id;
    expect(ids(a.externalStore)).toEqual(oldIds);
    expect(ids(a.vaultStore)).toContain(id);
    // A fresh open of the old root opens the store where it moved.
    expect(openStore({ root: a.externalStore, device: "dev-a" }).root).toBe(a.vaultStore);
  });
});

describe("an older-release process that appends to the old root after the move", () => {
  test("its lines are carried into the vault folder by the next run, once", () => {
    const a = onOldDefault();
    a.use();
    const stale = openStore({ root: a.externalStore, device: "dev-a" });
    // Write one record so the shard of this month exists, then move.
    appendRecord(stale, {
      partition: "shared",
      stream: "events",
      agent: "@t",
      kind: "log-event",
      body: { event_type: "note", text: "before" },
    });
    expect(relocateStore().kind).toBe("relocated");
    // An older release knows no marker: it appends to the old shard by hand.
    const marker = JSON.parse(readFileSync(join(a.externalStore, STORE_RELOCATED_FILE), "utf8"));
    const own = Object.keys(marker.files).find((p: string) => p.includes("/events/dev-a/"))!;
    const oldShard = join(a.externalStore, ...own.split("/"));
    const lastLine = readFileSync(oldShard, "utf8").trimEnd().split("\n").at(-1)!;
    const record = JSON.parse(lastLine);
    const late = { ...record, id: "01KZZZZZZZZZZZZZZZZZZZZZZZ" };
    appendFileSync(oldShard, `${JSON.stringify(late)}\n`);
    expect(lateWritesPending()).toBe(true);
    expect(relocationSurface()?.code).toBe("store_late_writes");
    expect(carryLateWrites()).toEqual({ carried: 1, waiting: 0 });
    expect(lateWritesPending()).toBe(false);
    expect(relocationSurface()).toBeNull();
    expect(carryLateWrites()).toEqual({ carried: 0, waiting: 0 });
    const newShard = join(a.vaultStore, ...own.split("/"));
    const lines = readFileSync(newShard, "utf8").trimEnd().split("\n");
    expect(lines.filter((l) => l.includes(late.id))).toHaveLength(1);
  });
});

describe("a store with another id already in the vault folder", () => {
  test("is never merged: the move stops, says so, and the old root stays in use", () => {
    const a = onOldDefault();
    a.use();
    initStore({ root: a.vaultStore });
    const before = ids(a.externalStore);
    const result = moveStoreIntoVault();
    expect(result.kind).toBe("refused");
    a.use();
    expect(a.root()).toBe(a.externalStore);
    expect(existsSync(join(a.externalStore, STORE_RELOCATED_FILE))).toBe(false);
    const state = readRelocationState();
    expect(state?.kind).toBe("refused");
    expect(state?.reason).toContain("another brain store");
    // The surfaces name the refusal beside the store outside the vault.
    expect(relocationSurface()?.text).toContain("another brain store");
    expect(ids(a.vaultStore)).toEqual([]);
    expect(ids(a.externalStore)).toEqual(before);
  });
});

describe("a moved store whose destination does not hold it now", () => {
  const event = {
    partition: "shared" as const,
    stream: "events" as const,
    agent: "@t",
    kind: "log-event",
    body: { event_type: "note", text: "stale handle" },
  };

  test("replaced by another store: a stale handle's write and the late lines go to neither root", () => {
    const a = onOldDefault();
    a.use();
    const stale = openStore({ root: a.externalStore, device: "dev-a" });
    appendRecord(stale, event);
    expect(relocateStore().kind).toBe("relocated");
    const oldIds = ids(a.externalStore);
    // Sync, or a hand, puts another store in the vault folder.
    rmSync(a.vaultStore, { recursive: true, force: true });
    initStore({ root: a.vaultStore });
    expect(() => appendRecord(stale, event)).toThrow(RelocatedStoreUnavailableError);
    expect(ids(a.vaultStore)).toEqual([]);
    expect(ids(a.externalStore)).toEqual(oldIds);
    // An older release's line in the old root is not carried into the other store.
    const marker = JSON.parse(readFileSync(join(a.externalStore, STORE_RELOCATED_FILE), "utf8"));
    const own = Object.keys(marker.files).find((p: string) => p.includes("/events/dev-a/"))!;
    const oldShard = join(a.externalStore, ...own.split("/"));
    const last = JSON.parse(readFileSync(oldShard, "utf8").trimEnd().split("\n").at(-1)!);
    appendFileSync(oldShard, `${JSON.stringify({ ...last, id: "01KZZZZZZZZZZZZZZZZZZZZZZZ" })}\n`);
    expect(lateWritesPending()).toBe(false);
    expect(carryLateWrites()).toEqual({ carried: 0, waiting: 0 });
    expect(ids(a.vaultStore)).toEqual([]);
  });

  test("its identity files gone: the old root is not opened as the store, nor written", () => {
    const a = onOldDefault();
    a.use();
    const stale = openStore({ root: a.externalStore, device: "dev-a" });
    expect(relocateStore().kind).toBe("relocated");
    for (const p of ["shared", "private"]) rmSync(join(a.vaultStore, p, "store.json"));
    expect(() => inspectStore(a.externalStore)).toThrow(RelocatedStoreUnavailableError);
    expect(() => openStore({ root: a.externalStore, device: "dev-a" })).toThrow(
      RelocatedStoreUnavailableError,
    );
    const shards = readdirSync(join(a.vaultStore, "shared"), { recursive: true }).length;
    expect(() => appendRecord(stale, event)).toThrow(RelocatedStoreUnavailableError);
    expect(readdirSync(join(a.vaultStore, "shared"), { recursive: true }).length).toBe(shards);
  });
});

/** The temp file name this process copies `dest` through (`store-relocation.ts`). */
function tempOf(dest: string): string {
  return join(dirname(dest), `.relocating-${process.pid}-${dest.length}.tmp`);
}

/**
 * The vault folder's `shared` partition already carrying this store's
 * identity (an earlier move cut short after it renamed that partition into
 * place), so the move completes it file by file: the path there of one of
 * this device's shards, whose folder exists and whose file does not.
 */
function partlyThere(a: VaultMachine): string {
  const identity = join(a.vaultStore, "shared", "store.json");
  mkdirSync(dirname(identity), { recursive: true });
  copyFileSync(join(a.externalStore, "shared", "store.json"), identity);
  const rel = readdirSync(join(a.externalStore, "shared"), { recursive: true })
    .map(String)
    .find((f) => f.endsWith(".jsonl") && f.includes("dev-a"))!;
  const dest = join(a.vaultStore, "shared", rel);
  mkdirSync(dirname(dest), { recursive: true });
  return dest;
}

describe("what a sync left at the name of a copy's temp file", () => {
  test.skipIf(process.platform === "win32")(
    "a symbolic link is removed, never written through",
    () => {
      const a = onOldDefault();
      a.use();
      const victim = join(a.home, "victim.txt");
      writeFileSync(victim, "keep\n");
      const dest = partlyThere(a);
      symlinkSync(victim, tempOf(dest));
      expect(relocateStore().kind).toBe("relocated");
      expect(readFileSync(victim, "utf8")).toBe("keep\n");
      expect(existsSync(tempOf(dest))).toBe(false);
      expect(inspectStore(a.vaultStore)).not.toBeNull();
    },
  );

  test("a stale temp file does not block the move", () => {
    const a = onOldDefault();
    a.use();
    const dest = partlyThere(a);
    writeFileSync(tempOf(dest), "stale");
    expect(relocateStore().kind).toBe("relocated");
    expect(existsSync(tempOf(dest))).toBe(false);
  });
});

describe("the bindings keyed by the root", () => {
  test("name the vault folder after the move, with the same store and device", () => {
    const a = onOldDefault();
    a.use();
    const storeId = inspectStore(a.externalStore)!.storeId;
    expect(relocateStore().kind).toBe("relocated");
    const bound = readStoreBindings().find((b) => b.root === a.vaultStore);
    expect(bound?.store_id).toBe(storeId);
    expect(bound?.device).toBe("dev-a");
    // The copies keep the store's own modes: files 0600, folders 0700.
    if (process.platform !== "win32") {
      expect(statSync(join(a.vaultStore, "shared", "store.json")).mode & 0o077).toBe(0);
      expect(statSync(join(a.vaultStore, "shared")).mode & 0o077).toBe(0);
    }
  });
});

describe("the vault a move is judged against", () => {
  test("is read once: eligibility and destination never come from two readings", () => {
    const a = onOldDefault();
    a.use();
    const other = join(a.home, "other-vault");
    mkdirSync(other, { recursive: true });
    const real = config.resolveVault;
    let calls = 0;
    // The selection changes between two readings of the vault.
    const spy = spyOn(config, "resolveVault").mockImplementation(((...args) => {
      calls += 1;
      return calls === 1 ? real(...args) : other;
    }) as typeof real);
    try {
      const pending = pendingRelocation();
      expect(pending?.vault).toBe(a.vault);
      expect(pending?.to).toBe(a.vaultStore);
    } finally {
      spy.mockRestore();
    }
  });
});

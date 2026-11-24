/**
 * A store handle or an open that follows a relocation to the vault folder
 * (`store-relocation.ts`) writes and opens only the store that moved
 * there: the destination is checked again where the write or the open
 * happens, the partitions it holds are the ones written, and the records
 * are stamped after what the process read at either root.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { appendRecord, PartitionUnavailableError } from "../../../src/core/store/appender.ts";
import { noteObservedClock } from "../../../src/core/store/clock-floor.ts";
import * as clockStore from "../../../src/core/store/clock-store.ts";
import {
  STORE_LINE_CAP_BYTES,
  STORE_LOCKS_DIR,
  STORE_RELOCATED_FILE,
  STORE_ROOT_ENV,
} from "../../../src/core/store/constants.ts";
import { compareHlc, parseHlc } from "../../../src/core/store/hlc.ts";
import * as localLock from "../../../src/core/store/local-lock.ts";
import * as relocationTarget from "../../../src/core/store/relocation-target.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { describeConfiguredStoreLocation } from "../../../src/core/store/store-location.ts";
import {
  inspectStore,
  openStore,
  RelocatedStoreUnavailableError,
} from "../../../src/core/store/store-open.ts";
import { relocateStore } from "../../../src/core/store/store-relocation.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import {
  EVENT,
  machineOnOldDefault,
  recordIds,
  staleHandle,
  type OldDefaultMachine,
} from "./fixtures/old-default-store.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let machine: OldDefaultMachine | null = null;
afterEach(() => {
  machine?.fleet.cleanup();
  machine = null;
});

/** Sync puts another store in the vault folder. */
function replaceDestination(root: string): void {
  rmSync(root, { recursive: true, force: true });
  initStore({ root });
}

describe("a write through a handle opened before the move", () => {
  test("whose destination is replaced while it waits for the shard lock is refused", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    const stale = staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    const real = localLock.withLocalLock;
    let replaced = false;
    const spy = spyOn(localLock, "withLocalLock").mockImplementation(((target, fn, budget) => {
      if (!replaced && target.startsWith(join(stale.deviceStateDir, STORE_LOCKS_DIR))) {
        replaced = true;
        replaceDestination(a.vaultStore);
      }
      return real(target, fn, budget);
    }) as typeof real);
    try {
      expect(() => appendRecord(stale, EVENT)).toThrow(RelocatedStoreUnavailableError);
    } finally {
      spy.mockRestore();
    }
    expect(replaced).toBe(true);
    expect(recordIds(a.vaultStore)).toEqual([]);
  });

  test("to a partition the destination no longer holds is refused, and the partition is not made", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    const stale = staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    rmSync(join(a.vaultStore, "private"), { recursive: true, force: true });
    expect(() => appendRecord(stale, { ...EVENT, partition: "private" })).toThrow(
      PartitionUnavailableError,
    );
    expect(existsSync(join(a.vaultStore, "private"))).toBe(false);
    // The partition still there takes the write.
    const id = appendRecord(stale, EVENT).record.id;
    expect(recordIds(a.vaultStore)).toContain(id);
  });

  test("is stamped after a record the process read at the vault folder", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    const stale = staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    // A peer's record, stamped an hour ahead, read from the new root.
    const ahead = { physical: Date.now() + 3_600_000, counter: 3 };
    noteObservedClock(a.vaultStore, ahead);
    const written = appendRecord(stale, EVENT).record;
    expect(compareHlc(parseHlc(written.hlc)!, ahead)).toBeGreaterThan(0);
  });
});

describe("an open of the old root", () => {
  for (const how of ["openStore", "inspectStore"] as const) {
    test(`${how}: a destination replaced after its check is not taken for the store`, () => {
      machine = machineOnOldDefault();
      const { a } = machine;
      staleHandle(a);
      expect(relocateStore().kind).toBe("relocated");
      const real = relocationTarget.relocationOf;
      let replaced = false;
      const spy = spyOn(relocationTarget, "relocationOf").mockImplementation((root, storeId) => {
        const state = real(root, storeId);
        if (!replaced && state.kind === "moved" && resolve(state.to) === resolve(a.vaultStore)) {
          replaced = true;
          replaceDestination(a.vaultStore);
        }
        return state;
      });
      try {
        const open = () =>
          how === "openStore"
            ? openStore({ root: a.externalStore, device: "dev-a" })
            : inspectStore(a.externalStore);
        expect(open).toThrow(RelocatedStoreUnavailableError);
      } finally {
        spy.mockRestore();
      }
      expect(replaced).toBe(true);
    });
  }
});

/** Every blob file name under the `shared` partition of `root`. */
function blobsUnder(root: string): string[] {
  const dir = join(root, "shared", "blobs");
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).toSorted() : [];
}

describe("a large record whose root was settled just before the move committed", () => {
  test("writes its blob only where its line goes, never into the recovery copy", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    const stale = staleHandle(a);
    const before = blobsUnder(a.externalStore);
    const real = clockStore.tickClockMany;
    let moved = false;
    // The move commits after this append settled the old root as its target.
    const spy = spyOn(clockStore, "tickClockMany").mockImplementation(((...args) => {
      if (!moved) {
        moved = true;
        expect(relocateStore().kind).toBe("relocated");
      }
      return real(...args);
    }) as typeof real);
    let written;
    try {
      written = appendRecord(stale, {
        ...EVENT,
        body: { event_type: "note", text: "x".repeat(STORE_LINE_CAP_BYTES + 64) },
      });
    } finally {
      spy.mockRestore();
    }
    expect(moved).toBe(true);
    expect(written.spilled).toBe(true);
    expect(blobsUnder(a.externalStore)).toEqual(before);
    expect(blobsUnder(a.vaultStore).length).toBeGreaterThan(0);
    expect(recordIds(a.vaultStore)).toContain(written.record.id);
  });
});

describe("two copies whose markers point at each other", () => {
  test("are refused, not followed without end; one move alone still opens", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    const marker = JSON.parse(readFileSync(join(a.externalStore, STORE_RELOCATED_FILE), "utf8"));
    // A restore put a marker into the vault folder that points back.
    const back = join(a.vaultStore, STORE_RELOCATED_FILE);
    writeFileSync(back, JSON.stringify({ ...marker, to: a.externalStore, files: {} }));
    expect(() => openStore({ root: a.externalStore, device: "dev-a" })).toThrow(
      RelocatedStoreUnavailableError,
    );
    expect(() => inspectStore(a.externalStore)).toThrow(RelocatedStoreUnavailableError);
    rmSync(back);
    expect(openStore({ root: a.externalStore, device: "dev-a" }).root).toBe(a.vaultStore);
  });

  test("refuse a write through a handle opened before the move, as they refuse an open", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    const stale = staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    const before = recordIds(a.vaultStore);
    const marker = JSON.parse(readFileSync(join(a.externalStore, STORE_RELOCATED_FILE), "utf8"));
    const back = join(a.vaultStore, STORE_RELOCATED_FILE);
    writeFileSync(back, JSON.stringify({ ...marker, to: a.externalStore, files: {} }));
    expect(() => openStore({ root: a.externalStore, device: "dev-a" })).toThrow(
      RelocatedStoreUnavailableError,
    );
    expect(() => appendRecord(stale, EVENT)).toThrow(RelocatedStoreUnavailableError);
    expect(recordIds(a.vaultStore)).toEqual(before);
    // One move alone takes the write again.
    rmSync(back);
    const id = appendRecord(stale, EVENT).record.id;
    expect(recordIds(a.vaultStore)).toContain(id);
  });
});

describe("a vault folder holding a marker that names the vault folder itself", () => {
  test("is the store: it opens and takes writes, through a new handle and an old one", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    const stale = staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    // The recovery copy's marker, copied back into the folder it names.
    const marker = readFileSync(join(a.externalStore, STORE_RELOCATED_FILE), "utf8");
    writeFileSync(join(a.vaultStore, STORE_RELOCATED_FILE), marker);
    const here = openStore({ root: a.vaultStore, device: "dev-a" });
    expect(here.root).toBe(a.vaultStore);
    const fresh = appendRecord(here, EVENT).record.id;
    const old = appendRecord(stale, EVENT).record.id;
    expect(recordIds(a.vaultStore)).toEqual(expect.arrayContaining([fresh, old]));
  });
});

describe("the status of a store root that names the recovery copy", () => {
  test("reports the vault folder the open follows it to, with the partitions held there", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    process.env[STORE_ROOT_ENV] = a.externalStore;
    try {
      const report = describeConfiguredStoreLocation();
      expect(report.error).toBeNull();
      expect(report.root.path).toBe(a.vaultStore);
      expect(report.partitions.filter((p) => p.held).map((p) => p.name)).toEqual([
        "shared",
        "private",
      ]);
    } finally {
      delete process.env[STORE_ROOT_ENV];
    }
  });
});

/**
 * The late-write carry of the store relocation (`store-relocation.ts`):
 * lines an older process appended to the old root after the move arrive
 * in the vault folder exactly once, however the carries overlap or stop,
 * and only into a partition that still carries this store.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import * as fsAtomic from "../../../src/core/fs-atomic.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import { STORE_LOCKS_DIR } from "../../../src/core/store/constants.ts";
import { blobPath } from "../../../src/core/store/store-paths.ts";
import * as localLock from "../../../src/core/store/local-lock.ts";
import {
  carryLateWrites,
  lateWritesPending,
  relocateStore,
} from "../../../src/core/store/store-relocation.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import {
  lateLine,
  machineOnOldDefault,
  ownEventsShard,
  staleHandle,
  type OldDefaultMachine,
} from "./fixtures/old-default-store.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let machine: OldDefaultMachine | null = null;
afterEach(() => {
  machine?.fleet.cleanup();
  machine = null;
});

const LATE = "01KZZZZZZZZZZZZZZZZZZZZZZW";

/** A moved store with one line an older release appended to the old root after the move. */
function movedWithLateLine(): { newShard: () => string } {
  machine = machineOnOldDefault();
  const { a } = machine;
  staleHandle(a);
  expect(relocateStore().kind).toBe("relocated");
  const old = ownEventsShard(a.externalStore);
  appendFileSync(old, lateLine(old, LATE));
  return { newShard: () => ownEventsShard(a.vaultStore) };
}

function copiesOfLate(shard: string): number {
  return readFileSync(shard, "utf8")
    .split("\n")
    .filter((l) => l.includes(LATE)).length;
}

describe("the late-write carry", () => {
  test("two carries of one shard at once bring its lines once", () => {
    const { newShard } = movedWithLateLine();
    const real = localLock.withLocalLock;
    let nested = false;
    const spy = spyOn(localLock, "withLocalLock").mockImplementation(((target, fn, budget) => {
      // A second carry runs in full while the first one waits for the shard lock.
      if (!nested && target.includes(`${STORE_LOCKS_DIR}`) && target.includes("events")) {
        nested = true;
        carryLateWrites();
      }
      return real(target, fn, budget);
    }) as typeof real);
    try {
      carryLateWrites();
    } finally {
      spy.mockRestore();
    }
    expect(nested).toBe(true);
    expect(copiesOfLate(newShard())).toBe(1);
    expect(lateWritesPending()).toBe(false);
  });

  test("a carry stopped between its append and its offset is finished without a duplicate", () => {
    const { newShard } = movedWithLateLine();
    const real = fsAtomic.atomicWriteFileSync;
    let crashed = false;
    const spy = spyOn(fsAtomic, "atomicWriteFileSync").mockImplementation(((path, data, opts) => {
      if (!crashed && String(path).endsWith(join("relocation-carried.json"))) {
        crashed = true;
        throw new Error("crash before the offset");
      }
      return real(path, data, opts);
    }) as typeof real);
    try {
      expect(() => carryLateWrites()).toThrow("crash before the offset");
    } finally {
      spy.mockRestore();
    }
    expect(copiesOfLate(newShard())).toBe(1);
    expect(carryLateWrites().carried).toBe(1);
    expect(copiesOfLate(newShard())).toBe(1);
    expect(lateWritesPending()).toBe(false);
  });

  test("a line torn by a crash that nothing follows owes no carry", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    const old = ownEventsShard(a.externalStore);
    appendFileSync(old, lateLine(old, LATE).slice(0, 30));
    expect(lateWritesPending()).toBe(false);
  });

  test("a carry cut short before the newline of its last line finishes that line, once", () => {
    const { newShard } = movedWithLateLine();
    // The cut-short carry wrote the whole line but its newline.
    const old = ownEventsShard(machine!.a.externalStore);
    const line = readFileSync(old, "utf8").trimEnd().split("\n").at(-1)!;
    appendFileSync(newShard(), line);
    expect(carryLateWrites().carried).toBe(1);
    const text = readFileSync(newShard(), "utf8");
    expect(copiesOfLate(newShard())).toBe(1);
    expect(text.endsWith("\n")).toBe(true);
    expect(
      text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .every((l) => JSON.parse(l)),
    ).toBe(true);
  });

  test("a carried line a sync took back out of the vault folder is carried again, once", () => {
    const { newShard } = movedWithLateLine();
    const before = readFileSync(newShard());
    expect(carryLateWrites()).toEqual({ carried: 1, waiting: 0 });
    expect(copiesOfLate(newShard())).toBe(1);
    // A sync puts back the vault folder's shard as it was before the carry.
    writeFileSync(newShard(), before);
    expect(copiesOfLate(newShard())).toBe(0);
    expect(lateWritesPending()).toBe(true);
    expect(carryLateWrites()).toEqual({ carried: 1, waiting: 0 });
    expect(copiesOfLate(newShard())).toBe(1);
    // Nothing more is owed, and a further run appends nothing.
    expect(lateWritesPending()).toBe(false);
    carryLateWrites();
    expect(copiesOfLate(newShard())).toBe(1);
  });

  test("a blob a sync left short in the vault folder is replaced, and counted only once whole", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    const text = `a late blob ${"x".repeat(512)}`;
    const sha = sha256Hex(text);
    const old = blobPath(join(a.externalStore, "shared"), sha);
    const there = blobPath(join(a.vaultStore, "shared"), sha);
    mkdirSync(join(old, ".."), { recursive: true });
    writeFileSync(old, text);
    // The sync delivered only part of it under its name.
    mkdirSync(join(there, ".."), { recursive: true });
    writeFileSync(there, text.slice(0, 20));
    expect(carryLateWrites()).toEqual({ carried: 1, waiting: 0 });
    expect(readFileSync(there, "utf8")).toBe(text);
    expect(lateWritesPending()).toBe(false);
    // Cut short again by a sync: owed again, and repaired.
    truncateSync(there, 20);
    expect(lateWritesPending()).toBe(true);
    expect(carryLateWrites()).toEqual({ carried: 1, waiting: 0 });
    expect(readFileSync(there, "utf8")).toBe(text);
  });

  test("a partition the sync took away receives nothing, and the lines wait for a later run", () => {
    const { newShard } = movedWithLateLine();
    const { a } = machine!;
    const identity = join(a.vaultStore, "shared", "store.json");
    const aside = join(a.home, "shared-store.json");
    renameSync(identity, aside);
    expect(carryLateWrites()).toEqual({ carried: 0, waiting: 1 });
    expect(copiesOfLate(newShard())).toBe(0);
    expect(lateWritesPending()).toBe(true);
    // The partition is back: the next run carries the line, once.
    copyFileSync(aside, identity);
    expect(carryLateWrites()).toEqual({ carried: 1, waiting: 0 });
    expect(copiesOfLate(newShard())).toBe(1);
  });
});

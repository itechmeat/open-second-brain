/**
 * The copy step of the store relocation (`store-relocation.ts`): what is
 * already in the vault folder is never lost or overwritten, another
 * store's partition never receives this store's files, a link is never
 * copied through, a line still being written arrives whole, and the vault
 * binding moves only to the vault it names.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import * as fsAtomic from "../../../src/core/fs-atomic.ts";
import { processDirsEnv } from "../../../src/core/platform-dirs.ts";
import { STORE_LOCKS_DIR, STORE_RELOCATED_FILE } from "../../../src/core/store/constants.ts";
import * as safeFs from "../../../src/core/store/safe-fs.ts";
import { deviceStateDirFor } from "../../../src/core/store/store-paths.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import * as storeOpen from "../../../src/core/store/store-open.ts";
import { inspectStore } from "../../../src/core/store/store-open.ts";
import {
  carryLateWrites,
  relocateStore,
  RELOCATION_STEP,
} from "../../../src/core/store/store-relocation.ts";
import {
  bindVaultToStore,
  readVaultBindings,
} from "../../../src/core/vault-adapter/vault-binding.ts";
import { planMoveIntoVault } from "../../../src/core/store-migration/move-into-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import {
  lateLine,
  machineOnOldDefault,
  ownEventsShard,
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

const LINK = process.platform === "win32" ? "junction" : "dir";

/** Every file name under `dir` (recursive), or none when it is missing. */
function namesUnder(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
}

describe("a link where the store is copied to", () => {
  test("the vault's store folder: the move refuses and writes nothing through it", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    const elsewhere = join(a.home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, a.vaultStore, LINK);
    expect(relocateStore().kind).toBe("refused");
    expect(namesUnder(elsewhere)).toEqual([]);
    a.use();
    expect(a.root()).toBe(a.externalStore);
  });

  test("a partition folder in it: the move refuses and writes nothing through it", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    const elsewhere = join(a.home, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(a.vaultStore);
    symlinkSync(elsewhere, join(a.vaultStore, "shared"), LINK);
    expect(relocateStore().kind).toBe("refused");
    expect(namesUnder(elsewhere)).toEqual([]);
  });
});

describe("what the vault folder holds already", () => {
  test("a shard there with records beyond this machine's copy keeps them", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    // A move cut short after the copy: the vault folder holds this store.
    expect(() =>
      relocateStore({
        atStep: (at) => {
          if (at === RELOCATION_STEP.copied) throw new Error("crash");
        },
      }),
    ).toThrow("crash");
    const there = ownEventsShard(a.vaultStore);
    const extra = lateLine(there, "01KZZZZZZZZZZZZZZZZZZZZZZY");
    appendFileSync(there, extra);
    expect(relocateStore().kind).toBe("relocated");
    expect(readFileSync(there, "utf8").endsWith(extra)).toBe(true);
  });

  test("another store that appears after the check receives none of this store's files", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    const real = storeOpen.heldPartitions;
    let created = false;
    const spy = spyOn(storeOpen, "heldPartitions").mockImplementation((root) => {
      const found = real(root);
      if (!created && resolve(root) === resolve(a.vaultStore)) {
        created = true;
        initStore({ root: a.vaultStore });
      }
      return found;
    });
    try {
      expect(relocateStore().kind).toBe("refused");
    } finally {
      spy.mockRestore();
    }
    expect(created).toBe(true);
    expect(recordIds(a.vaultStore)).toEqual([]);
    expect(namesUnder(a.vaultStore).filter((n) => n.includes("dev-a"))).toEqual([]);
  });

  test("another store that appears while a partition is staged keeps it out, and no staging is left", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    const real = fsAtomic.renameWithRetry;
    let created = false;
    const spy = spyOn(fsAtomic, "renameWithRetry").mockImplementation((from, to, seams) => {
      if (!created && resolve(to) === resolve(join(a.vaultStore, "shared"))) {
        created = true;
        initStore({ root: a.vaultStore });
      }
      real(from, to, seams);
    });
    try {
      expect(relocateStore().kind).toBe("refused");
    } finally {
      spy.mockRestore();
    }
    expect(created).toBe(true);
    expect(inspectStore(a.vaultStore)!.storeId).not.toBe(inspectStore(a.externalStore)!.storeId);
    expect(recordIds(a.vaultStore)).toEqual([]);
    expect(namesUnder(a.vaultStore).filter((n) => n.includes("dev-a"))).toEqual([]);
    expect(readdirSync(a.vaultStore).filter((n) => n.startsWith(".relocating"))).toEqual([]);
  });
});

describe("a staging folder a run killed mid-copy left", () => {
  test("is cleared even when the move then refuses", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    const stage = join(a.vaultStore, `.relocating-${inspectStore(a.externalStore)!.storeId}`);
    mkdirSync(join(stage, "shared", "events"), { recursive: true });
    writeFileSync(join(stage, "shared", "events", "left.jsonl"), "{}\n");
    initStore({ root: a.vaultStore });
    expect(relocateStore().kind).toBe("refused");
    expect(existsSync(stage)).toBe(false);
  });
});

describe("a line an older process is still writing when the move runs", () => {
  test("arrives whole in the vault folder once it is finished", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    const old = ownEventsShard(a.externalStore);
    const late = lateLine(old, "01KZZZZZZZZZZZZZZZZZZZZZZX");
    appendFileSync(old, late.slice(0, 40));
    expect(relocateStore().kind).toBe("relocated");
    appendFileSync(old, late.slice(40));
    expect(carryLateWrites().carried).toBe(1);
    const lines = readFileSync(ownEventsShard(a.vaultStore), "utf8").trimEnd().split("\n");
    expect(lines.filter((l) => l.includes("01KZZZZZZZZZZZZZZZZZZZZZZX"))).toEqual([late.trimEnd()]);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });
});

describe("the vault binding of the old root", () => {
  test("bound to another vault: it is not moved onto this vault", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    const storeId = inspectStore(a.externalStore)!.storeId;
    const other = join(a.home, "other-vault");
    mkdirSync(other);
    bindVaultToStore(other, { store: { root: a.externalStore, storeId, device: "dev-a" } });
    expect(readVaultBindings().find((b) => b.root === a.externalStore)?.vault).toBe(
      realpathSync(other),
    );
    expect(relocateStore().kind).toBe("relocated");
    expect(readVaultBindings().some((b) => b.root === a.vaultStore)).toBe(false);
  });

  test("bound to this vault: it moves with the store", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    expect(readVaultBindings().some((b) => b.root === a.externalStore)).toBe(true);
    expect(relocateStore().kind).toBe("relocated");
    expect(readVaultBindings().some((b) => b.root === a.vaultStore)).toBe(true);
  });
});

describe("a destination a sync changes while the move runs", () => {
  test("a shard it grows while it is being replaced is compared again, never overwritten", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    const stale = staleHandle(a);
    // A move cut short after the copy: the vault folder holds the shard as it was.
    expect(() =>
      relocateStore({
        atStep: (at) => {
          if (at === RELOCATION_STEP.copied) throw new Error("crash");
        },
      }),
    ).toThrow("crash");
    // The old root grows (the next run replaces the shorter copy)...
    appendRecordTo(stale);
    const there = ownEventsShard(a.vaultStore);
    const theirs = lateLine(there, "01KZZZZZZZZZZZZZZZZZZZZZZV");
    const real = safeFs.createStoreTempFile;
    let synced = false;
    const spy = spyOn(safeFs, "createStoreTempFile").mockImplementation((path) => {
      // ...while the sync publishes a longer, different copy of it.
      if (!synced && path.startsWith(join(there, ".."))) {
        synced = true;
        appendFileSync(there, theirs);
      }
      return real(path);
    });
    let outcome;
    try {
      outcome = relocateStore();
    } finally {
      spy.mockRestore();
    }
    expect(synced).toBe(true);
    expect(outcome.kind).toBe("refused");
    expect(readFileSync(there, "utf8").endsWith(theirs)).toBe(true);
    expect(existsSync(join(a.externalStore, STORE_RELOCATED_FILE))).toBe(false);
  });

  test("a file shortened after its verification stops the commit", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(() =>
      relocateStore({
        atStep: (at) => {
          // The sync puts back an earlier, shorter copy after it was verified.
          if (at === RELOCATION_STEP.bound) truncateSync(ownEventsShard(a.vaultStore), 10);
        },
      }),
    ).toThrow("does not hold the bytes");
    expect(existsSync(join(a.externalStore, STORE_RELOCATED_FILE))).toBe(false);
    a.use();
    expect(a.root()).toBe(a.externalStore);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "shard locks that cannot be looked at stop the move before anything is copied",
    () => {
      machine = machineOnOldDefault();
      const { a } = machine;
      staleHandle(a);
      const locks = join(
        deviceStateDirFor(inspectStore(a.externalStore)!.storeId, processDirsEnv()),
        STORE_LOCKS_DIR,
        "shared",
      );
      mkdirSync(locks, { recursive: true });
      chmodSync(locks, 0o000);
      try {
        expect(() => relocateStore()).toThrow();
      } finally {
        chmodSync(locks, 0o700);
      }
      expect(existsSync(a.vaultStore)).toBe(false);
      expect(existsSync(join(a.externalStore, STORE_RELOCATED_FILE))).toBe(false);
    },
  );
});

describe("a store missing a partition this machine has held", () => {
  test("is not moved, as it is not opened; restored, it moves whole", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    // The open records both partitions as held on this machine.
    staleHandle(a);
    const identity = join(a.externalStore, "private", "store.json");
    const aside = join(a.home, "private-store.json");
    renameSync(identity, aside);
    const refused = relocateStore();
    expect(refused.kind).toBe("refused");
    expect(refused.kind === "refused" ? refused.reason : "").toContain("private");
    expect(planMoveIntoVault().kind).toBe("refused");
    expect(existsSync(a.vaultStore)).toBe(false);
    expect(existsSync(join(a.externalStore, STORE_RELOCATED_FILE))).toBe(false);
    // The partition is restored: the move takes both.
    renameSync(aside, identity);
    expect(relocateStore().kind).toBe("relocated");
    expect(inspectStore(a.vaultStore)?.partitions).toEqual(new Set(["shared", "private"]));
  });
});

/** One more event through `handle`, written to the root it names. */
function appendRecordTo(handle: ReturnType<typeof staleHandle>): void {
  appendRecord(handle, {
    partition: "shared",
    stream: "events",
    agent: "@t",
    kind: "log-event",
    body: { event_type: "note", text: "more" },
  });
}

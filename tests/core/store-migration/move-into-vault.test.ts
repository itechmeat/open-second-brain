/**
 * `o2b store move-into-vault` (patch 2.0.1): a store that 2.0.0 left at
 * the per-user default outside the vault moves only when a person runs the
 * command. Covered:
 *
 *  - a session start moves nothing, and says so once a day; status and
 *    doctor say it every time, with the command;
 *  - the command refuses, without waiting, while an append holds a shard
 *    lock or a dream pass runs, and moves once nothing writes;
 *  - it refuses a store root the person set, and a machine with no vault;
 *  - `--dry-run` writes nothing;
 *  - late writes of an older process are carried by a later run, and a
 *    carry that fails is recorded and named until a run succeeds.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cmdStoreMoveIntoVault } from "../../../src/cli/store-move.ts";
import { collectRuntimeNotices } from "../../../src/core/brain/runtime-notices.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { ensureVaultCurrent } from "../../../src/core/maintenance/ensure-current.ts";
import { processDirsEnv } from "../../../src/core/platform-dirs.ts";
import { STORE_RELOCATED_FILE, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { acquireProcessLock } from "../../../src/core/store/process-lock.ts";
import { inspectStore } from "../../../src/core/store/store-open.ts";
import { deviceStateDirFor, shardLockTarget } from "../../../src/core/store/store-paths.ts";
import * as storeRelocation from "../../../src/core/store/store-relocation.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
import {
  moveStoreIntoVault,
  readRelocationState,
  relocationSurface,
} from "../../../src/core/store-migration/move-into-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { runCli } from "../../helpers/run-cli.ts";
import {
  lateLine,
  machineOnOldDefault,
  ownEventsShard,
  recordIds,
  staleHandle,
  type OldDefaultMachine,
} from "../store/fixtures/old-default-store.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let machine: OldDefaultMachine | null = null;
afterEach(() => {
  machine?.fleet.cleanup();
  machine = null;
});

function configOf(m: OldDefaultMachine): string {
  return join(m.a.home, "config", "open-second-brain", "config.yaml");
}

function deviceStateDir(m: OldDefaultMachine): string {
  m.a.use();
  return deviceStateDirFor(inspectStore(m.a.externalStore)!.storeId, processDirsEnv());
}

/** Nothing of the store reached the vault, and the old root is the store. */
function expectNotMoved(m: OldDefaultMachine): void {
  m.a.use();
  expect(m.a.root()).toBe(m.a.externalStore);
  expect(existsSync(m.a.vaultStore)).toBe(false);
  expect(existsSync(join(m.a.externalStore, STORE_RELOCATED_FILE))).toBe(false);
}

describe("a machine whose store 2.0.0 left outside the vault", () => {
  test("a session start moves nothing, and says so once a day; status and doctor every time", async () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    // The start's own work, in this process (the worker logic included).
    await ensureVaultCurrent(a.vault, { background: false, configPath: configOf(machine) });
    expectNotMoved(machine);

    const first = collectRuntimeNotices(a.vault, { oneTime: true });
    const line = first.find((n) => n.code === "store_outside_vault");
    expect(line?.severity).toBe("warning");
    expect(line?.message).toContain(a.externalStore);
    expect(line?.message).toContain("outside the vault");
    expect(line?.message).toContain("o2b store move-into-vault");
    expect(line?.message).toContain("close every agent session");
    // Once a day at a session start.
    const again = collectRuntimeNotices(a.vault, { oneTime: true });
    expect(again.some((n) => n.code === "store_outside_vault")).toBe(false);
    // Every time in the status block and the doctor.
    const block = buildStoreStatusBlock({ vault: a.vault, configPath: null });
    const relocation = (block["migration"] as Record<string, Record<string, unknown>>)[
      "relocation"
    ]!;
    expect(relocation["pending"]).toBe(true);
    expect(relocation["command"]).toBe("o2b store move-into-vault");
    const report = runDoctor(a.vault);
    const issue = report.warnings.find((i) => i.code === "store-outside-vault");
    expect(issue?.message).toContain("o2b store move-into-vault");
    expectNotMoved(machine);
  });

  test("the command refuses while an append holds a shard lock, and moves once it is released", async () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    const before = recordIds(a.externalStore);
    // Another process's append to the events shard, holding its lock now.
    const lock = `${shardLockTarget(deviceStateDir(machine), "shared", "events/dev-a/2026-11.jsonl")}.lock`;
    mkdirSync(lock, { recursive: true });
    const now = new Date();
    utimesSync(lock, now, now);
    const env = { OPEN_SECOND_BRAIN_CONFIG: configOf(machine) };

    const plan = await runCli(["store", "move-into-vault", "--dry-run"], { env });
    expect(plan.returncode).toBe(0);
    expect(plan.stdout).toContain("nothing was written");
    expect(plan.stdout).toContain("A run now would refuse");
    expectNotMoved(machine);

    const refused = await runCli(["store", "move-into-vault"], { env });
    expect(refused.returncode).toBe(1);
    expect(refused.stderr).toContain("was not moved, and nothing was copied");
    expect(refused.stderr).toContain("shared/events/dev-a/2026-11.jsonl");
    expect(refused.stderr).toContain("Close every agent session");
    expectNotMoved(machine);
    expect(recordIds(a.externalStore)).toEqual(before);

    rmSync(lock, { recursive: true, force: true });
    const moved = await runCli(["store", "move-into-vault"], { env });
    expect(moved.returncode).toBe(0);
    expect(moved.stdout).toContain("Moved the brain store into the vault in");
    expect(moved.stdout).toContain(`Recovery copy: ${a.externalStore}`);
    a.use();
    expect(a.root()).toBe(a.vaultStore);
    expect(recordIds(a.vaultStore)).toEqual(before);
    // The surfaces have nothing more to say.
    expect(relocationSurface()).toBeNull();
    // A second run has nothing to do.
    const again = await runCli(["store", "move-into-vault"], { env });
    expect(again.returncode).toBe(0);
    expect(again.stdout).toContain("Nothing to do");
  });

  test("the command refuses while a dream pass runs", () => {
    machine = machineOnOldDefault();
    const dir = deviceStateDir(machine);
    mkdirSync(join(dir, "dream-owner"), { recursive: true });
    const release = acquireProcessLock(join(dir, "dream-owner", "pass"), { budgetMs: 0 });
    try {
      const result = moveStoreIntoVault();
      expect(result.kind).toBe("live");
      expect(result.kind === "live" ? result.writers : []).toContain("a dream pass runs");
      expectNotMoved(machine);
    } finally {
      release();
    }
    expect(moveStoreIntoVault().kind).toBe("moved");
  });

  test("the command refuses a store root the person set, and a machine with no vault", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    a.use();
    process.env[STORE_ROOT_ENV] = a.externalStore;
    try {
      const result = moveStoreIntoVault();
      expect(result.kind).toBe("refused");
      expect(result.kind === "refused" ? result.reason : "").toContain("never moved");
    } finally {
      delete process.env[STORE_ROOT_ENV];
    }
    expectNotMoved(machine);
    const noVault = join(a.home, "config-no-vault.yaml");
    writeFileSync(noVault, "device_id: dev-a\n");
    const result = moveStoreIntoVault({ configPath: noVault });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" ? result.reason : "").toContain("no vault is configured");
    expectNotMoved(machine);
  });
});

describe("what an older process writes to the old root after the move", () => {
  test("waits with a line naming the command, and a later run carries it once", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(moveStoreIntoVault({ carryOnly: true }).kind).toBe("refused");
    expect(moveStoreIntoVault().kind).toBe("moved");
    const old = ownEventsShard(a.externalStore);
    const late = "01KZZZZZZZZZZZZZZZZZZZZZZY";
    appendFileSync(old, lateLine(old, late));
    a.use();
    expect(relocationSurface()?.code).toBe("store_late_writes");
    const line = collectRuntimeNotices(a.vault, { oneTime: true }).find(
      (n) => n.code === "store_late_writes",
    );
    expect(line?.message).toContain("o2b store move-into-vault again");
    // A session start carries nothing.
    expect(recordIds(a.vaultStore)).not.toContain(late);

    const carried = moveStoreIntoVault({ carryOnly: true });
    expect(carried.kind).toBe("carried");
    expect(carried.kind === "carried" ? carried.carry : null).toEqual({ carried: 1, waiting: 0 });
    expect(recordIds(a.vaultStore).filter((id) => id === late)).toHaveLength(1);
    expect(relocationSurface()).toBeNull();
  });

  test("a carry that fails is recorded and named until a run succeeds", () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(moveStoreIntoVault().kind).toBe("moved");
    const old = ownEventsShard(a.externalStore);
    appendFileSync(old, lateLine(old, "01KZZZZZZZZZZZZZZZZZZZZZZX"));
    const spy = spyOn(storeRelocation, "carryLateWrites").mockImplementation(() => {
      throw new Error("the disk refused the write");
    });
    try {
      const failed = moveStoreIntoVault();
      expect(failed.kind).toBe("failed");
    } finally {
      spy.mockRestore();
    }
    expect(readRelocationState()?.kind).toBe("carry-failed");
    a.use();
    expect(relocationSurface()?.text).toContain("the disk refused the write");
    expect(moveStoreIntoVault().kind).toBe("carried");
    expect(readRelocationState()).toBeNull();
    expect(relocationSurface()).toBeNull();
  });
});

/** What the command prints on stdout, run in this process; with `carry` standing in for the carry. */
function moveOutput(carry: () => storeRelocation.CarryResult): { code: number; out: string } {
  let out = "";
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const carrySpy = spyOn(storeRelocation, "carryLateWrites").mockImplementation(carry);
  try {
    return { code: cmdStoreMoveIntoVault([]), out };
  } finally {
    carrySpy.mockRestore();
    write.mockRestore();
  }
}

describe("the recovery copy the move names", () => {
  test("is kept while late writes wait there; its removal waits for a carry that finds none", () => {
    machine = machineOnOldDefault();
    staleHandle(machine.a);
    const waiting = moveOutput(() => ({ carried: 0, waiting: 1 }));
    expect(waiting.code).toBe(0);
    expect(waiting.out).toContain("Moved the brain store into the vault");
    expect(waiting.out).toContain("Keep it");
    expect(waiting.out).not.toContain("Remove it once");
  });

  test("is kept when the carry at the end of the move fails", () => {
    machine = machineOnOldDefault();
    staleHandle(machine.a);
    const failed = moveOutput(() => {
      throw new Error("the disk refused the write");
    });
    expect(failed.out).toContain("Moved the brain store into the vault");
    expect(failed.out).toContain("Keep it");
    expect(failed.out).not.toContain("Remove it once");
  });

  test("may go once sessions from before the move ended and a carry finds nothing", () => {
    machine = machineOnOldDefault();
    staleHandle(machine.a);
    const clean = moveOutput(() => ({ carried: 0, waiting: 0 }));
    expect(clean.out).toContain("Remove it once every agent session that ran before the move");
    expect(clean.out).toContain("o2b store move-into-vault --carry says nothing waits there");
  });
});

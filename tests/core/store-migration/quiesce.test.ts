/**
 * Who may take the migration gate (`quiesce.ts`): a damaged gate file is
 * replaced, a gate whose holder is alive is never taken (another run, or a
 * second invocation of the same run) while its pid still names the process
 * that took it, a removal never lifts an interrupted run's gate, a run
 * releases only its own gate, and the operator's forced release refuses
 * only a holder that is provably alive.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { migrationGatePath, readMigrationGate } from "../../../src/core/migration-gate.ts";
import {
  forceReleaseGate,
  holdGateFor,
  MigrationGateBusyError,
  releaseGateFor,
} from "../../../src/core/store-migration/quiesce.ts";
import { processStartIdentity } from "../../../src/core/store-migration/process-identity.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";

let parent: string;
let vault: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-quiesce-"));
  vault = join(parent, "vault");
  mkdirSync(vault);
});

afterEach(() => {
  try {
    rmSync(migrationGatePath(), { recursive: true, force: true });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/** The pid of a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

function writeGate(runId: string, pid: number, started?: string): void {
  mkdirSync(dirname(migrationGatePath()), { recursive: true });
  writeFileSync(
    migrationGatePath(),
    JSON.stringify({ vault: resolve(vault), run_id: runId, since: "", pid, started }),
  );
}

/** The parent's start identity: a live process that is not this one. */
function parentIdentity(): string {
  const identity = processStartIdentity(process.ppid);
  if (identity === null) throw new Error("the parent's start identity cannot be read here");
  return identity;
}

describe("holdGateFor", () => {
  test("replaces a damaged gate file instead of refusing forever", () => {
    mkdirSync(dirname(migrationGatePath()), { recursive: true });
    writeFileSync(migrationGatePath(), "{ truncated");
    holdGateFor(vault, "run-1");
    expect(readMigrationGate()?.run_id).toBe("run-1");
  });

  test("refuses the same run id held by another live process", () => {
    // The parent process is alive and is not this one.
    writeGate("rollback-run-1", process.ppid);
    expect(() => holdGateFor(vault, "rollback-run-1")).toThrow(MigrationGateBusyError);
    expect(readMigrationGate()?.pid).toBe(process.ppid);
  });

  test("records the start identity of the process that holds the gate", () => {
    holdGateFor(vault, "run-1");
    expect(readMigrationGate()?.started).toBe(processStartIdentity(process.pid)!);
  });

  test("takes over a gate whose pid now belongs to an unrelated process", () => {
    // The parent is alive, but it started after the run that wrote this gate.
    writeGate("migrate-1", process.ppid, `${parentIdentity()}-earlier`);
    holdGateFor(vault, "migrate-1");
    expect(readMigrationGate()?.pid).toBe(process.pid);
  });

  test("refuses a gate whose recorded holder is still running", () => {
    writeGate("migrate-1", process.ppid, parentIdentity());
    expect(() => holdGateFor(vault, "migrate-1")).toThrow(MigrationGateBusyError);
    expect(readMigrationGate()?.pid).toBe(process.ppid);
  });

  test("takes over a dead run's gate unless the caller refuses it", () => {
    writeGate("migrate-1", deadPid());
    expect(() =>
      holdGateFor(vault, "remove-legacy-1", { takeOver: (id) => id.startsWith("remove-") }),
    ).toThrow(MigrationGateBusyError);
    expect(readMigrationGate()?.run_id).toBe("migrate-1");
    holdGateFor(vault, "migrate-1");
    expect(readMigrationGate()?.pid).toBe(process.pid);
  });

  test.skipIf(IS_WINDOWS)("names the gated vault however it is spelled", () => {
    const link = join(parent, "vault-link");
    symlinkSync(vault, link);
    writeGate("migrate-1", deadPid());
    holdGateFor(link, "migrate-1");
    expect(readMigrationGate()?.run_id).toBe("migrate-1");
  });
});

describe("forceReleaseGate", () => {
  test("releases a gate whose holder is gone, whatever run holds it", () => {
    writeGate("migrate-1", deadPid());
    expect(forceReleaseGate()).toMatchObject({ kind: "released", gate: { run_id: "migrate-1" } });
    expect(readMigrationGate()).toBeNull();
  });

  test("releases a gate whose pid was reused by an unrelated process", () => {
    writeGate("migrate-1", process.ppid, `${parentIdentity()}-earlier`);
    expect(forceReleaseGate()).toMatchObject({ kind: "released", gate: { run_id: "migrate-1" } });
    expect(readMigrationGate()).toBeNull();
  });

  test("refuses while the recorded holder is provably alive", () => {
    writeGate("migrate-1", process.ppid, parentIdentity());
    expect(() => forceReleaseGate()).toThrow(MigrationGateBusyError);
    expect(readMigrationGate()?.run_id).toBe("migrate-1");
  });

  test("releases a gate with no start identity, which cannot prove its holder alive", () => {
    writeGate("migrate-1", process.ppid);
    expect(forceReleaseGate()).toMatchObject({ kind: "released", gate: { run_id: "migrate-1" } });
    expect(readMigrationGate()).toBeNull();
  });

  test("does nothing when no gate is held", () => {
    expect(forceReleaseGate()).toEqual({ kind: "none" });
  });
});

describe("releaseGateFor", () => {
  test("leaves a gate another run took over", () => {
    holdGateFor(vault, "run-1");
    writeGate("run-2", deadPid());
    releaseGateFor(vault, "run-1");
    expect(readMigrationGate()?.run_id).toBe("run-2");
    releaseGateFor(vault, "run-2");
    expect(readMigrationGate()).toBeNull();
  });
});

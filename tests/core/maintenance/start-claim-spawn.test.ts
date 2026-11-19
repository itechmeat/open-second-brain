/**
 * How a session start claims the worker lock and starts the worker on it
 * (change auto-store-migration, design D2):
 *
 *  1. The claim is released only when no worker started; a hand-over that
 *     fails after the worker started leaves the claim to the worker.
 *  2. A start never waits for the claim's mutex (an exact claimer may hold
 *     it while it queries a start identity): a busy mutex is a claim being
 *     made, and the start claims nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { startOnClaim } from "../../../src/core/maintenance/ensure-current.ts";
import { acquireDirLock } from "../../../src/core/store/local-lock.ts";
import {
  AUTO_MIGRATION_LOCK_JUDGE,
  autoMigrationLockPath,
  autoMigrationWorkerLogPath,
  claimAutoMigrationLock,
  claimMutexBudgetMs,
  handAutoMigrationLock,
  readAutoMigrationFailure,
  recordAutoMigrationSpawnFailure,
  releaseAutoMigrationLock,
  settleExitedAutoMigrationWorker,
} from "../../../src/core/store-migration/auto-state.ts";
import {
  makeMigrationBench,
  type MigrationBench,
} from "../store-migration/fixtures/migration-env.ts";

describe("a start's worker on its claim", () => {
  test("a hand-over that fails after the worker started leaves the claim", () => {
    const calls: string[] = [];
    startOnClaim({
      start: () => (calls.push("start"), 4242),
      handOver: (pid) => {
        calls.push(`hand ${pid}`);
        throw new Error("the claim could not be rewritten");
      },
      release: () => calls.push("release"),
    });
    expect(calls).toEqual(["start", "hand 4242"]);
  });

  test("a worker that could not be started is recorded, releases the claim and reports why", () => {
    const calls: string[] = [];
    expect(() =>
      startOnClaim({
        start: () => {
          calls.push("start");
          throw new Error("spawn failed");
        },
        handOver: () => calls.push("hand"),
        release: () => calls.push("release"),
        failed: (e) => calls.push(`failed ${(e as Error).message}`),
      }),
    ).toThrow("spawn failed");
    expect(calls).toEqual(["start", "failed spawn failed", "release"]);
  });
});

describe("the start that spawned a worker sees it exit", () => {
  let bench: MigrationBench;
  beforeEach(() => {
    bench = makeMigrationBench("osb-start-exit-");
  });
  afterEach(() => bench.cleanup());

  /** A start's claim, handed to worker `pid`. */
  function handed(pid: number): string {
    const token = claimAutoMigrationLock(bench.vault, new Date(), {
      judge: AUTO_MIGRATION_LOCK_JUDGE.cheap,
    });
    expect(token).not.toBeNull();
    expect(handAutoMigrationLock(bench.vault, token!, pid, null)).toBe(true);
    return token!;
  }

  test("a worker that never confirmed its claim: recorded with its exit, the claim removed", () => {
    const token = handed(4242);
    writeFileSync(autoMigrationWorkerLogPath(bench.vault), "boom\n");

    expect(settleExitedAutoMigrationWorker(bench.vault, token, 4242, "exit code 127")).toBe(true);

    const failure = readAutoMigrationFailure(bench.vault);
    expect(failure!.error).toContain("exited before it started (exit code 127)");
    expect(failure!.error).toContain("its error output: boom");
    expect(existsSync(autoMigrationLockPath(bench.vault))).toBe(false);
  });

  test("a worker that confirmed its claim: nothing is recorded, the claim is its own", () => {
    const token = handed(4242);
    expect(handAutoMigrationLock(bench.vault, token, 4242, null, true)).toBe(true);

    expect(settleExitedAutoMigrationWorker(bench.vault, token, 4242, "exit code 0")).toBe(false);

    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(existsSync(autoMigrationLockPath(bench.vault))).toBe(true);
  });

  test("a parent's late hand-over keeps the worker's confirmation", () => {
    const token = handed(4242);
    expect(handAutoMigrationLock(bench.vault, token, 4242, null, true)).toBe(true);
    expect(handAutoMigrationLock(bench.vault, token, 4242, null)).toBe(true);

    expect(settleExitedAutoMigrationWorker(bench.vault, token, 4242, "exit code 0")).toBe(false);
  });

  test("a spawn failure is recorded with its error under the start's claim", () => {
    const token = claimAutoMigrationLock(bench.vault, new Date(), {
      judge: AUTO_MIGRATION_LOCK_JUDGE.cheap,
    });
    recordAutoMigrationSpawnFailure(bench.vault, "ENOENT: no such file", new Date());
    releaseAutoMigrationLock(bench.vault, token!);

    const failure = readAutoMigrationFailure(bench.vault);
    expect(failure!.error).toBe(
      "the automatic migration worker could not be started: ENOENT: no such file",
    );
    expect(failure!.consecutiveFailures).toBe(1);
  });
});

describe("a start never waits for the claim's mutex", () => {
  let bench: MigrationBench;
  beforeEach(() => {
    bench = makeMigrationBench("osb-start-claim-");
  });
  afterEach(() => bench.cleanup());

  test("the cheap judge's budget is none, every other claimer's the short one", () => {
    expect(claimMutexBudgetMs(AUTO_MIGRATION_LOCK_JUDGE.cheap)).toBe(0);
    expect(claimMutexBudgetMs(AUTO_MIGRATION_LOCK_JUDGE.exact)).toBeGreaterThan(0);
  });

  test("a busy mutex: the start claims nothing", () => {
    mkdirSync(dirname(autoMigrationLockPath(bench.vault)), { recursive: true });
    const release = acquireDirLock(autoMigrationLockPath(bench.vault), {
      staleMs: 60_000,
      budgetMs: 1000,
      label: "test",
      remedy: "none",
    });
    try {
      expect(
        claimAutoMigrationLock(bench.vault, new Date(), { judge: AUTO_MIGRATION_LOCK_JUDGE.cheap }),
      ).toBeNull();
    } finally {
      release();
    }
    expect(
      claimAutoMigrationLock(bench.vault, new Date(), { judge: AUTO_MIGRATION_LOCK_JUDGE.cheap }),
    ).not.toBeNull();
  });
});

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
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { startOnClaim } from "../../../src/core/maintenance/ensure-current.ts";
import { acquireDirLock } from "../../../src/core/store/local-lock.ts";
import {
  AUTO_MIGRATION_LOCK_JUDGE,
  autoMigrationLockPath,
  claimAutoMigrationLock,
  claimMutexBudgetMs,
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

  test("a worker that could not be started releases the claim and reports why", () => {
    const calls: string[] = [];
    expect(() =>
      startOnClaim({
        start: () => {
          calls.push("start");
          throw new Error("spawn failed");
        },
        handOver: () => calls.push("hand"),
        release: () => calls.push("release"),
      }),
    ).toThrow("spawn failed");
    expect(calls).toEqual(["start", "release"]);
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

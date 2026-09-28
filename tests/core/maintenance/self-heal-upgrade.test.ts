/**
 * The automatic Brain upgrade runs off the start-up path, records a failure
 * where an operator looks, and backs off instead of retrying on every start
 * (GitHub #216).
 *
 * The failure used here is a real one the snapshot step hits: a regular file
 * where `Brain/.snapshots/` should be a directory, so the pre-apply snapshot
 * (and with it the whole upgrade) cannot proceed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { brainDirs, brainManualPath } from "../../../src/core/brain/paths.ts";
import { planUpgrade } from "../../../src/core/brain/upgrade.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  ensureVaultCurrent,
  SELF_HEAL_UPGRADE_SPAWN,
} from "../../../src/core/maintenance/ensure-current.ts";
import {
  runSelfHealUpgrade,
  SELF_HEAL_UPGRADE_OUTCOME,
  SELF_HEAL_UPGRADE_SURFACE,
} from "../../../src/core/maintenance/self-heal-upgrade.ts";
import {
  checkSelfHealUpgrade,
  claimSelfHealUpgradeLock,
  selfHealUpgradeMarkerPath,
  readSelfHealUpgradeFailure,
  releaseSelfHealUpgradeLock,
  selfHealUpgradeLockPath,
  SELF_HEAL_UPGRADE_BASE_COOLDOWN_MS,
} from "../../../src/core/maintenance/self-heal-upgrade-state.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { waitForSelfHealChildren } from "../../helpers/self-heal-children.ts";

const HOUR = 60 * 60_000;
const T0 = new Date("2026-09-28T10:00:00.000Z");

let root: string;
let vault: string;
let configPath: string;
let prevConfigEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-self-heal-upgrade-"));
  vault = join(root, "vault");
  configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  prevConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  bootstrapBrain(vault, { configPath });
});

afterEach(async () => {
  await waitForSelfHealChildren(vault);
  if (prevConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = prevConfigEnv;
  rmSync(root, { recursive: true, force: true });
});

/** A detached worker releases the lock it was handed when it ends. */
async function waitForWorker(budgetMs = 60_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (existsSync(selfHealUpgradeLockPath(vault)) && Date.now() < deadline) {
    // Nothing in-process holds the detached worker; looking again is the
    // only way to learn it ended.
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(50);
  }
  if (existsSync(selfHealUpgradeLockPath(vault))) throw new Error("worker never released its lock");
}

function makeManualStale(): void {
  writeFileSync(brainManualPath(vault), "stale operator copy\n");
}

function breakSnapshots(): void {
  const snapshots = brainDirs(vault).snapshots;
  rmSync(snapshots, { recursive: true, force: true });
  writeFileSync(snapshots, "not a directory\n");
}

function repairSnapshots(): void {
  rmSync(brainDirs(vault).snapshots, { force: true });
}

function upgradeRows(): ReadonlyArray<Record<string, unknown>> {
  return listMetrics(vault, { surface: SELF_HEAL_UPGRADE_SURFACE }).map((r) => r.payload);
}

describe("a failed automatic upgrade", () => {
  test("is recorded with its error, the pending files and a retry time", () => {
    makeManualStale();
    breakSnapshots();

    const run = runSelfHealUpgrade(vault, { now: T0 });

    expect(run.outcome).toBe(SELF_HEAL_UPGRADE_OUTCOME.failed);
    const failure = readSelfHealUpgradeFailure(vault);
    expect(failure).not.toBeNull();
    expect(failure!.failedAt).toBe(T0.toISOString());
    expect(failure!.error).toContain(".snapshots");
    expect(failure!.pending).toEqual(["Brain/_BRAIN.md"]);
    expect(failure!.consecutiveFailures).toBe(1);
    expect(failure!.retryAfter).toBe(
      new Date(T0.getTime() + SELF_HEAL_UPGRADE_BASE_COOLDOWN_MS).toISOString(),
    );
    expect(readFileSync(brainManualPath(vault), "utf8")).toBe("stale operator copy\n");
    expect(upgradeRows().map((r) => r["outcome"])).toEqual([SELF_HEAL_UPGRADE_OUTCOME.failed]);
  });

  test("is not retried before its cooldown runs out", () => {
    makeManualStale();
    breakSnapshots();
    runSelfHealUpgrade(vault, { now: T0 });

    const again = runSelfHealUpgrade(vault, { now: new Date(T0.getTime() + HOUR / 2) });

    expect(again.outcome).toBe(SELF_HEAL_UPGRADE_OUTCOME.backoff);
    expect(readSelfHealUpgradeFailure(vault)!.consecutiveFailures).toBe(1);
    expect(upgradeRows()).toHaveLength(1);
  });

  test("is retried after the cooldown, and a repeat failure doubles it", () => {
    makeManualStale();
    breakSnapshots();
    runSelfHealUpgrade(vault, { now: T0 });
    const later = new Date(T0.getTime() + HOUR + 1);

    const again = runSelfHealUpgrade(vault, { now: later });

    expect(again.outcome).toBe(SELF_HEAL_UPGRADE_OUTCOME.failed);
    const failure = readSelfHealUpgradeFailure(vault)!;
    expect(failure.consecutiveFailures).toBe(2);
    expect(failure.retryAfter).toBe(new Date(later.getTime() + 2 * HOUR).toISOString());
  });

  test("is cleared by the retry that succeeds", () => {
    makeManualStale();
    breakSnapshots();
    runSelfHealUpgrade(vault, { now: T0 });
    repairSnapshots();

    const again = runSelfHealUpgrade(vault, { now: new Date(T0.getTime() + HOUR + 1) });

    expect(again.outcome).toBe(SELF_HEAL_UPGRADE_OUTCOME.applied);
    expect(again.filesUpdated).toEqual(["Brain/_BRAIN.md"]);
    expect(readSelfHealUpgradeFailure(vault)).toBeNull();
    expect(planUpgrade(vault).pending).toBe(0);
  });
});

function plantMarker(record: Record<string, unknown>): void {
  mkdirSync(dirname(selfHealUpgradeMarkerPath(vault)), { recursive: true });
  writeFileSync(selfHealUpgradeMarkerPath(vault), JSON.stringify(record));
}

describe("a failure marker this build did not write", () => {
  test("cannot hold the automatic upgrade off past the longest cooldown", () => {
    makeManualStale();
    plantMarker({
      failed_at: T0.toISOString(),
      error: "copied from another vault",
      consecutive_failures: 1,
      retry_after: "2099-01-01T00:00:00.000Z",
    });

    const run = runSelfHealUpgrade(vault, { now: new Date(T0.getTime() + 25 * HOUR) });

    expect(run.outcome).toBe(SELF_HEAL_UPGRADE_OUTCOME.applied);
  });

  test("reaches the doctor without its control characters", () => {
    plantMarker({
      failed_at: T0.toISOString(),
      error: "boom \u001b]0;title\u0007 \u001b[31mred",
      consecutive_failures: 1,
      retry_after: T0.toISOString(),
    });

    const check = checkSelfHealUpgrade(vault);

    expect(check.ok).toBe(false);
    expect(check.message).toContain("boom");
    // oxlint-disable-next-line no-control-regex -- asserting their absence is the point
    expect(check.message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe("the worker lock", () => {
  test("a second worker does not run while one holds the vault", () => {
    makeManualStale();
    const token = claimSelfHealUpgradeLock(vault, T0);
    expect(token).not.toBeNull();
    try {
      expect(runSelfHealUpgrade(vault, { now: T0 }).outcome).toBe(
        SELF_HEAL_UPGRADE_OUTCOME.running,
      );
      expect(planUpgrade(vault).pending).toBe(1);
      // The holder's own token is what lets the handed-over worker run.
      expect(runSelfHealUpgrade(vault, { now: T0, lockToken: token! }).outcome).toBe(
        SELF_HEAL_UPGRADE_OUTCOME.applied,
      );
    } finally {
      releaseSelfHealUpgradeLock(vault, token!);
    }
    expect(existsSync(selfHealUpgradeLockPath(vault))).toBe(false);
  });

  test("a claim older than the staleness ceiling is taken over", () => {
    expect(claimSelfHealUpgradeLock(vault, T0)).not.toBeNull();
    expect(claimSelfHealUpgradeLock(vault, new Date())).toBeNull();
    const muchLater = new Date(Date.now() + 2 * HOUR);
    const takeover = claimSelfHealUpgradeLock(vault, muchLater);
    expect(takeover).not.toBeNull();
    releaseSelfHealUpgradeLock(vault, takeover!);
  });
});

describe("ensureVaultCurrent in the background", () => {
  test("hands a pending upgrade to a detached worker instead of applying it inline", async () => {
    makeManualStale();

    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.brainUpgradeSpawn).toBe(SELF_HEAL_UPGRADE_SPAWN.spawned);
    expect(r.brainUpgraded).toEqual([]);
    await waitForWorker();
    expect(planUpgrade(vault).pending).toBe(0);
    expect(upgradeRows().map((row) => row["outcome"])).toEqual([SELF_HEAL_UPGRADE_OUTCOME.applied]);
  }, 60_000);

  test("starts nothing while a recorded failure is cooling down", async () => {
    makeManualStale();
    breakSnapshots();
    runSelfHealUpgrade(vault, { now: new Date() });

    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.brainUpgradeSpawn).toBe(SELF_HEAL_UPGRADE_SPAWN.skippedBackoff);
    expect(existsSync(selfHealUpgradeLockPath(vault))).toBe(false);
  });
});

function failOnce(): void {
  makeManualStale();
  breakSnapshots();
  runSelfHealUpgrade(vault, { now: T0 });
}

describe("operator surfaces after a failure", () => {
  test("`o2b brain upgrade --dry-run` shows the pending item and the last failure", async () => {
    failOnce();

    const r = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });

    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Brain/_BRAIN.md: update");
    expect(r.stdout).toContain(`automatic Brain upgrade failed at ${T0.toISOString()}`);
    expect(r.stdout).toContain(".snapshots");
  });

  test("`o2b doctor` reports the failure as a named check", async () => {
    failOnce();

    const r = await runCli(["doctor", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });

    const checks = JSON.parse(r.stdout).checks as Array<{
      name: string;
      ok: boolean;
      message: string;
      fix?: string;
    }>;
    const check = checks.find((c) => c.name === "self_heal_upgrade");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain(T0.toISOString());
    expect(check?.message).toContain(".snapshots");
    expect(check?.fix).toBe("o2b brain upgrade --dry-run");
  });

  test("`o2b brain status` lists it as a problem", async () => {
    failOnce();

    const r = await runCli(["brain", "status", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });

    expect(r.stdout).toContain("[self-heal-upgrade-failed]");
    expect(r.stdout).toContain(T0.toISOString());
    expect(r.stdout).toContain("-> next: o2b brain upgrade --dry-run");
  });

  test("an explicit `--apply` ignores the cooldown and clears the record", async () => {
    failOnce();
    repairSnapshots();

    const r = await runCli(["brain", "upgrade", "--vault", vault, "--apply", "--yes"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });

    expect(r.returncode).toBe(0);
    expect(readSelfHealUpgradeFailure(vault)).toBeNull();
    expect(planUpgrade(vault).pending).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { runBrainWatchdog } from "../../../src/core/brain/watchdog.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-watchdog-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function seedHealthyVault(): void {
  bootstrapBrain(vault);
  const indexPath = join(vault, ".open-second-brain", "brain.sqlite");
  mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
  writeFileSync(indexPath, "sqlite placeholder", "utf8");
}

describe("runBrainWatchdog", () => {
  test("reports healthy probes with backoff and audit metadata", () => {
    seedHealthyVault();

    const result = runBrainWatchdog(vault, {
      now: new Date("2026-05-30T12:00:00Z"),
      attempt: 2,
    });

    expect(result.report.ok).toBe(true);
    expect(result.report.counts.ok).toBeGreaterThanOrEqual(3);
    expect(result.backoff.next_delay_ms).toBe(4000);
    expect(result.audit_path).toContain("watchdog");
  });

  test("plans degraded probes without mutating by default", () => {
    bootstrapBrain(vault);
    rmSync(brainDirs(vault).inbox, { recursive: true, force: true });

    const result = runBrainWatchdog(vault, {
      now: new Date("2026-05-30T12:05:00Z"),
    });

    expect(result.report.ok).toBe(false);
    expect(result.remediation_plan).toContainEqual(
      expect.objectContaining({ action: "create-dir", target: "Brain/inbox" }),
    );
    expect(result.remediation_plan).toContainEqual(
      expect.objectContaining({
        action: "run-command",
        command: "o2b search reindex",
      }),
    );
    expect(existsSync(brainDirs(vault).inbox)).toBe(false);
  });

  test("reports wrong filesystem entry types as degraded", () => {
    bootstrapBrain(vault);
    rmSync(brainDirs(vault).log, { recursive: true, force: true });
    writeFileSync(brainDirs(vault).log, "not a directory", "utf8");
    const indexPath = join(vault, ".open-second-brain", "brain.sqlite");
    mkdirSync(indexPath, { recursive: true });

    const result = runBrainWatchdog(vault, {
      now: new Date("2026-05-30T12:07:00Z"),
    });

    expect(result.report.ok).toBe(false);
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ name: "dir:Brain/log", status: "warning" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ name: "search-index", status: "warning" }),
    );
  });

  test("executes only safe remediations when explicitly requested", () => {
    bootstrapBrain(vault);
    rmSync(brainDirs(vault).processed, { recursive: true, force: true });

    const result = runBrainWatchdog(vault, {
      remediate: true,
      now: new Date("2026-05-30T12:10:00Z"),
    });

    expect(result.applied_remediations).toContainEqual(
      expect.objectContaining({
        action: "create-dir",
        target: "Brain/inbox/processed",
      }),
    );
    expect(existsSync(brainDirs(vault).processed)).toBe(true);
  });

  test("refuses snapshot restore unless restore and force are explicit", () => {
    bootstrapBrain(vault);

    const refused = runBrainWatchdog(vault, {
      restoreRunId: "run-1",
      now: new Date("2026-05-30T12:15:00Z"),
    });
    expect(refused.restore.refused).toBe(true);
    expect(refused.report.checks).toContainEqual(
      expect.objectContaining({ name: "snapshot-restore", status: "critical" }),
    );

    const allowed = runBrainWatchdog(vault, {
      restoreRunId: "run-1",
      forceRestore: true,
      now: new Date("2026-05-30T12:16:00Z"),
    });
    expect(allowed.restore.refused).toBe(false);
    expect(allowed.restore.command).toBe("o2b brain rollback run-1 --yes --force-rollback");

    const invalid = runBrainWatchdog(vault, {
      restoreRunId: "run-1;rm",
      forceRestore: true,
      now: new Date("2026-05-30T12:17:00Z"),
    });
    expect(invalid.restore.refused).toBe(true);
    expect(invalid.restore.command).toBeUndefined();
  });
});

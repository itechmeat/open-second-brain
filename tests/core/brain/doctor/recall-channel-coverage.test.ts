/**
 * C1 - which silence is this.
 *
 * A "recall never fires" report is undiagnosable while a channel that
 * was never installed and a channel that runs and stays quiet produce
 * the same evidence: none. The check under test crosses an INSTALL state
 * against a DELIVERY count, so the assertions here are about the four
 * cells of that cross and, above all, about the one the wave exists for -
 * an install side that could not be READ must reach the uncertain
 * stream, never the clean one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import {
  RECALL_CHANNEL_COVERAGE_WINDOW_DAYS,
  RECALL_CHANNEL_SILENT_CODE,
  RECALL_CHANNEL_UNMEASURED_CODE,
  recallChannelCoverageCheck,
} from "../../../../src/core/brain/doctor/recall-channel-coverage.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import { DOCTOR_EXIT_EXCLUSIONS } from "../../../../src/core/brain/doctor-exits.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { hookAuditDir } from "../../../../src/core/brain/paths.ts";
import {
  emitRecallTelemetry,
  RECALL_CHANNEL,
  type RecallChannel,
} from "../../../../src/core/brain/recall-telemetry.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

/** Pinned so the delivery window below is arithmetic, not wall clock. */
const NOW = new Date("2026-06-01T00:00:00.000Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recall-channel-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-recall-channel-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

/** Where the delivery side reads its records from. */
function continuityDir(): string {
  return join(vault, "Brain", "log", "continuity");
}

afterEach(() => {
  for (const dir of [hookAuditDir(vault), continuityDir()]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // The directory may never have been created; nothing to restore.
    }
  }
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Rewrite the config with the recall-inject gate set to `enabled`. */
function setRecallInject(enabled: boolean): void {
  atomicWriteFileSync(configPath, `vault: ${vault}\nrecall_inject_enabled: "${enabled}"\n`);
}

/** One delivery on `channel`, `daysAgo` before the pinned clock. */
function deliver(channel: RecallChannel, daysAgo: number): void {
  const at = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  emitRecallTelemetry(vault, {
    createdAt: at.toISOString(),
    host: "unit-test",
    channel,
    mode: "search",
    status: "ok",
    durationMs: 1,
    resultCount: 1,
  });
}

interface RunResult {
  readonly issues: ReadonlyArray<DoctorIssue>;
  readonly uncertain: ReadonlyArray<DoctorUncertainEntry>;
}

function run(): RunResult {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  recallChannelCoverageCheck.run({ vault, now: NOW, configPath } as unknown as DoctorCheckContext, {
    issues,
    uncertain,
  });
  return { issues, uncertain };
}

function silentChannels(result: RunResult): ReadonlyArray<string> {
  return result.issues
    .filter((issue) => issue.code === RECALL_CHANNEL_SILENT_CODE)
    .map((issue) => issue.target ?? "")
    .toSorted();
}

describe("recall channel coverage", () => {
  test("the check never fails the pass", () => {
    // Everything it reads is optional evidence, so a throw here would
    // cost the report every finding after it.
    expect(recallChannelCoverageCheck.failSoft).toBe(true);
  });

  test("an enabled hook that has delivered nothing is a warning naming the channel", () => {
    setRecallInject(true);
    mkdirSync(hookAuditDir(vault), { recursive: true });

    const result = run();
    expect(silentChannels(result)).toEqual([RECALL_CHANNEL.hook]);
    const issue = result.issues.find((i) => i.code === RECALL_CHANNEL_SILENT_CODE)!;
    expect(issue.severity).toBe("warning");
    expect(issue.message).toContain(String(RECALL_CHANNEL_COVERAGE_WINDOW_DAYS));
    expect(result.uncertain).toEqual([]);
  });

  test("an enabled hook that has delivered inside the window is clean", () => {
    setRecallInject(true);
    mkdirSync(hookAuditDir(vault), { recursive: true });
    deliver(RECALL_CHANNEL.hook, 1);

    const result = run();
    expect(silentChannels(result)).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("a delivery older than the window does not count as coverage", () => {
    setRecallInject(true);
    mkdirSync(hookAuditDir(vault), { recursive: true });
    deliver(RECALL_CHANNEL.hook, RECALL_CHANNEL_COVERAGE_WINDOW_DAYS + 5);

    expect(silentChannels(run())).toEqual([RECALL_CHANNEL.hook]);
  });

  test("a hook nobody enabled is not expected to deliver, so silence is clean", () => {
    setRecallInject(false);
    expect(silentChannels(run())).toEqual([]);
    expect(run().uncertain).toEqual([]);
  });

  test("mcp and cli are per-call opt-ins, so their silence is never a warning", () => {
    // Neither has a persisted install fact: the caller passes `telemetry`
    // per request. Reporting their silence would be reporting that nobody
    // asked, which is not a defect and not a repair anyone can perform.
    setRecallInject(true);
    mkdirSync(hookAuditDir(vault), { recursive: true });
    deliver(RECALL_CHANNEL.hook, 1);

    const result = run();
    expect(silentChannels(result)).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("an unreadable install side is uncertain, never clean", () => {
    setRecallInject(true);
    const audit = hookAuditDir(vault);
    mkdirSync(audit, { recursive: true });
    chmodSync(audit, 0o000);

    const result = run();
    // Not a warning: the check cannot claim the hook is silent when it
    // could not establish whether the hook is installed at all.
    expect(silentChannels(result)).toEqual([]);
    const entry = result.uncertain.find((e) => e.code === RECALL_CHANNEL_UNMEASURED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain(RECALL_CHANNEL.hook);
  });

  test("an unreadable delivery store is uncertain, and does not erase the whole check", () => {
    // The delivery rollup used to run unguarded ahead of the per-channel
    // loop, and the check is registered `failSoft`, so a store this pass
    // could not open dropped EVERY finding - neither a silent channel nor
    // an unmeasured one, which is exactly the undiagnosable silence this
    // check exists to remove.
    setRecallInject(true);
    mkdirSync(hookAuditDir(vault), { recursive: true });
    deliver(RECALL_CHANNEL.hook, 1);
    chmodSync(continuityDir(), 0o000);

    const result = run();
    // Not a warning: a delivery count that could not be read cannot tell
    // a silent channel from a working one.
    expect(silentChannels(result)).toEqual([]);
    const entry = result.uncertain.find((e) => e.code === RECALL_CHANNEL_UNMEASURED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain(RECALL_CHANNEL.hook);
    expect(entry!.message.toLowerCase()).toContain("permission denied");
  });

  test("an install side that could not be read outranks a delivery side that could not either", () => {
    // Both halves gone. The install reason is the one an operator acts
    // on, and the entry must not claim the delivery count is readable.
    setRecallInject(true);
    const audit = hookAuditDir(vault);
    mkdirSync(audit, { recursive: true });
    deliver(RECALL_CHANNEL.hook, 1);
    chmodSync(audit, 0o000);
    chmodSync(continuityDir(), 0o000);

    const result = run();
    expect(silentChannels(result)).toEqual([]);
    const entry = result.uncertain.find((e) => e.code === RECALL_CHANNEL_UNMEASURED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain(audit);
    expect(entry!.message).not.toContain("delivery count is readable");
  });

  test("both codes are classified on exactly one side of the exit census", () => {
    expect(DIAGNOSTIC_SIGNALS.has(RECALL_CHANNEL_SILENT_CODE)).toBe(true);
    expect(DOCTOR_EXIT_EXCLUSIONS.has(RECALL_CHANNEL_SILENT_CODE)).toBe(false);
    expect(DOCTOR_EXIT_EXCLUSIONS.has(RECALL_CHANNEL_UNMEASURED_CODE)).toBe(true);
    expect(DIAGNOSTIC_SIGNALS.has(RECALL_CHANNEL_UNMEASURED_CODE)).toBe(false);
  });
});

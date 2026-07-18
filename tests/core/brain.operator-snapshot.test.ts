/**
 * Tests for src/core/brain/operator-snapshot.ts - the unified operator
 * status snapshot (O3, t_9f9c5466).
 *
 * A healthy vault snapshots to an all-clear; a vault with detected issues
 * produces problem lines, each carrying the exact next command supplied by
 * the O2 diagnostics-signal registry (never hardcoded in the renderer).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOperatorSnapshot,
  renderOperatorSnapshot,
} from "../../src/core/brain/operator-snapshot.ts";
import { resolveSignal } from "../../src/core/brain/diagnostics.ts";
import { brainConfigPath, brainDirs } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-snapshot-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(brainConfigPath(tmp), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildOperatorSnapshot", () => {
  test("a clean vault snapshots to all-clear with no problems", async () => {
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(snap.healthy).toBe(true);
    expect(snap.problems).toEqual([]);
    expect(snap.stateFiles.config).toBe(true);
    const text = renderOperatorSnapshot(snap);
    expect(text).toContain("all clear");
    expect(text).not.toContain("Problems:");
  });

  test("a dangling workrun surfaces a doctor-warning problem with a next command", async () => {
    const runs = join(tmp, "Brain", "log", "dream-runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(runs, "run-x.jsonl"),
      JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: "run-x" }) + "\n",
      "utf8",
    );
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(snap.healthy).toBe(false);
    const dw = snap.problems.find((p) => p.code === "doctor-warnings");
    expect(dw).toBeDefined();
    // The hint travels with the signal definition, not the formatter.
    expect(dw!.nextCommand).toBe(resolveSignal("doctor-warnings").nextCommand);
    const text = renderOperatorSnapshot(snap);
    expect(text).toContain("Problems:");
    expect(text).toContain(`-> next: ${dw!.nextCommand}`);
  });

  test("a missing config surfaces a state-file problem", async () => {
    rmSync(brainConfigPath(tmp), { force: true });
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    expect(snap.stateFiles.config).toBe(false);
    const sf = snap.problems.find((p) => p.code === "state-file");
    expect(sf).toBeDefined();
    expect(sf!.nextCommand).toBe("o2b brain init");
  });

  test("every problem line's next command matches its signal definition", async () => {
    const runs = join(tmp, "Brain", "log", "dream-runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(runs, "run-y.jsonl"),
      JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: "run-y" }) + "\n",
      "utf8",
    );
    const snap = await buildOperatorSnapshot(tmp, { now: new Date("2026-07-18T12:00:00Z") });
    for (const p of snap.problems) {
      expect(p.nextCommand).toBe(resolveSignal(p.code).nextCommand);
      expect(p.nextCommand.startsWith("o2b ")).toBe(true);
    }
  });
});

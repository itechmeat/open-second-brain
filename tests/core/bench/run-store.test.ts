/**
 * Bench run store (Memory Observability Suite, t_882c396a):
 * checkpointed runs under a runs directory, resume by run id, fixture
 * hash validation, and a path guard that refuses to operate outside
 * the runs directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBenchFixture } from "../../../src/core/bench/fixture.ts";
import {
  benchVaultDir,
  completeBenchPhase,
  createBenchRun,
  loadBenchRun,
} from "../../../src/core/bench/run-store.ts";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "o2b-bench-runs-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

const FIXTURE = parseBenchFixture({
  name: "mini",
  notes: [{ path: "Brain/notes/a.md", body: "alpha" }],
  questions: [
    {
      id: "q1",
      category: "single_hop",
      query: "alpha",
      expected_paths: ["Brain/notes/a.md"],
    },
  ],
});

describe("bench run store", () => {
  test("createBenchRun writes a checkpoint and loadBenchRun round-trips it", () => {
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    expect(run.runId).toStartWith("run-20260603120000-");
    expect(existsSync(join(run.runDir, "checkpoint.json"))).toBe(true);
    expect(run.checkpoint.completed_phases).toEqual([]);

    const loaded = loadBenchRun(runsDir, run.runId);
    expect(loaded.checkpoint.run_id).toBe(run.runId);
    expect(loaded.checkpoint.fixture_name).toBe("mini");
    expect(benchVaultDir(loaded.runDir)).toBe(join(loaded.runDir, "vault"));
  });

  test("completeBenchPhase persists progress exactly once per phase", () => {
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    const afterIngest = completeBenchPhase(run.runDir, run.checkpoint, "ingest");
    expect(afterIngest.completed_phases).toEqual(["ingest"]);
    const again = completeBenchPhase(run.runDir, afterIngest, "ingest");
    expect(again.completed_phases).toEqual(["ingest"]);
    const reloaded = loadBenchRun(runsDir, run.runId);
    expect(reloaded.checkpoint.completed_phases).toEqual(["ingest"]);
  });

  test("a fixture-hash mismatch invalidates resume instead of mixing runs", () => {
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    const changed = parseBenchFixture({
      name: "mini",
      notes: [{ path: "Brain/notes/a.md", body: "CHANGED" }],
      questions: [
        {
          id: "q1",
          category: "single_hop",
          query: "alpha",
          expected_paths: ["Brain/notes/a.md"],
        },
      ],
    });
    expect(() => loadBenchRun(runsDir, run.runId, { expectFixture: changed })).toThrow("hash");
  });

  test("unknown run ids and path-escaping ids are rejected", () => {
    expect(() => loadBenchRun(runsDir, "run-nope")).toThrow();
    expect(() => loadBenchRun(runsDir, "../escape")).toThrow();
  });
});

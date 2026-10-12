/**
 * Bench run store (Memory Observability Suite, t_882c396a):
 * checkpointed runs under a runs directory, resume by run id, fixture
 * hash validation, and a path guard that refuses to operate outside
 * the runs directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBenchFixture } from "../../../src/core/bench/fixture.ts";
import {
  benchVaultDir,
  completeBenchPhase,
  createBenchRun,
  loadBenchRun,
} from "../../../src/core/bench/run-store.ts";
import type { BenchPinnedKnobs } from "../../../src/core/bench/types.ts";

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

  test("two runs with different knob pins get different run ids", () => {
    const pinA: BenchPinnedKnobs = { semantic: { enabled: false } };
    const pinB: BenchPinnedKnobs = { semantic: { enabled: false }, keywordWeight: 0.6 };
    const now = new Date("2026-06-03T12:00:00Z");
    const a = createBenchRun(runsDir, FIXTURE, { now, pinnedKnobs: pinA });
    const b = createBenchRun(runsDir, FIXTURE, { now, pinnedKnobs: pinB });
    // Same fixture, same second, different pin: the ids must not collide.
    expect(a.runId).not.toBe(b.runId);
  });

  test("the checkpoint carries the pinned knobs and the identity hash", () => {
    const pin: BenchPinnedKnobs = { semantic: { enabled: false }, keywordWeight: 0.6 };
    const run = createBenchRun(runsDir, FIXTURE, {
      now: new Date("2026-06-03T12:00:00Z"),
      pinnedKnobs: pin,
    });
    expect(run.checkpoint.pinned_knobs).toEqual(pin);
    expect(run.checkpoint.knobs_hash).toBeDefined();
    const reloaded = loadBenchRun(runsDir, run.runId);
    expect(reloaded.checkpoint.pinned_knobs).toEqual(pin);
    expect(reloaded.checkpoint.knobs_hash).toBe(run.checkpoint.knobs_hash);
  });

  test("resume with the same pin passes the guard, a changed pin fails it", () => {
    const pin: BenchPinnedKnobs = { semantic: { enabled: false } };
    const run = createBenchRun(runsDir, FIXTURE, {
      now: new Date("2026-06-03T12:00:00Z"),
      pinnedKnobs: pin,
    });
    const same = loadBenchRun(runsDir, run.runId, { expectFixture: FIXTURE, pinnedKnobs: pin });
    expect(same.runId).toBe(run.runId);
    expect(() =>
      loadBenchRun(runsDir, run.runId, {
        expectFixture: FIXTURE,
        pinnedKnobs: { semantic: { enabled: false }, keywordWeight: 0.5 },
      }),
    ).toThrow(/run identity mismatch/);
  });

  test("an all-dots run id is refused", () => {
    // "." passes the run-id charset and resolves inside the runs dir, so
    // a resume with it would write the checkpoint beside the shared cache.
    expect(() => loadBenchRun(runsDir, ".", {})).toThrow(/all dots/);
    expect(() => loadBenchRun(runsDir, "..", {})).toThrow(/all dots/);
  });

  test("a resume whose recall floor changed fails the identity guard", () => {
    const run = createBenchRun(runsDir, FIXTURE, {
      now: new Date("2026-06-03T12:00:00Z"),
      recallFloor: 0.4,
    });
    const same = loadBenchRun(runsDir, run.runId, {
      expectFixture: FIXTURE,
      recallFloor: 0.4,
    });
    expect(same.runId).toBe(run.runId);
    expect(() =>
      loadBenchRun(runsDir, run.runId, { expectFixture: FIXTURE, recallFloor: 0.5 }),
    ).toThrow(/run identity mismatch/);
  });

  test("a checkpoint that predates knob pinning fails resume loudly", () => {
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    // What an in-flight checkpoint written before knob pinning looks like.
    const path = join(run.runDir, "checkpoint.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete legacy["pinned_knobs"];
    delete legacy["knobs_hash"];
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    expect(() => loadBenchRun(runsDir, run.runId, { expectFixture: FIXTURE })).toThrow(
      /predates knob pinning/,
    );
  });
});

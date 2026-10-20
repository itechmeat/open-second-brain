/**
 * Bench-run integrity guards (t_d7ce8baf): the refusal vocabulary, the
 * pre-run preflight (P1-P7) and the pre-report trace validation (T1-T7),
 * each on hand-built fixtures.
 *
 * The doctrine the guards serve: a degraded run must neither CREATE state
 * (orphan run directories) nor PUBLISH scores (plausible-looking reports
 * off a tampered trace), and an all-questions-failed run stays a
 * legitimate benchmark outcome - score CONTENT never triggers refusal,
 * only structural damage does. Present-but-empty trace fields are
 * legitimate misses; absent ones are not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BENCH_REFUSAL,
  BENCH_REFUSAL_KINDS,
  BenchRefusalError,
  countQuestionResults,
  preflightBenchRun,
  validateBenchTrace,
} from "../../../src/core/bench/guards.ts";
import { fixtureHash, parseBenchFixture } from "../../../src/core/bench/fixture.ts";
import { completeBenchPhase, createBenchRun } from "../../../src/core/bench/run-store.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import type {
  BenchFixture,
  BenchQuestionResult,
  BenchReport,
} from "../../../src/core/bench/types.ts";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "o2b-bench-guards-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

const FIXTURE = parseBenchFixture({
  name: "guards",
  notes: [{ path: "Brain/notes/a.md", body: "alpha note body" }],
  continuity: [
    {
      kind: "session_turn",
      created_at: "2026-06-01T10:00:00.000Z",
      payload: { session_id: "s-1", turn_id: "t-1", role: "user", text: "hello" },
    },
  ],
  questions: [
    {
      id: "q1",
      category: "single_hop",
      query: "alpha",
      expected_paths: ["Brain/notes/a.md"],
    },
    {
      id: "q-handoff",
      category: "session_handoff",
      session_id: "s-1",
      expected_turns: 1,
    },
  ],
});

/** A checkpoint file, written the way the pipeline writes it. */
function writeCheckpoint(runId: string, phases: string[], fixture: BenchFixture = FIXTURE): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const checkpoint = {
    run_id: runId,
    fixture_name: fixture.name,
    fixture_hash: fixtureHash(fixture),
    pinned_knobs: { semantic: { enabled: false } },
    knobs_hash: "0123456789abcdef0123456789abcdef",
    created_at: "2026-06-03T12:00:00.000Z",
    completed_phases: phases,
  };
  writeFileSync(join(runDir, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);
  return runDir;
}

/** Materialize the disposable vault a completed ingest phase promises. */
function writeVault(runDir: string, fixture: BenchFixture = FIXTURE): void {
  mkdirSync(join(runDir, "vault", "Brain", "notes"), { recursive: true });
  for (const note of fixture.notes) {
    writeFileSync(join(runDir, "vault", note.path), note.body);
  }
}

/** A hand-built passing report the counts helper must agree with. */
function handReport(quality: BenchReport["quality"]): BenchReport {
  return {
    schema: "o2b.bench.v2",
    run_id: "run-x",
    fixture: "guards",
    fixture_hash: "0123456789abcdef",
    created_at: "2026-06-03T12:00:00.000Z",
    quality,
    latency_ms: { avg: 1, max: 1 },
    context_cost: { avg_chars: 0, avg_injected_tokens: 0 },
    failure_modes: {
      know_to_ask_failure_rate: 0,
      false_fire_rate: 0,
      source_isolation_violations: 0,
    },
    judge: { status: "skipped" },
    questions: [],
  } as BenchReport;
}

describe("the BENCH_REFUSAL vocabulary", () => {
  test("the table is frozen, closed, and every kind renders through the error", () => {
    expect(Object.isFrozen(BENCH_REFUSAL)).toBe(true);
    expect(Object.isFrozen(BENCH_REFUSAL_KINDS)).toBe(true);
    // One member per P1-P7 / T1-T7 state the recon names.
    expect([...BENCH_REFUSAL_KINDS].toSorted()).toEqual([
      "checkpoint_fixture_mismatch",
      "checkpoint_phase_order",
      "checkpoint_phase_unknown",
      "checkpoint_unparseable",
      "fixture_cross_reference",
      "report_counts_mismatch",
      "run_artifact_missing",
      "run_dir_exists",
      "runs_dir_unusable",
      "trace_extra_results",
      "trace_faulted_decisions",
      "trace_field_absent",
      "trace_id_mismatch",
      "trace_result_missing",
      "trace_result_unparseable",
    ]);
    const error = new BenchRefusalError(BENCH_REFUSAL.runDirExists, "already there");
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe("run_dir_exists");
    expect(error.detail).toBe("already there");
    expect(error.message).toBe("refused (run_dir_exists): already there");
  });
});

describe("preflightBenchRun", () => {
  test("a traversal resume id is refused by name before any checkpoint read", () => {
    // Findings 30: the preflight used to join and READ
    // `<runsDir>/<resume>/checkpoint.json` before any run-id guard ran, so
    // `--resume ..` answered with whatever parse error the PARENT
    // directory's checkpoint.json carries. The bait sits exactly at the
    // path the unguarded join used to read.
    const root = join(runsDir, "root");
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(root, "checkpoint.json"), "{not json");
    try {
      preflightBenchRun({ runsDir: runs, fixture: FIXTURE, resume: ".." });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const message = (e as Error).message;
      // Refused BY NAME - the id - never by the parent file's parse error.
      expect(message).toContain("..");
      expect(message).toMatch(/all dots|unsafe characters|escapes the runs dir/);
      expect(message).not.toContain("checkpoint_unparseable");
    }
    // The charset arm: a path-escaping id is refused by name too.
    try {
      preflightBenchRun({ runsDir: runs, fixture: FIXTURE, resume: "../escape" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("../escape");
      expect(message).toContain("unsafe characters");
      expect(message).not.toContain("checkpoint_unparseable");
    }
  });

  test("a healthy fresh run and a healthy resume pass silently", () => {
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    writeVault(run.runDir);
    completeBenchPhase(run.runDir, run.checkpoint, "ingest");
    // Fresh: the collision check needs the id the caller is about to create.
    expect(() =>
      preflightBenchRun({ runsDir, fixture: FIXTURE, freshRunId: "run-20260603120001-abc123" }),
    ).not.toThrow();
    // Resume: the claimed phases have their artifacts.
    expect(() => preflightBenchRun({ runsDir, fixture: FIXTURE, resume: run.runId })).not.toThrow();
  });

  test("an unwritable runs directory is refused before anything is created", () => {
    // A FILE where the runs dir belongs: mkdir fails whatever the user.
    const blocker = join(runsDir, "blocked");
    writeFileSync(blocker, "not a directory");
    try {
      preflightBenchRun({ runsDir: blocker, fixture: FIXTURE, freshRunId: "run-x" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(BenchRefusalError);
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("runs_dir_unusable");
      expect(refusal.detail).toContain(blocker);
      expect(refusal.detail).toContain("--runs-dir");
    }
    expect(existsSync(join(blocker, "run-x"))).toBe(false);
  });

  describe("a chmod-read-only runs directory", () => {
    // chmod cannot build this denial on root or on Windows; the shared
    // platform fact names that once, and the deny-guard census reads it.
    const gatedTest = test.skipIf(CHMOD_CANNOT_DENY);
    gatedTest("is refused by the writability probe", () => {
      const readOnly = join(runsDir, "read-only");
      mkdirSync(readOnly);
      chmodSync(readOnly, 0o555);
      try {
        preflightBenchRun({ runsDir: readOnly, fixture: FIXTURE, freshRunId: "run-x" });
        throw new Error("expected the preflight to refuse");
      } catch (e) {
        expect((e as BenchRefusalError).kind).toBe("runs_dir_unusable");
      } finally {
        chmodSync(readOnly, 0o755);
      }
    });
  });

  test("a fresh-run collision is refused naming --resume, and the prior checkpoint survives", () => {
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    const before = readFileSync(join(run.runDir, "checkpoint.json"), "utf8");
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, freshRunId: run.runId });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("run_dir_exists");
      expect(refusal.detail).toContain(run.runId);
      expect(refusal.detail).toContain(`--resume ${run.runId}`);
    }
    // The collision left the prior run exactly as it was.
    expect(readFileSync(join(run.runDir, "checkpoint.json"), "utf8")).toBe(before);
  });

  test("resuming the colliding run itself is not a collision", () => {
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    expect(() =>
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: run.runId, freshRunId: run.runId }),
    ).not.toThrow();
  });

  test("a corrupt checkpoint on resume is refused naming the file", () => {
    const runDir = writeCheckpoint("run-broken", []);
    writeFileSync(join(runDir, "checkpoint.json"), "{not json");
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-broken" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("checkpoint_unparseable");
      expect(refusal.detail).toContain(join(runDir, "checkpoint.json"));
    }
  });

  test("a checkpoint that parses but lacks required fields is refused as unparseable", () => {
    // M11: {"completed_phases":["ingest"]} passes P3's JSON-object and
    // phases-array checks (and P5 when the artifacts happen to exist), and
    // used to explode later in parseCheckpoint as a plain Error the verb
    // does not catch - a source frame where the contract promises
    // `refused (checkpoint_unparseable)`. The preflight now runs the SAME
    // parser, so the refusal names the file and the missing fields.
    const runDir = join(runsDir, "run-minimal");
    mkdirSync(join(runDir, "vault", "Brain", "notes"), { recursive: true });
    writeFileSync(join(runDir, "vault", "Brain", "notes", "a.md"), "alpha note body");
    writeFileSync(
      join(runDir, "checkpoint.json"),
      `${JSON.stringify({ completed_phases: ["ingest"] })}\n`,
    );
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-minimal" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal).toBeInstanceOf(BenchRefusalError);
      expect(refusal.kind).toBe("checkpoint_unparseable");
      expect(refusal.detail).toContain(join(runDir, "checkpoint.json"));
      expect(refusal.detail).toContain("run_id");
    }
    // The empty-phases shape passes P3 AND P5 entirely; the parser gate is
    // what refuses it, so the run never reaches the raw load error.
    writeFileSync(join(runDir, "checkpoint.json"), `${JSON.stringify({ completed_phases: [] })}\n`);
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-minimal" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      expect((e as BenchRefusalError).kind).toBe("checkpoint_unparseable");
    }
    // A checkpoint with the full shape the parser requires still passes.
    const healthy = writeCheckpoint("run-full-shape", ["ingest"]);
    writeVault(healthy);
    expect(() =>
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-full-shape" }),
    ).not.toThrow();
  });

  test("a checkpoint whose completed_phases is not a string array is refused", () => {
    writeCheckpoint("run-shape", "ingest" as unknown as string[]);
    expect(() => preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-shape" })).toThrow(
      /checkpoint/,
    );
  });

  test("an unknown phase name is refused as written by a different build", () => {
    writeCheckpoint("run-future", ["ingest", "quantum_phase"]);
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-future" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("checkpoint_phase_unknown");
      expect(refusal.detail).toContain("quantum_phase");
      expect(refusal.detail).toContain("different build");
    }
  });

  test("out-of-order and duplicate completed phases are refused", () => {
    writeCheckpoint("run-swapped", ["retrieve", "ingest"]);
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-swapped" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      expect((e as BenchRefusalError).kind).toBe("checkpoint_phase_order");
    }
    writeCheckpoint("run-duped", ["ingest", "ingest"]);
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-duped" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      expect((e as BenchRefusalError).kind).toBe("checkpoint_phase_order");
    }
  });

  test("resuming with a different fixture is refused as a fixture mismatch naming the repair", () => {
    // The run directory matches its own checkpoint; only the fixture given
    // to THIS resume differs - an edited copy of the same fixture. The
    // preflight refuses by name with the seed-aware repair, and the run
    // directory is never condemned as tampered.
    const runDir = writeCheckpoint("run-fixture", ["ingest"]);
    writeVault(runDir);
    const raw = JSON.parse(JSON.stringify(FIXTURE)) as {
      notes: Array<{ path: string; body: string }>;
    };
    raw.notes[0]!.body = "an edited body under the same path";
    const edited = parseBenchFixture(raw);
    try {
      preflightBenchRun({ runsDir, fixture: edited, resume: "run-fixture" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("checkpoint_fixture_mismatch");
      expect(refusal.detail).toContain(join(runDir, "checkpoint.json"));
      expect(refusal.detail).toContain(fixtureHash(FIXTURE));
      expect(refusal.detail).toContain(fixtureHash(edited));
      expect(refusal.detail).toContain("same fixture, seed and cap");
    }
  });

  test("a fixture mismatch is named before the artifact check on a damaged run", () => {
    // The misreport the fix removes: an interrupted run resumed under a
    // different fixture used to fail P5 first - `run_artifact_missing`
    // ... "tampered with or truncated; start a fresh run" - repair advice
    // that discards a run perfectly healthy under its own fixture.
    writeCheckpoint("run-mismatch", ["ingest"]);
    const raw = JSON.parse(JSON.stringify(FIXTURE)) as {
      notes: Array<{ path: string; body: string }>;
    };
    raw.notes[0]!.body = "an edited body under the same path";
    const edited = parseBenchFixture(raw);
    try {
      preflightBenchRun({ runsDir, fixture: edited, resume: "run-mismatch" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("checkpoint_fixture_mismatch");
      expect(refusal.kind).not.toBe("run_artifact_missing");
    }
  });

  test("ingest-done with the vault deleted is refused before any scoring", () => {
    // The dangerous tamper: retrieval against the emptied vault would
    // score an empty corpus and publish ordinary FAILs.
    const runDir = writeCheckpoint("run-tampered", ["ingest"]);
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-tampered" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("run_artifact_missing");
      expect(refusal.detail).toContain(join(runDir, "vault"));
      expect(refusal.detail).toContain("fresh run");
    }
  });

  test("ingest-done with a fixture note missing from the vault is refused by path", () => {
    const runDir = writeCheckpoint("run-partial-vault", ["ingest"]);
    writeVault(runDir);
    rmSync(join(runDir, "vault", "Brain", "notes", "a.md"));
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-partial-vault" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("run_artifact_missing");
      expect(refusal.detail).toContain("Brain/notes/a.md");
    }
  });

  test("a finished run stays resumable with the disposable vault deleted", () => {
    // The doctrine the resume test pins: evaluate works only from the
    // persisted results, so a completed run does not need the vault.
    const runDir = writeCheckpoint("run-done", [
      "ingest",
      "index",
      "retrieve",
      "evaluate",
      "report",
    ]);
    writeVault(runDir);
    mkdirSync(join(runDir, "results"), { recursive: true });
    for (const question of FIXTURE.questions) {
      writeFileSync(
        join(runDir, "results", `${question.id}.json`),
        `${JSON.stringify({ id: question.id, latency_ms: 1 })}\n`,
      );
    }
    writeFileSync(join(runDir, "report.json"), "{}\n");
    rmSync(join(runDir, "vault"), { recursive: true, force: true });
    expect(() =>
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-done" }),
    ).not.toThrow();
  });

  test("retrieve-done with the results deleted is refused by name", () => {
    const runDir = writeCheckpoint("run-no-results", ["ingest", "index", "retrieve"]);
    writeVault(runDir);
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-no-results" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("run_artifact_missing");
      expect(refusal.detail).toContain(join(runDir, "results"));
    }
  });

  test("report-done without report.json is refused by name", () => {
    const runDir = writeCheckpoint("run-no-report", [
      "ingest",
      "index",
      "retrieve",
      "evaluate",
      "report",
    ]);
    writeVault(runDir);
    mkdirSync(join(runDir, "results"), { recursive: true });
    for (const question of FIXTURE.questions) {
      writeFileSync(join(runDir, "results", `${question.id}.json`), "{}\n");
    }
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: "run-no-report" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("run_artifact_missing");
      expect(refusal.detail).toContain("report.json");
    }
  });

  test("an expected_path naming a nonexistent note is refused naming the question", () => {
    const bad = parseBenchFixture({
      name: "bad-xref",
      notes: [{ path: "Brain/notes/a.md", body: "alpha note body" }],
      questions: [
        {
          id: "q-bad",
          category: "single_hop",
          query: "alpha",
          expected_paths: ["Brain/notes/never-materialized.md"],
        },
      ],
    });
    try {
      preflightBenchRun({ runsDir, fixture: bad, freshRunId: "run-x" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("fixture_cross_reference");
      expect(refusal.detail).toContain("q-bad");
      expect(refusal.detail).toContain("Brain/notes/never-materialized.md");
    }
  });

  test("a not_expected_above path naming a nonexistent note is refused too", () => {
    const bad = parseBenchFixture({
      name: "bad-stale-xref",
      notes: [{ path: "Brain/notes/a.md", body: "alpha note body" }],
      questions: [
        {
          id: "q-stale",
          category: "temporal",
          query: "alpha",
          expected_paths: ["Brain/notes/a.md"],
          not_expected_above: ["Brain/notes/ghost.md"],
        },
      ],
    });
    expect(() => preflightBenchRun({ runsDir, fixture: bad, freshRunId: "run-x" })).toThrow(
      /q-stale.*Brain\/notes\/ghost\.md|Brain\/notes\/ghost\.md.*q-stale/s,
    );
  });

  test("a session_handoff question naming an unknown session is refused naming the value", () => {
    const bad = parseBenchFixture({
      name: "bad-session-xref",
      notes: [{ path: "Brain/notes/a.md", body: "alpha note body" }],
      questions: [
        {
          id: "q-orphan",
          category: "session_handoff",
          session_id: "s-unknown",
        },
      ],
    });
    try {
      preflightBenchRun({ runsDir, fixture: bad, freshRunId: "run-x" });
      throw new Error("expected the preflight to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("fixture_cross_reference");
      expect(refusal.detail).toContain("q-orphan");
      expect(refusal.detail).toContain("s-unknown");
    }
  });

  test("the preflight adds zero stdout on success", () => {
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    writeVault(run.runDir);
    completeBenchPhase(run.runDir, run.checkpoint, "ingest");
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk?: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      preflightBenchRun({ runsDir, fixture: FIXTURE, resume: run.runId });
    } finally {
      process.stdout.write = original;
    }
    expect(writes).toEqual([]);
  });
});

/** Write one per-question trace record the way the builders do. */
function traceRecord(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ id: "q1", latency_ms: 1, ...fields }, null, 2)}\n`;
}

describe("validateBenchTrace", () => {
  /** A one-retrieval-question fixture with its results dir prepared. */
  function retrievalRun(recordBody: string, extraFile?: string): string {
    const runDir = join(runsDir, "run-trace");
    mkdirSync(join(runDir, "results"), { recursive: true });
    writeFileSync(join(runDir, "results", "q1.json"), recordBody);
    if (extraFile !== undefined) {
      writeFileSync(join(runDir, "results", extraFile), "{}\n");
    }
    return runDir;
  }

  const TRACE_FIXTURE = parseBenchFixture({
    name: "trace",
    notes: [{ path: "Brain/notes/a.md", body: "alpha note body" }],
    questions: [
      { id: "q1", category: "single_hop", query: "alpha", expected_paths: ["Brain/notes/a.md"] },
    ],
  });

  test("a healthy trace passes", () => {
    const runDir = retrievalRun(traceRecord({ paths: ["Brain/notes/a.md"] }));
    expect(() => validateBenchTrace({ runDir, fixture: TRACE_FIXTURE })).not.toThrow();
  });

  test("a missing result file is refused naming the question", () => {
    const runDir = retrievalRun("{}");
    rmSync(join(runDir, "results", "q1.json"));
    try {
      validateBenchTrace({ runDir, fixture: TRACE_FIXTURE });
      throw new Error("expected the trace validation to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("trace_result_missing");
      expect(refusal.detail).toContain("q1");
    }
  });

  test("a truncated result file is refused naming the file", () => {
    const runDir = retrievalRun('{"id": "q1", "laten');
    try {
      validateBenchTrace({ runDir, fixture: TRACE_FIXTURE });
      throw new Error("expected the trace validation to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("trace_result_unparseable");
      expect(refusal.detail).toContain(join(runDir, "results", "q1.json"));
    }
  });

  test("a record stored under the wrong question id is refused", () => {
    const runDir = retrievalRun(traceRecord({ id: "q-other", paths: [] }));
    try {
      validateBenchTrace({ runDir, fixture: TRACE_FIXTURE });
      throw new Error("expected the trace validation to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("trace_id_mismatch");
      expect(refusal.detail).toContain("q-other");
      expect(refusal.detail).toContain("q1");
    }
  });

  test("an extra result file beyond the fixture's questions is refused", () => {
    const runDir = retrievalRun(traceRecord({ paths: [] }), "q-leftover.json");
    try {
      validateBenchTrace({ runDir, fixture: TRACE_FIXTURE });
      throw new Error("expected the trace validation to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("trace_extra_results");
      expect(refusal.detail).toContain("q-leftover.json");
    }
  });

  test("an orphaned atomic-write temp does not make a crashed run unresumable", () => {
    // Finding 29: a SIGKILL between the atomic write and its rename leaves
    // `<id>.json.<pid>.tmp` in results/ (the rmSync cleanup only runs on a
    // thrown error), and T6 counting it as an extra refused the resumed
    // run - the crash recovery the atomic writes and resume exist for
    // demanded a manual rm first. The writer's own temp shape is exempt.
    const crashed = retrievalRun(traceRecord({ paths: [] }), "q1.json.424242.tmp");
    expect(() => validateBenchTrace({ runDir: crashed, fixture: TRACE_FIXTURE })).not.toThrow();
    // T6 still stands for real junk: any other leftover refuses.
    const leftover = retrievalRun(traceRecord({ paths: [] }), "q-leftover.json");
    try {
      validateBenchTrace({ runDir: leftover, fixture: TRACE_FIXTURE });
      throw new Error("expected the trace validation to refuse");
    } catch (e) {
      expect((e as BenchRefusalError).kind).toBe("trace_extra_results");
    }
  });

  test("each category family refuses an ABSENT required field but passes present-but-empty", () => {
    // (category, required field, the question, the record with the field
    // present but empty - the legitimate miss the guard must never
    // refuse.) Questions carry their category's parse-required shape.
    const families: ReadonlyArray<{
      category: string;
      field: string;
      question: Record<string, unknown>;
      presentButEmpty: unknown;
    }> = [
      {
        category: "single_hop",
        field: "paths",
        question: { query: "alpha", expected_paths: ["Brain/notes/a.md"] },
        presentButEmpty: [],
      },
      {
        category: "session_handoff",
        field: "turn_texts",
        question: { session_id: "s-1" },
        presentButEmpty: [],
      },
      {
        category: "budget",
        field: "item_ids",
        question: { expected_ids: ["x"] },
        presentButEmpty: [],
      },
      {
        category: "source_isolation",
        field: "item_ids",
        question: { agent_scope: "a", forbidden_ids: ["f"] },
        presentButEmpty: [],
      },
      {
        category: "proactive_recall",
        field: "recall_decision",
        question: { prompt: "p", expect_inject: true },
        presentButEmpty: { kind: "abstain", reason: "structural" },
      },
      {
        category: "write_fidelity",
        field: "labels",
        question: { intake_text: "text", expected_labels: ["label"] },
        presentButEmpty: [],
      },
      {
        category: "standing_instruction",
        field: "standing_items",
        question: {},
        presentButEmpty: [],
      },
    ];
    for (const { category, field, question, presentButEmpty } of families) {
      const fixture = parseBenchFixture({
        name: `trace-${category}`,
        notes: [{ path: "Brain/notes/a.md", body: "alpha note body" }],
        questions: [{ id: "q1", category, ...question } as never],
      });
      const runDir = join(runsDir, `run-${category}`);
      mkdirSync(join(runDir, "results"), { recursive: true });
      // Absent: the field is not in the record at all - structural damage
      // the evaluator would silently default into an ordinary FAIL.
      const absent: Record<string, unknown> = { id: "q1", latency_ms: 1 };
      writeFileSync(join(runDir, "results", "q1.json"), traceRecord(absent));
      let refusal: BenchRefusalError | undefined;
      try {
        validateBenchTrace({ runDir, fixture });
      } catch (e) {
        refusal = e as BenchRefusalError;
      }
      expect(`${category} absent ${field} refused: ${refusal?.kind}`).toBe(
        `${category} absent ${field} refused: trace_field_absent`,
      );
      expect(refusal!.detail).toContain(field);
      expect(refusal!.detail).toContain("q1");
      // Present but empty: a legitimate retrieval miss, never a refusal.
      writeFileSync(join(runDir, "results", "q1.json"), traceRecord({ [field]: presentButEmpty }));
      expect(() => validateBenchTrace({ runDir, fixture })).not.toThrow();
    }
  });

  test("a faulted proactive decision is refused with the fresh-run repair", () => {
    const fixture = parseBenchFixture({
      name: "trace-faulted",
      notes: [{ path: "Brain/notes/a.md", body: "alpha note body" }],
      questions: [{ id: "q1", category: "proactive_recall", prompt: "p", expect_inject: true }],
    });
    const runDir = join(runsDir, "run-faulted");
    mkdirSync(join(runDir, "results"), { recursive: true });
    writeFileSync(
      join(runDir, "results", "q1.json"),
      traceRecord({ recall_decision: { kind: "error", fault: "retrieval_error" } }),
    );
    try {
      validateBenchTrace({ runDir, fixture });
      throw new Error("expected the trace validation to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("trace_faulted_decisions");
      expect(refusal.detail).toContain("q1");
      expect(refusal.detail).toContain("retrieval_error");
      expect(refusal.detail).toContain("fresh run");
    }
  });

  test("a report whose counts disagree with its trace is refused", () => {
    const runDir = retrievalRun(traceRecord({ paths: [] }));
    const results: ReadonlyArray<BenchQuestionResult> = [
      { id: "q1", category: "single_hop", pass: true, latency_ms: 1 },
    ];
    // The report claims a different headline than the results carry.
    const report = handReport({
      passed: 0,
      total: 1,
      pass_rate: 0,
      by_category: { single_hop: { passed: 0, total: 1 } },
    });
    try {
      validateBenchTrace({ runDir, fixture: TRACE_FIXTURE, results, report });
      throw new Error("expected the trace validation to refuse");
    } catch (e) {
      const refusal = e as BenchRefusalError;
      expect(refusal.kind).toBe("report_counts_mismatch");
      expect(refusal.detail).toContain("passed");
    }
  });

  test("counts agree on a passing run that includes the headline-excluded category", () => {
    const runDir = retrievalRun(traceRecord({ paths: [] }));
    const results: ReadonlyArray<BenchQuestionResult> = [
      { id: "q1", category: "single_hop", pass: true, latency_ms: 1 },
      { id: "q-standing", category: "standing_instruction", pass: false, latency_ms: 1 },
    ];
    const counts = countQuestionResults(results);
    const report = handReport({
      passed: counts.passed,
      total: counts.total,
      pass_rate: counts.total > 0 ? counts.passed / counts.total : 0,
      by_category: counts.byCategory,
    });
    expect(counts.total).toBe(1);
    expect(counts.byCategory["standing_instruction"]).toEqual({ passed: 0, total: 1 });
    expect(() =>
      validateBenchTrace({ runDir, fixture: TRACE_FIXTURE, results, report }),
    ).not.toThrow();
  });
});

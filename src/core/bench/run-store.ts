/**
 * Bench run store (Memory Observability Suite, t_882c396a).
 *
 * Checkpointed runs under a caller-supplied runs directory:
 * `<runsDir>/<run-id>/checkpoint.json` plus per-question results and
 * the final report. Resume validates the fixture hash before skipping
 * phases - a changed fixture invalidates the checkpoint rather than
 * silently mixing two runs. A path guard refuses run ids that resolve
 * outside the runs directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { fixtureHash } from "./fixture.ts";
import { BENCH_PHASES, type BenchCheckpoint, type BenchFixture, type BenchPhase } from "./types.ts";

export interface BenchRunHandle {
  readonly runId: string;
  readonly runDir: string;
  readonly checkpoint: BenchCheckpoint;
}

const CHECKPOINT_FILE = "checkpoint.json";

/** Disposable fixture vault location inside one run. */
export function benchVaultDir(runDir: string): string {
  return join(runDir, "vault");
}

/** Per-question raw results location inside one run. */
export function benchResultsDir(runDir: string): string {
  return join(runDir, "results");
}

export function createBenchRun(
  runsDir: string,
  fixture: BenchFixture,
  opts: { now?: Date } = {},
): BenchRunHandle {
  const now = opts.now ?? new Date();
  const hash = fixtureHash(fixture);
  const stamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const runId = `run-${stamp}-${hash.slice(0, 6)}`;
  const runDir = guardedRunDir(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const checkpoint: BenchCheckpoint = Object.freeze({
    run_id: runId,
    fixture_name: fixture.name,
    fixture_hash: hash,
    created_at: now.toISOString(),
    completed_phases: Object.freeze([]),
  });
  persist(runDir, checkpoint);
  return Object.freeze({ runId, runDir, checkpoint });
}

export function loadBenchRun(
  runsDir: string,
  runId: string,
  opts: { expectFixture?: BenchFixture } = {},
): BenchRunHandle {
  const runDir = guardedRunDir(runsDir, runId);
  const path = join(runDir, CHECKPOINT_FILE);
  if (!existsSync(path)) {
    throw new Error(`bench run not found: ${runId}`);
  }
  const checkpoint = parseCheckpoint(JSON.parse(readFileSync(path, "utf8")));
  if (opts.expectFixture !== undefined) {
    const expected = fixtureHash(opts.expectFixture);
    if (expected !== checkpoint.fixture_hash) {
      throw new Error(
        `bench run ${runId}: fixture hash mismatch (checkpoint ${checkpoint.fixture_hash}, current ${expected}) - the fixture changed since this run started`,
      );
    }
  }
  return Object.freeze({ runId, runDir, checkpoint });
}

/** Mark a phase complete (idempotent) and persist the checkpoint. */
export function completeBenchPhase(
  runDir: string,
  checkpoint: BenchCheckpoint,
  phase: BenchPhase,
): BenchCheckpoint {
  if (checkpoint.completed_phases.includes(phase)) return checkpoint;
  const updated: BenchCheckpoint = Object.freeze({
    ...checkpoint,
    completed_phases: Object.freeze([...checkpoint.completed_phases, phase]),
  });
  persist(runDir, updated);
  return updated;
}

export function phaseDone(checkpoint: BenchCheckpoint, phase: BenchPhase): boolean {
  return checkpoint.completed_phases.includes(phase);
}

function persist(runDir: string, checkpoint: BenchCheckpoint): void {
  writeFileSync(join(runDir, CHECKPOINT_FILE), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

function parseCheckpoint(raw: unknown): BenchCheckpoint {
  if (raw === null || typeof raw !== "object") {
    throw new Error("bench checkpoint: malformed JSON");
  }
  const record = raw as Record<string, unknown>;
  const runId = record["run_id"];
  const fixtureName = record["fixture_name"];
  const hash = record["fixture_hash"];
  const createdAt = record["created_at"];
  const phases = record["completed_phases"];
  if (
    typeof runId !== "string" ||
    typeof fixtureName !== "string" ||
    typeof hash !== "string" ||
    typeof createdAt !== "string" ||
    !Array.isArray(phases)
  ) {
    throw new Error("bench checkpoint: missing required fields");
  }
  const completed = phases.filter(
    (phase): phase is BenchPhase =>
      typeof phase === "string" && (BENCH_PHASES as ReadonlyArray<string>).includes(phase),
  );
  return Object.freeze({
    run_id: runId,
    fixture_name: fixtureName,
    fixture_hash: hash,
    created_at: createdAt,
    completed_phases: Object.freeze(completed),
  });
}

/** Resolve a run directory and refuse anything outside the runs dir. */
function guardedRunDir(runsDir: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`bench run id contains unsafe characters: ${runId}`);
  }
  const root = resolve(runsDir);
  const dir = resolve(root, runId);
  if (dir !== root && !dir.startsWith(`${root}${sep}`)) {
    throw new Error(`bench run directory escapes the runs dir: ${runId}`);
  }
  return dir;
}

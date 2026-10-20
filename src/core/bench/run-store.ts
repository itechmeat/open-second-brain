/**
 * Bench run store (Memory Observability Suite, t_882c396a).
 *
 * Checkpointed runs under a caller-supplied runs directory:
 * `<runsDir>/<run-id>/checkpoint.json` plus per-question results and
 * the final report. Resume validates the fixture hash before skipping
 * phases - a changed fixture invalidates the checkpoint rather than
 * silently mixing two runs. The run identity covers the pinned search
 * knobs, the recall admission floor and the seeded sampling request
 * ({@link benchRunIdentityHash}), so a resumed run whose pin, floor or
 * sampling options changed fails the guard loudly; checkpoints written
 * before knob pinning existed are refused for the same reason. A path
 * guard refuses run ids that resolve outside the runs directory.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import { fixtureHash } from "./fixture.ts";
import {
  BENCH_PHASES,
  DEFAULT_BENCH_KNOB_PIN,
  type BenchCheckpoint,
  type BenchFixture,
  type BenchPhase,
  type BenchPinnedKnobs,
  type BenchSampleRequest,
} from "./types.ts";

export interface BenchRunHandle {
  readonly runId: string;
  readonly runDir: string;
  readonly checkpoint: BenchCheckpoint;
}

const CHECKPOINT_FILE = "checkpoint.json";

/** Hex characters kept from the run-identity digest (fixture + knob pin). */
const RUN_IDENTITY_HEX_CHARS = 16;

/**
 * The run-identity hash: the fixture hash AND the pinned knob record
 * AND the recall admission floor (null when unset) AND the seeded
 * sampling request (spread in only when set), canonically hashed
 * together. Two runs that differ only in their pin, floor or sampling
 * options therefore get different run ids - even when the sampled
 * fixture would be identical, because the options are what the run was
 * asked to do - and a resumed run whose pin, floor or sampling options
 * changed fails the identity guard instead of silently comparing two
 * pipelines - or worse, deciding the remaining questions under new
 * options while the persisted ones keep the old. The sampling half is
 * spread-omitted, so a no-sampling record is byte-identical to the
 * shipped one and every pre-change run id stays stable.
 */
export function benchRunIdentityHash(
  fixture: BenchFixture,
  pinnedKnobs: BenchPinnedKnobs,
  recallFloor?: number,
  sample?: BenchSampleRequest,
): string {
  return sha256Hex(
    canonicalJson({
      fixture: fixtureHash(fixture),
      knobs: pinnedKnobs,
      recall_floor: recallFloor ?? null,
      ...(sample !== undefined ? { sample } : {}),
    }),
  ).slice(0, RUN_IDENTITY_HEX_CHARS);
}

/** Disposable fixture vault location inside one run. */
export function benchVaultDir(runDir: string): string {
  return join(runDir, "vault");
}

/** Per-question raw results location inside one run. */
export function benchResultsDir(runDir: string): string {
  return join(runDir, "results");
}

/**
 * The run directory for a run id, resolved exactly the way the store
 * resolves it - through the {@link guardedRunDir} checks (finding 31):
 * the preflight and the pipeline consume this path BEFORE the store's
 * own guard runs (the search config is resolved against the run's future
 * vault so a refusal there can leave no run dir behind), so a run id the
 * guard would refuse is refused HERE, before any path is built or read.
 */
export function benchRunDirPath(runsDir: string, runId: string): string {
  return guardedRunDir(runsDir, runId);
}

/**
 * The run id a fresh run is about to take: second-precision timestamp
 * plus the identity hex. One fact, shared by `createBenchRun` and the
 * pipeline's preflight collision check, so the id the guard reads is the
 * id the store writes.
 */
export function nextBenchRunId(
  fixture: BenchFixture,
  opts: {
    now?: Date;
    pinnedKnobs?: BenchPinnedKnobs;
    recallFloor?: number;
    sample?: BenchSampleRequest;
  } = {},
): string {
  const now = opts.now ?? new Date();
  const knobs = opts.pinnedKnobs ?? DEFAULT_BENCH_KNOB_PIN;
  const identity = benchRunIdentityHash(fixture, knobs, opts.recallFloor, opts.sample);
  const stamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `run-${stamp}-${identity.slice(0, 6)}`;
}

/**
 * Write `data` atomically: a temp file renamed over the target, so a
 * crash mid-write leaves the previous generation intact instead of a
 * truncated published artifact. The bench vector cache established the
 * pattern (`embedding-cache.ts`); checkpoints, per-question results and
 * the report all go through it now.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, filePath);
  } catch (cause) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The original failure is the one to report.
    }
    throw cause;
  }
}

export function createBenchRun(
  runsDir: string,
  fixture: BenchFixture,
  opts: {
    now?: Date;
    pinnedKnobs?: BenchPinnedKnobs;
    recallFloor?: number;
    sample?: BenchSampleRequest;
  } = {},
): BenchRunHandle {
  const now = opts.now ?? new Date();
  const knobs = opts.pinnedKnobs ?? DEFAULT_BENCH_KNOB_PIN;
  const hash = fixtureHash(fixture);
  // The identity is computed from the same inputs the run id was, so the
  // checkpoint's knobs_hash stays the exact value the id embeds a slice
  // of (`nextBenchRunId` shares this computation for the collision check).
  const identity = benchRunIdentityHash(fixture, knobs, opts.recallFloor, opts.sample);
  const runId = nextBenchRunId(fixture, {
    now,
    pinnedKnobs: knobs,
    ...(opts.recallFloor !== undefined ? { recallFloor: opts.recallFloor } : {}),
    ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
  });
  const runDir = guardedRunDir(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const checkpoint: BenchCheckpoint = Object.freeze({
    run_id: runId,
    fixture_name: fixture.name,
    fixture_hash: hash,
    pinned_knobs: knobs,
    knobs_hash: identity,
    ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
    created_at: now.toISOString(),
    completed_phases: Object.freeze([]),
  });
  persist(runDir, checkpoint);
  return Object.freeze({ runId, runDir, checkpoint });
}

export function loadBenchRun(
  runsDir: string,
  runId: string,
  opts: {
    expectFixture?: BenchFixture;
    pinnedKnobs?: BenchPinnedKnobs;
    recallFloor?: number;
    sample?: BenchSampleRequest;
  } = {},
): BenchRunHandle {
  const checkpoint = readBenchCheckpoint(runsDir, runId);
  if (opts.expectFixture !== undefined) {
    const expected = fixtureHash(opts.expectFixture);
    if (expected !== checkpoint.fixture_hash) {
      throw new Error(
        `bench run ${runId}: fixture hash mismatch (checkpoint ${checkpoint.fixture_hash}, current ${expected}) - the fixture changed since this run started`,
      );
    }
    const knobs = opts.pinnedKnobs ?? DEFAULT_BENCH_KNOB_PIN;
    if (checkpoint.knobs_hash === undefined) {
      throw new Error(
        `bench run ${runId}: checkpoint predates knob pinning - the run identity cannot be verified, restart the run`,
      );
    }
    const expectedIdentity = benchRunIdentityHash(
      opts.expectFixture,
      knobs,
      opts.recallFloor,
      opts.sample,
    );
    if (expectedIdentity !== checkpoint.knobs_hash) {
      throw new Error(
        `bench run ${runId}: run identity mismatch (checkpoint ${checkpoint.knobs_hash}, current ${expectedIdentity}) - the pinned knobs, the recall floor or the sampling options changed since this run started`,
      );
    }
  }
  return Object.freeze({ runId, runDir: benchRunDirPath(runsDir, runId), checkpoint });
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

/**
 * Read and parse one run's checkpoint. Missing run: the long-standing
 * "bench run not found" error. Corrupt JSON: a NAMED error carrying the
 * file path - never a raw SyntaxError; the pipeline's preflight refuses
 * the same state with the rendering contract before this is reached.
 */
export function readBenchCheckpoint(runsDir: string, runId: string): BenchCheckpoint {
  const runDir = guardedRunDir(runsDir, runId);
  const path = join(runDir, CHECKPOINT_FILE);
  if (!existsSync(path)) {
    throw new Error(`bench run not found: ${runId}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(
      `bench checkpoint at ${path} is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      } - the run directory is damaged; start a fresh run`,
    );
  }
  return parseCheckpoint(raw);
}

function persist(runDir: string, checkpoint: BenchCheckpoint): void {
  atomicWriteFileSync(join(runDir, CHECKPOINT_FILE), `${JSON.stringify(checkpoint, null, 2)}\n`);
}

/**
 * Parse and validate one raw checkpoint document: the ONE definition of
 * the shape a resume may act on. Exported so the pipeline's resume
 * preflight runs this SAME gate before the store loads - a document that
 * parses as JSON but lacks the required fields is refused there by name
 * (the file and the missing fields) instead of surfacing here as a plain
 * Error the CLI does not render (M11).
 */
export function parseCheckpoint(raw: unknown): BenchCheckpoint {
  if (raw === null || typeof raw !== "object") {
    throw new Error("bench checkpoint: malformed JSON");
  }
  const record = raw as Record<string, unknown>;
  const runId = record["run_id"];
  const fixtureName = record["fixture_name"];
  const hash = record["fixture_hash"];
  const createdAt = record["created_at"];
  const phases = record["completed_phases"];
  const knobsHash = record["knobs_hash"];
  const pinnedKnobs = record["pinned_knobs"];
  const sample = record["sample"];
  // The missing fields are NAMED - the preflight renders this message as
  // the refusal detail, and an operator repairing a damaged run needs to
  // know which fields the checkpoint lost, not just that it lost some.
  // (The combined condition is what narrows the fields for the rest of
  // the parser, so the names are collected inside it.)
  if (
    typeof runId !== "string" ||
    typeof fixtureName !== "string" ||
    typeof hash !== "string" ||
    typeof createdAt !== "string" ||
    !Array.isArray(phases)
  ) {
    const missing = [
      ...(typeof runId !== "string" ? ["run_id"] : []),
      ...(typeof fixtureName !== "string" ? ["fixture_name"] : []),
      ...(typeof hash !== "string" ? ["fixture_hash"] : []),
      ...(typeof createdAt !== "string" ? ["created_at"] : []),
      ...(!Array.isArray(phases) ? ["completed_phases"] : []),
    ];
    throw new Error(`bench checkpoint: missing required field(s) ${missing.join(", ")}`);
  }
  if (knobsHash !== undefined && typeof knobsHash !== "string") {
    throw new Error("bench checkpoint: knobs_hash must be a string");
  }
  if (
    pinnedKnobs !== undefined &&
    (pinnedKnobs === null || typeof pinnedKnobs !== "object" || Array.isArray(pinnedKnobs))
  ) {
    throw new Error("bench checkpoint: pinned_knobs must be an object");
  }
  if (
    sample !== undefined &&
    (sample === null || typeof sample !== "object" || Array.isArray(sample))
  ) {
    throw new Error("bench checkpoint: sample must be an object");
  }
  // A phase name this build does not know means the checkpoint was
  // written by a different build. The old behavior silently FILTERED the
  // unknown name out and resumed as if the phase never happened - which
  // re-ran work under an identity that claimed it was done. Refuse by
  // name instead (the pipeline's preflight refuses the same state with
  // the `refused (<kind>)` render before this is reached).
  const completed: BenchPhase[] = [];
  for (const phase of phases) {
    if (typeof phase !== "string" || !(BENCH_PHASES as ReadonlyArray<string>).includes(phase)) {
      throw new Error(
        `bench checkpoint: unknown phase '${String(phase)}' in completed_phases - ` +
          "the checkpoint was written by a different build; restart the run",
      );
    }
    // The includes() guard above is the membership proof; the array's
    // element type does not carry it, so the narrow is asserted here.
    completed.push(phase as BenchPhase);
  }
  return Object.freeze({
    run_id: runId,
    fixture_name: fixtureName,
    fixture_hash: hash,
    ...(typeof knobsHash === "string" ? { knobs_hash: knobsHash } : {}),
    ...(pinnedKnobs !== undefined &&
    pinnedKnobs !== null &&
    typeof pinnedKnobs === "object" &&
    !Array.isArray(pinnedKnobs)
      ? { pinned_knobs: Object.freeze({ ...(pinnedKnobs as BenchPinnedKnobs) }) }
      : {}),
    ...(sample !== undefined &&
    sample !== null &&
    typeof sample === "object" &&
    !Array.isArray(sample)
      ? { sample: Object.freeze({ ...(sample as BenchSampleRequest) }) }
      : {}),
    created_at: createdAt,
    completed_phases: Object.freeze(completed),
  });
}

/**
 * Resolve a run directory and refuse anything outside the runs dir: the
 * charset rule (a run id is `[A-Za-z0-9._-]+`), the all-dots rule (`.` and
 * `..` pass the charset and resolve inside the root) and the containment
 * rule (the resolved dir must stay under the runs dir). Exported so every
 * site that derives a run-dir path from a CLI-typed id - the preflight's
 * probe reads, the pipeline's pre-creation path resolution - applies the
 * SAME guard BEFORE any read, not only the store's own checkpoint read.
 */
export function guardedRunDir(runsDir: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`bench run id contains unsafe characters: ${runId}`);
  }
  // "." and ".." pass the charset and resolve inside the root: a run id
  // of dots would write the checkpoint, the report and the vault beside
  // the shared vector cache instead of into its own directory.
  if (runId.split(".").every((part) => part === "")) {
    throw new Error(`bench run id must not be all dots: ${runId}`);
  }
  const root = resolve(runsDir);
  const dir = resolve(root, runId);
  if (dir !== root && !dir.startsWith(`${root}${sep}`)) {
    throw new Error(`bench run directory escapes the runs dir: ${runId}`);
  }
  return dir;
}

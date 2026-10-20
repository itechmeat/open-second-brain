/**
 * Bench-run integrity guards (t_d7ce8baf): the named refusal vocabulary,
 * the pre-run preflight, and the pre-report trace validation.
 *
 * Two gaps motivated this module, both about a degraded run creating
 * state or publishing scores:
 *
 *  - Ordering/atomicity: search-config resolution and the capability
 *    gate used to run AFTER run creation (orphan run dirs on refusal),
 *    a fresh run silently reset an existing same-identity run dir, and
 *    a resume target with damaged or tampered artifacts failed late
 *    with generic errors. {@link preflightBenchRun} catches all of
 *    that BEFORE `createBenchRun`/`loadBenchRun` runs.
 *  - Trace trust: the evaluate phase re-reads the persisted per-question
 *    results and used to default absent fields into ordinary FAILs,
 *    silently ignore truncated or foreign records, and publish faulted
 *    decisions as if they were memory behavior. {@link
 *    validateBenchTrace} refuses those BEFORE the report writes.
 *
 * What is deliberately NOT a refusal: score content. An
 * all-questions-failed run is the harness's purpose - a real
 * catastrophic regression is exactly what it must publish. Empty-but-
 * present trace fields are legitimate misses. The judge staying
 * `error` is advisory by contract (`judge.ts`).
 *
 * Guards abort; scorers score. `failure-modes.ts` is unchanged and the
 * guards add no knob, no measured behavior and zero stdout on success:
 * existing run ids, checkpoints and reports stay byte-identical
 * (`fixtureHash` remains content-only).
 */

import { accessSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";

import { benchResultsDir, benchVaultDir, guardedRunDir, parseCheckpoint } from "./run-store.ts";
import { fixtureHash } from "./fixture.ts";
import {
  BENCH_PHASES,
  type BenchCheckpoint,
  type BenchFixture,
  type BenchPhase,
  type BenchQuestionResult,
  type BenchReport,
} from "./types.ts";

/**
 * The closed refusal vocabulary: one member per catchable pre-run (P1-P7)
 * or pre-report (T1-T7) state. Frozen, like `RECALL_FAILURE` - a kind
 * that renders to an operator must not be renamable silently.
 */
export const BENCH_REFUSAL = Object.freeze({
  /** P1: the runs directory cannot be created or written. */
  runsDirUnusable: "runs_dir_unusable",
  /** P2: a fresh run's identity collides with an existing run dir. */
  runDirExists: "run_dir_exists",
  /** P3: a resume target's checkpoint.json is missing required shape. */
  checkpointUnparseable: "checkpoint_unparseable",
  /** P4a: the checkpoint names a phase this build does not know. */
  checkpointPhaseUnknown: "checkpoint_phase_unknown",
  /** P4b: the checkpoint's phases are out of order or duplicated. */
  checkpointPhaseOrder: "checkpoint_phase_order",
  /**
   * P4c: the resume was handed a fixture the run did not start with -
   * another `--fixture`, an edited copy, or (on a sampled suite) a
   * different `--sample-seed`/`--sample-cap`, which samples a different
   * fixture. Refused BEFORE the artifact check, which would read the new
   * fixture's absent artifacts as a tampered run.
   */
  checkpointFixtureMismatch: "checkpoint_fixture_mismatch",
  /** P5: a phase is marked done whose artifacts are gone or truncated. */
  runArtifactMissing: "run_artifact_missing",
  /** P7: the fixture cross-references notes or sessions it never defines. */
  fixtureCrossReference: "fixture_cross_reference",
  /** T1: a fixture question has no persisted result file. */
  traceResultMissing: "trace_result_missing",
  /** T2: a result file is not parseable JSON. */
  traceResultUnparseable: "trace_result_unparseable",
  /** T3: a result file's `id` differs from the question it is stored under. */
  traceIdMismatch: "trace_id_mismatch",
  /** T4: a category-required field is ABSENT from a persisted record. */
  traceFieldAbsent: "trace_field_absent",
  /** T5: a persisted proactive decision faulted. */
  traceFaultedDecisions: "trace_faulted_decisions",
  /** T6: `results/` holds files beyond the fixture's question ids. */
  traceExtraResults: "trace_extra_results",
  /** T7: the assembled report's counts disagree with its own trace. */
  reportCountsMismatch: "report_counts_mismatch",
} as const);

/** Closed union over {@link BENCH_REFUSAL}. */
export type BenchRefusalKind = (typeof BENCH_REFUSAL)[keyof typeof BENCH_REFUSAL];

/** Membership list, for listings and narrowings. */
export const BENCH_REFUSAL_KINDS: ReadonlyArray<BenchRefusalKind> = Object.freeze(
  Object.values(BENCH_REFUSAL),
);

/** Narrow a value read back across a boundary. */
export function isBenchRefusalKind(value: unknown): value is BenchRefusalKind {
  return (
    typeof value === "string" && (BENCH_REFUSAL_KINDS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The one error the bench guards raise. The message is the full CLI
 * render - `refused (<kind>): <detail>` - so a handler that prints the
 * message prints the contract; `kind` and `detail` stay structured for
 * callers that want to branch on the kind.
 */
export class BenchRefusalError extends Error {
  readonly kind: BenchRefusalKind;
  readonly detail: string;

  constructor(kind: BenchRefusalKind, detail: string) {
    super(`refused (${kind}): ${detail}`);
    this.name = "BenchRefusalError";
    this.kind = kind;
    this.detail = detail;
  }
}

function refuse(kind: BenchRefusalKind, detail: string): never {
  throw new BenchRefusalError(kind, detail);
}

/** The report file a completed report phase promises. Kept beside the pipeline's own writer. */
const REPORT_FILENAME = "report.json";

/** What the preflight needs to decide a run may start. */
export interface BenchPreflightOptions {
  /** The runs directory the run will live under (created if missing). */
  readonly runsDir: string;
  readonly fixture: BenchFixture;
  /** Resume target run id; preflight validates its checkpoint and artifacts. */
  readonly resume?: string;
  /**
   * The run id a FRESH run is about to create (the caller resolves it so
   * the collision check reads the same identity the store will write).
   * Absent on resume-only preflights.
   */
  readonly freshRunId?: string;
}

/**
 * Refuse every damaged state catchable BEFORE a run exists (P1-P7), so a
 * refusal can never leave a run directory behind. Adds zero stdout and,
 * on success, only the runs directory itself - which the store would
 * create anyway.
 */
export function preflightBenchRun(opts: BenchPreflightOptions): void {
  // P1: the runs dir must be creatable and writable. Probing here buys a
  // named refusal where a raw ENOENT/EACCES used to surface mid-store.
  try {
    mkdirSync(opts.runsDir, { recursive: true });
    accessSync(opts.runsDir, fsConstants.W_OK);
  } catch (cause) {
    refuse(
      BENCH_REFUSAL.runsDirUnusable,
      `runs directory ${opts.runsDir} is not usable: ${describeCause(cause)} - ` +
        "create it or pass a writable --runs-dir",
    );
  }
  if (opts.resume !== undefined) {
    preflightResume(opts.runsDir, opts.resume, opts.fixture);
  } else if (opts.freshRunId !== undefined) {
    // P2: run ids are second-precision timestamp + identity hex, so a
    // same-second rerun of the same fixture collides. The store would
    // silently RESET the prior run's checkpoint; the preflight refuses
    // instead and points at --resume.
    const existing = join(opts.runsDir, opts.freshRunId, "checkpoint.json");
    if (existsSync(existing)) {
      refuse(
        BENCH_REFUSAL.runDirExists,
        `a run with this identity already exists at ${join(opts.runsDir, opts.freshRunId)} - ` +
          `pass --resume ${opts.freshRunId} to continue it, or choose another --runs-dir`,
      );
    }
  }
  // P7: fixture cross-references, on every run. A dangling reference
  // scores as an ordinary missing-expected FAIL - an authoring error
  // indistinguishable from a real regression - so it is refused by name
  // instead.
  preflightFixtureCrossReferences(opts.fixture);
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** P3, P4, the fixture-hash match, P5: the resume target's checkpoint and its promised artifacts. */
function preflightResume(runsDir: string, runId: string, fixture: BenchFixture): void {
  // The run-id guard runs BEFORE any read (finding 30): a raw `--resume`
  // value the guard would refuse is refused here, by name - never
  // answered by whatever exists at the path it resolves to (`--resume ..`
  // used to read the parent directory's checkpoint.json and surface that
  // file's parse error as the refusal).
  const runDir = guardedRunDir(runsDir, runId);
  const path = join(runDir, "checkpoint.json");
  // A missing checkpoint keeps the store's own "bench run not found"
  // message: nothing here to add.
  if (!existsSync(path)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    refuse(
      BENCH_REFUSAL.checkpointUnparseable,
      `${path} is not valid JSON: ${describeCause(cause)} - ` +
        "the run directory is damaged; start a fresh run",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    refuse(
      BENCH_REFUSAL.checkpointUnparseable,
      `${path} is not a checkpoint object - start a fresh run`,
    );
  }
  const record = raw as Record<string, unknown>;
  const phases = record["completed_phases"];
  if (
    !Array.isArray(phases) ||
    phases.some((phase) => typeof phase !== "string" || phase.length === 0)
  ) {
    refuse(
      BENCH_REFUSAL.checkpointUnparseable,
      `${path} has no usable completed_phases array - start a fresh run`,
    );
  }
  // P4a: unknown phase names mean a checkpoint from a different build;
  // the store's parser refuses these too, but naming the value here
  // renders the repair before any load work happens.
  const unknown = phases.filter(
    (phase) => !(BENCH_PHASES as ReadonlyArray<string>).includes(phase),
  );
  if (unknown.length > 0) {
    refuse(
      BENCH_REFUSAL.checkpointPhaseUnknown,
      `${path} lists unknown phase(s) ${unknown.map((phase) => `'${phase}'`).join(", ")} - ` +
        "the checkpoint was written by a different build; start a fresh run",
    );
  }
  // P4b: completed phases are appended in pipeline order and once each.
  let lastIndex = -1;
  for (const phase of phases as ReadonlyArray<BenchPhase>) {
    const index = BENCH_PHASES.indexOf(phase);
    if (index <= lastIndex) {
      refuse(
        BENCH_REFUSAL.checkpointPhaseOrder,
        `${path} lists '${phase}' out of order or duplicated (completed_phases: ${phases.join(", ")}) - ` +
          "the checkpoint is damaged or from a different build; start a fresh run",
      );
    }
    lastIndex = index;
  }
  // The store's parser is the ONE definition of a usable checkpoint, and
  // it runs HERE: a document that parses as JSON but lacks the required
  // fields passed the shape checks above (and P5, whenever the artifacts
  // on disk happened to exist) and then exploded in loadBenchRun as a
  // plain Error the verb does not catch - a source frame where the
  // contract promises `refused (checkpoint_unparseable)`. Mapped to that
  // refusal with the file and the missing fields named. P4a/P4b above
  // already refused the phase states under their own names, so any
  // failure left for the parser is a shape failure.
  let checkpoint: BenchCheckpoint;
  try {
    checkpoint = parseCheckpoint(raw);
  } catch (cause) {
    refuse(
      BENCH_REFUSAL.checkpointUnparseable,
      `${path} is not a usable checkpoint: ${describeCause(cause)} - start a fresh run`,
    );
  }
  // P4c: the fixture the resume was given is hashed the way loadBenchRun
  // hashes it and compared BEFORE P5. A different `--fixture`, an edited
  // fixture copy, or a different --sample-seed/--sample-cap (which sample
  // a different fixture) changes this hash - and P5, comparing the run
  // directory against the NEW fixture, would read its absent artifacts as
  // `run_artifact_missing` and advise discarding a run that is healthy
  // under its own fixture.
  const expectedHash = fixtureHash(fixture);
  if (checkpoint.fixture_hash !== expectedHash) {
    refuse(
      BENCH_REFUSAL.checkpointFixtureMismatch,
      `${path} records fixture hash '${checkpoint.fixture_hash}' but this resume was given ` +
        `a fixture hashing to '${expectedHash}' - ` +
        "resume with the same fixture, seed and cap, or start a fresh run",
    );
  }
  const completed = new Set<string>(phases as ReadonlyArray<string>);
  const done = (phase: BenchPhase): boolean => completed.has(phase);
  // P5: a phase marked done promises artifacts. Only phases the coming
  // invocation still READS are required: evaluate/report rerun from the
  // persisted results on every resume, but the disposable vault is
  // legitimately deletable once retrieval is done (it is never read
  // again), so the vault is required exactly when retrieval still has to
  // run against it.
  if (done("ingest") && !done("retrieve")) {
    const vault = benchVaultDir(runDir);
    if (!existsSync(vault)) {
      refuse(
        BENCH_REFUSAL.runArtifactMissing,
        `the run claims ingest done but the materialized vault is missing at ${vault} - ` +
          "the run directory was tampered with or truncated; start a fresh run",
      );
    }
    const missingNote = fixture.notes.find((note) => !existsSync(join(vault, note.path)));
    if (missingNote !== undefined) {
      refuse(
        BENCH_REFUSAL.runArtifactMissing,
        `the materialized vault is missing the fixture note ${missingNote.path} - ` +
          "the run directory was tampered with or truncated; start a fresh run",
      );
    }
  }
  if (done("retrieve")) {
    const results = benchResultsDir(runDir);
    if (!existsSync(results)) {
      refuse(
        BENCH_REFUSAL.runArtifactMissing,
        `the run claims retrieve done but the results directory is missing at ${results} - ` +
          "the run directory was tampered with or truncated; start a fresh run",
      );
    }
    const missingQuestion = fixture.questions.find(
      (question) => !existsSync(join(results, `${question.id}.json`)),
    );
    if (missingQuestion !== undefined) {
      refuse(
        BENCH_REFUSAL.runArtifactMissing,
        `the run claims retrieve done but ${join(results, `${missingQuestion.id}.json`)} is missing - ` +
          "the run directory was tampered with or truncated; start a fresh run",
      );
    }
  }
  if (done("report")) {
    const report = join(runDir, REPORT_FILENAME);
    if (!existsSync(report)) {
      refuse(
        BENCH_REFUSAL.runArtifactMissing,
        `the run claims report done but ${report} is missing - ` +
          "the run directory was tampered with or truncated; start a fresh run",
      );
    }
  }
}

/** P7: every referenced note path and session id must exist in the fixture. */
function preflightFixtureCrossReferences(fixture: BenchFixture): void {
  const notePaths = new Set(fixture.notes.map((note) => note.path));
  const sessionIds = new Set(
    fixture.continuity.flatMap((record) => {
      const sessionId = record.payload["session_id"];
      return typeof sessionId === "string" ? [sessionId] : [];
    }),
  );
  for (const question of fixture.questions) {
    for (const referenced of question.expected_paths ?? []) {
      if (!notePaths.has(referenced)) {
        refuse(
          BENCH_REFUSAL.fixtureCrossReference,
          `question ${question.id} expects note ${referenced}, which the fixture never defines - ` +
            "fix the fixture (the question cannot be scored as authored)",
        );
      }
    }
    for (const referenced of question.not_expected_above ?? []) {
      if (!notePaths.has(referenced)) {
        refuse(
          BENCH_REFUSAL.fixtureCrossReference,
          `question ${question.id} names ${referenced} in not_expected_above, ` +
            "which the fixture never defines - fix the fixture (the question cannot be scored as authored)",
        );
      }
    }
    if (question.session_id !== undefined && !sessionIds.has(question.session_id)) {
      refuse(
        BENCH_REFUSAL.fixtureCrossReference,
        `question ${question.id} (session_handoff) names session '${question.session_id}', ` +
          "which the fixture's continuity never records - fix the fixture (the question cannot be scored as authored)",
      );
    }
  }
}

/** The category-field contract the trace validators enforce (T4). */
const CATEGORY_REQUIRED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  retrieval: "paths",
  session_handoff: "turn_texts",
  budget: "item_ids",
  source_isolation: "item_ids",
  proactive_recall: "recall_decision",
  write_fidelity: "labels",
  standing_instruction: "standing_items",
});

/** The trace field a question's category requires, absent never allowed. */
export function requiredTraceField(category: string): string {
  // The six non-retrieval categories name their field explicitly; every
  // other category is a retrieval family (single_hop, temporal, ...),
  // whose required field is `paths`.
  return CATEGORY_REQUIRED_FIELDS[category] ?? "paths";
}

/** What the trace validator needs; `results`/`report` arm the counts check. */
export interface BenchTraceValidationOptions {
  readonly runDir: string;
  readonly fixture: BenchFixture;
  /** The evaluated results; required together with `report`. */
  readonly results?: ReadonlyArray<BenchQuestionResult>;
  /**
   * The assembled report. Provided on the pre-write validation call, it
   * arms T7: the report's published counts must equal the counts
   * recomputed from the results by the same aggregation buildReport used.
   */
  readonly report?: BenchReport;
}

/**
 * The shared atomic writer's own leftover shape (`<target>.<pid>.tmp`):
 * a process killed between the write and the rename leaves it beside its
 * target - the `rmSync` cleanup only runs on a thrown error - and T6
 * must not turn that crash artifact into an unresumable run (finding 29):
 * the resume exists precisely to recover a crashed one. Only this exact
 * shape is exempt; every other leftover still refuses.
 */
function isAtomicWriteTemp(entry: string): boolean {
  return /\.json\.\d+\.tmp$/.test(entry);
}

/**
 * Refuse every damaged trace state catchable BEFORE the report writes
 * (T1-T7). Called by the pipeline once before scoring (no report yet -
 * T1-T6) and once before the write (with the report - the full set), so
 * both fresh and resumed runs are covered.
 */
export function validateBenchTrace(opts: BenchTraceValidationOptions): void {
  const resultsDir = benchResultsDir(opts.runDir);
  const expectedIds = opts.fixture.questions.map((question) => question.id);
  const expectedFiles = new Set(expectedIds.map((id) => `${id}.json`));
  // T6: leftovers in a reused or tampered run dir silently skew nothing
  // today only because they are ignored - which is exactly the problem:
  // they would hide a stale trace from every check below. The atomic
  // writer's own crash-orphaned temp ({@link isAtomicWriteTemp}) is the
  // one exempt shape.
  if (existsSync(resultsDir)) {
    const extras = readdirSync(resultsDir).filter(
      (entry) => !expectedFiles.has(entry) && !isAtomicWriteTemp(entry),
    );
    if (extras.length > 0) {
      refuse(
        BENCH_REFUSAL.traceExtraResults,
        `${resultsDir} holds file(s) beyond the fixture's questions: ${extras.join(", ")} - ` +
          "delete the stale result files or start a fresh run",
      );
    }
  }
  const faulted: string[] = [];
  for (let index = 0; index < opts.fixture.questions.length; index++) {
    const question = opts.fixture.questions[index]!;
    const path = join(resultsDir, `${question.id}.json`);
    // T1: the result file every fixture question was promised.
    if (!existsSync(path)) {
      refuse(
        BENCH_REFUSAL.traceResultMissing,
        `no persisted result for question ${question.id} at ${path} - ` +
          "the retrieve phase did not complete for this run; start a fresh run",
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      // T2: a crash mid-write (writes are atomic now, but the state must
      // stay refused by name, never a raw SyntaxError).
      refuse(
        BENCH_REFUSAL.traceResultUnparseable,
        `${path} is not valid JSON: ${describeCause(cause)} - ` +
          "the result file was truncated by a crash; start a fresh run",
      );
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      refuse(
        BENCH_REFUSAL.traceResultUnparseable,
        `${path} is not a result object - start a fresh run`,
      );
    }
    const record = raw as Record<string, unknown>;
    // T3: the id INSIDE the file must be the question it was stored under.
    if (record["id"] !== question.id) {
      refuse(
        BENCH_REFUSAL.traceIdMismatch,
        `${path} records id '${String(record["id"])}' but is stored under question ${question.id} - ` +
          "start a fresh run",
      );
    }
    // T4: category-required field ABSENT. The builders always set these
    // fields, so absence is structural (a truncated or foreign trace);
    // present-but-empty is a legitimate retrieval miss and passes.
    const field = requiredTraceField(question.category);
    if (record[field] === undefined || record[field] === null) {
      refuse(
        BENCH_REFUSAL.traceFieldAbsent,
        `question ${question.id} (${question.category}) has no '${field}' in ${path} - ` +
          "a truncated or foreign trace (present-but-empty would be a legitimate miss); start a fresh run",
      );
    }
    // T5: a faulted decision is the harness failing, and the scorer only
    // counts it - the report must never dress harness breakage up as
    // memory behavior. Resume would re-evaluate the same persisted
    // decision, so the repair is a fresh run.
    const decision = record["recall_decision"] as { kind?: string; fault?: string } | undefined;
    if (decision !== undefined && decision !== null && decision.kind === "error") {
      faulted.push(`${question.id} (${String(decision.fault ?? "unknown fault")})`);
    }
  }
  if (faulted.length > 0) {
    refuse(
      BENCH_REFUSAL.traceFaultedDecisions,
      `the decision core faulted on ${faulted.join(", ")} - the report must not publish harness ` +
        "breakage as memory behavior; start a fresh run (a resumed run re-evaluates the same persisted decisions)",
    );
  }
  // T7: the report must agree with the trace it was built from, by the
  // SAME aggregation buildReport uses (standing_instruction excluded from
  // the headline, never from by_category).
  if (opts.report !== undefined) {
    const counts = countQuestionResults(opts.results ?? []);
    const quality = opts.report.quality;
    const drifted: string[] = [];
    if (quality.passed !== counts.passed)
      drifted.push(`passed ${quality.passed} != ${counts.passed}`);
    if (quality.total !== counts.total) drifted.push(`total ${quality.total} != ${counts.total}`);
    for (const [category, bucket] of Object.entries(counts.byCategory)) {
      const published = quality.by_category[category];
      if (
        published === undefined ||
        published.passed !== bucket.passed ||
        published.total !== bucket.total
      ) {
        drifted.push(`by_category.${category} != trace`);
      }
    }
    for (const category of Object.keys(quality.by_category)) {
      if (counts.byCategory[category] === undefined) {
        drifted.push(`by_category.${category} not in trace`);
      }
    }
    if (drifted.length > 0) {
      refuse(
        BENCH_REFUSAL.reportCountsMismatch,
        `the report disagrees with its own trace: ${drifted.join("; ")} - start a fresh run`,
      );
    }
  }
}

/** The aggregate behind `buildReport`'s quality family, shared with T7. */
export interface BenchResultCounts {
  /** Headline passed count, excluding the standing_instruction category. */
  readonly passed: number;
  /** Headline total, same exclusion. */
  readonly total: number;
  /** Per-category passed/total, every category including the excluded one. */
  readonly byCategory: Record<string, { passed: number; total: number }>;
}

/**
 * Aggregate question results the way `buildReport` does. ONE copy of the
 * counting rule - including the standing_instruction headline exclusion -
 * so the report and the T7 cross-check cannot drift apart.
 */
export function countQuestionResults(
  results: ReadonlyArray<BenchQuestionResult>,
): BenchResultCounts {
  const byCategory: Record<string, { passed: number; total: number }> = {};
  let passed = 0;
  let total = 0;
  for (const result of results) {
    const bucket = (byCategory[result.category] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (result.pass) {
      bucket.passed += 1;
    }
    // The standing_instruction category never folds into the headline
    // (recall-lane-latency): its rate stays the named line of its own in
    // `by_category`, so adding facet questions to a fixture cannot shift
    // the headline pass rate a baseline compares.
    if (result.category !== "standing_instruction") {
      total += 1;
      if (result.pass) passed += 1;
    }
  }
  return { passed, total, byCategory };
}

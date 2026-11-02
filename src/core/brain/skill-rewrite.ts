/**
 * The rewrite gate kernels (agent-presence, Lane A).
 *
 * One gated rewrite round, kernel by kernel. OSB never calls a model:
 * the envelope builders hand the calling agent one `needs-llm-step` per
 * task - dev members only, until the single held-out check after a
 * promote - and the calling agent executes and submits transcripts. The
 * scorer validates the submitted shape and grades STRUCTURAL predicates
 * only; it refuses a submission that carries a self-reported success
 * field, so nothing the agent claims about its own work can move the
 * metric. Selection is the preregistered three arms from the
 * decision-model eval, and the held-out gate runs once, on the candidate
 * that earned promotion; a miss downgrades it.
 *
 * Every refusal here is a named {@link SkillRewriteError}: a stale task
 * set, a phantom receipt id, a malformed submission, a self-report, a
 * cross-arm leak, an unknown mode - none of them is ever a silent skip,
 * because a gate that quietly passes is worse than no gate.
 */

import { runJsonCommandBridge } from "../reliability/command-bridge.ts";
import { buildNeedsLlmStep, type NeedsLlmStep } from "./llm-step.ts";
import {
  SKILL_BENCH_CHECK,
  skillBenchmarkRelPath,
  SKILL_BENCHMARK_TASKS_FILE,
  type SkillBenchExpectation,
  type SkillBenchmarkTask,
  type SkillBenchmarkTaskSet,
  type SkillBenchValueClass,
} from "./skill-rewrite-tasks.ts";
import {
  SKILL_REWRITE_METRIC,
  SKILL_REWRITE_VERDICT,
  type SkillRewriteSpec,
  type SkillRewriteVerdict,
} from "./skill-rewrite-spec.ts";

// The verdict vocabulary rides the gate outputs: the CLI and MCP faces
// read it from here, beside the verdicts they print.
export {
  isSkillRewriteVerdict,
  SKILL_REWRITE_VERDICT,
  SKILL_REWRITE_VERDICTS,
} from "./skill-rewrite-spec.ts";

/** The step name a rewrite task envelope answers. */
export const SKILL_REWRITE_STEP = "skill-rewrite-task";

/** Subdirectory of the skill's benchmark folder holding round transcripts. */
export const SKILL_REWRITE_ROUNDS_DIR = "rounds";

/** Which round an envelope belongs to. The dev rounds are the baseline
 * (incumbent body) and the candidate; `heldout` exists but is never a
 * dev round - its envelope builder is the single post-promotion check. */
export const SKILL_REWRITE_ROUND_ARM = Object.freeze({
  baseline: "baseline",
  candidate: "candidate",
  heldout: "heldout",
} as const);

export type SkillRewriteRoundArm =
  (typeof SKILL_REWRITE_ROUND_ARM)[keyof typeof SKILL_REWRITE_ROUND_ARM];

/** The round-arm members, for parse-time refusal and guard sharing. */
export const SKILL_REWRITE_ROUND_ARMS: ReadonlyArray<SkillRewriteRoundArm> = Object.freeze(
  Object.values(SKILL_REWRITE_ROUND_ARM),
);

/**
 * One rewrite round envelope: the needs-llm-step spine plus the two fields
 * that tie the generated transcript back to the task it answers and the
 * arm that asked for it. The submission scorer reads `task_id` off the
 * TRANSCRIPT, not the envelope; these fields exist so a caller can
 * correlate an envelope with its task, and so the dev-only containment
 * assertion in the builder has a typed handle.
 */
export type RewriteTaskEnvelope = NeedsLlmStep & {
  readonly task_id: string;
  readonly round: SkillRewriteRoundArm;
};

export function isSkillRewriteRoundArm(value: unknown): value is SkillRewriteRoundArm {
  return (
    typeof value === "string" && (SKILL_REWRITE_ROUND_ARMS as ReadonlyArray<string>).includes(value)
  );
}

/** The closed rewrite-mode vocabulary: one candidate per round, or the
 * explicitly opted-in bounded edit loop. Both are gated before a write. */
export const SKILL_REWRITE_MODE = Object.freeze({
  gated: "gated",
  iterative: "iterative",
} as const);

export type SkillRewriteMode = (typeof SKILL_REWRITE_MODE)[keyof typeof SKILL_REWRITE_MODE];

/** The mode members, for guard sharing. */
export const SKILL_REWRITE_MODES: ReadonlyArray<SkillRewriteMode> = Object.freeze(
  Object.values(SKILL_REWRITE_MODE),
);

export function isSkillRewriteMode(value: unknown): value is SkillRewriteMode {
  return (
    typeof value === "string" && (SKILL_REWRITE_MODES as ReadonlyArray<string>).includes(value)
  );
}

/** A gate refusal. Every refusal in this module is this error, by name. */
export class SkillRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRewriteError";
  }
}

/** One scored transcript: which dev or held-out task, and which checks failed. */
export interface RewriteTaskScore {
  readonly taskId: string;
  readonly passed: boolean;
  /** Check ids the transcript failed, deduped, in expectation order. */
  readonly failedChecks: ReadonlyArray<string>;
}

/**
 * One submitted transcript, in its serialized shape - the exact JSON the
 * envelope's schema hints name, dropped at the envelope's target path.
 * Field spellings are snake case to match the file on disk.
 */
export interface RewriteSubmission {
  readonly task_id: string;
  readonly steps?: ReadonlyArray<string>;
  readonly tools_used?: ReadonlyArray<string>;
  readonly artifacts?: ReadonlyArray<string>;
  readonly output?: Readonly<Record<string, unknown>>;
}

/** The selection gate's outcome, with the rates it decided on. */
export interface RewriteSelection {
  readonly verdict: SkillRewriteVerdict;
  readonly baselineRate: number;
  readonly candidateRate: number;
}

/**
 * Top-level submission keys that report the agent's own success. They are
 * refused, not ignored: ignoring them would let a submitter believe the
 * field meant something, and accepting them would put a self-report one
 * refactor away from the metric.
 */
const SELF_REPORTED_KEYS: ReadonlyArray<string> = Object.freeze([
  "success",
  "passed",
  "succeeded",
  "ok",
]);

/** The closed top-level key set a submission may carry. */
const KNOWN_SUBMISSION_KEYS: ReadonlyArray<string> = Object.freeze([
  "task_id",
  "steps",
  "tools_used",
  "artifacts",
  "output",
]);

/** Dev rounds an envelope builder may be asked for. */
type DevRound = Extract<SkillRewriteRoundArm, "baseline" | "candidate">;

/**
 * Build one envelope per DEV task. The candidate body and the task input
 * travel in the prompt; the target path names the transcript drop site
 * under the skill's benchmark rounds tree. Held-out members are refused
 * by construction: the builder walks `spec.devTaskIds` and nothing else,
 * and a task set whose hash no longer matches the receipt is refused
 * before any envelope exists.
 */
export function buildRewriteEnvelopes(
  candidateBody: string,
  spec: SkillRewriteSpec,
  tasks: SkillBenchmarkTaskSet,
  opts: { readonly round?: DevRound } = {},
): ReadonlyArray<RewriteTaskEnvelope> {
  const round = opts.round ?? SKILL_REWRITE_ROUND_ARM.candidate;
  return buildRoundEnvelopes(candidateBody, spec, tasks, spec.devTaskIds, round);
}

/**
 * The ONE held-out envelope builder, and the only place held-out task
 * text may enter a prompt: after the dev selection promoted a candidate,
 * the held-out check runs once, and its results are never fed back.
 */
export function buildRewriteHeldoutEnvelopes(
  candidateBody: string,
  spec: SkillRewriteSpec,
  tasks: SkillBenchmarkTaskSet,
): ReadonlyArray<RewriteTaskEnvelope> {
  return buildRoundEnvelopes(
    candidateBody,
    spec,
    tasks,
    spec.heldoutTaskIds,
    SKILL_REWRITE_ROUND_ARM.heldout,
  );
}

function buildRoundEnvelopes(
  candidateBody: string,
  spec: SkillRewriteSpec,
  tasks: SkillBenchmarkTaskSet,
  memberIds: ReadonlyArray<string>,
  round: SkillRewriteRoundArm,
): ReadonlyArray<RewriteTaskEnvelope> {
  if (tasks.hash !== spec.tasksHash) {
    throw new SkillRewriteError(
      `skill rewrite: task set hash ${tasks.hash} does not match the receipt's frozen hash ` +
        `${spec.tasksHash}; the benchmark changed under the spec`,
    );
  }
  const byId = new Map(tasks.tasks.map((task) => [task.id, task]));
  const devMembers = new Set(spec.devTaskIds);
  const envelopes = memberIds.map((taskId) => {
    const task = byId.get(taskId);
    if (task === undefined) {
      throw new SkillRewriteError(
        `skill rewrite: receipt names task id '${taskId}' but the task set for ` +
          `'${spec.skillName}' has no such task (${SKILL_BENCHMARK_TASKS_FILE} is stale or hand-edited)`,
      );
    }
    const targetPath = skillBenchmarkRelPath(
      spec.skillName,
      SKILL_REWRITE_ROUNDS_DIR,
      round,
      `${task.id}.json`,
    );
    return buildNeedsLlmStep({
      step: SKILL_REWRITE_STEP,
      prompt: renderTaskPrompt(candidateBody, task, targetPath),
      schema_hints: Object.freeze([SUBMISSION_SHAPE_HINT]),
      target_path: targetPath,
      task_id: task.id,
      round,
    });
  });
  // The containment assertion the gate leans on: every envelope answers a
  // dev member. True by construction here, asserted so a future edit that
  // walks the wrong list fails here instead of leaking held-out text.
  const leaking = envelopes.filter((envelope) => !devMembers.has(String(envelope["task_id"])));
  if (leaking.length > 0 && round !== SKILL_REWRITE_ROUND_ARM.heldout) {
    throw new SkillRewriteError(
      `skill rewrite: envelope(s) for non-dev task(s) ${leaking
        .map((envelope) => String(envelope["task_id"]))
        .join(", ")} refused; held-out members never enter a dev round`,
    );
  }
  return envelopes;
}

/** The transcript contract the submitting agent must honor. */
const SUBMISSION_SHAPE_HINT =
  "Return one JSON object per task with keys: task_id (string), steps (string array), " +
  "tools_used (string array), artifacts (string array), output (object). " +
  "No other top-level keys.";

function renderTaskPrompt(
  candidateBody: string,
  task: SkillBenchmarkTask,
  targetPath: string,
): string {
  return [
    "Perform the task exactly as the candidate skill body instructs, then record what you did.",
    "",
    "Candidate skill body:",
    candidateBody,
    "",
    `Task ${task.id}:`,
    task.input,
    "",
    `Write the JSON transcript to ${targetPath} when the task is done.`,
  ].join("\n");
}

/** Options for {@link scoreRewriteTranscripts}: which arm is being scored,
 * against which receipt. Omitted opts scores whatever was submitted. */
export interface ScoreRewriteOptions {
  readonly arm: "dev" | "heldout";
  readonly spec: SkillRewriteSpec;
}

/**
 * Validate submitted transcripts and score them against the task set's
 * structural predicates. Throws a named {@link SkillRewriteError} on any
 * malformed shape, an unknown task id, a duplicate submission, a
 * self-reported success field, or - when the arm is named - a submission
 * for a task the arm may not see. Scores come back sorted by task id.
 */
export function scoreRewriteTranscripts(
  submissions: ReadonlyArray<unknown>,
  tasks: SkillBenchmarkTaskSet,
  opts?: ScoreRewriteOptions,
): ReadonlyArray<RewriteTaskScore> {
  const byId = new Map(tasks.tasks.map((task) => [task.id, task]));
  const devMembers = new Set(opts?.spec.devTaskIds ?? []);
  const heldoutMembers = new Set(opts?.spec.heldoutTaskIds ?? []);
  const seen = new Set<string>();
  const scores: RewriteTaskScore[] = [];
  for (const raw of submissions) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SkillRewriteError("rewrite submission must be an object");
    }
    const record = raw as Record<string, unknown>;
    const taskId = record["task_id"];
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      throw new SkillRewriteError("rewrite submission needs a task_id");
    }
    const task = byId.get(taskId);
    if (task === undefined) {
      throw new SkillRewriteError(`rewrite submission names an unknown task id: ${taskId}`);
    }
    for (const key of SELF_REPORTED_KEYS) {
      if (key in record) {
        throw new SkillRewriteError(
          `rewrite submission carries a self-reported success field ('${key}'); ` +
            "the scorer reads structural predicates only",
        );
      }
    }
    for (const key of Object.keys(record)) {
      if (!(KNOWN_SUBMISSION_KEYS as ReadonlyArray<string>).includes(key)) {
        throw new SkillRewriteError(
          `rewrite submission carries an unexpected key ('${key}'); ` +
            `the transcript shape is ${KNOWN_SUBMISSION_KEYS.join(", ")}`,
        );
      }
    }
    if (seen.has(taskId)) {
      throw new SkillRewriteError(`rewrite submission for task '${taskId}' appears twice`);
    }
    seen.add(taskId);
    if (opts !== undefined) {
      const memberOfArm = opts.arm === "dev" ? devMembers : heldoutMembers;
      const otherArm = opts.arm === "dev" ? heldoutMembers : devMembers;
      if (!memberOfArm.has(taskId)) {
        const why = otherArm.has(taskId) ? "a held-out task" : "a task outside this arm";
        const armName = opts.arm === "dev" ? "dev" : "held-out";
        throw new SkillRewriteError(
          `rewrite submission for '${taskId}' refused in the ${armName} arm: ` +
            `'${taskId}' is ${why}` +
            (otherArm.has(taskId) && opts.arm === "dev"
              ? "; held-out members are scored by the single held-out check only"
              : "; dev members are scored in the dev arm only"),
        );
      }
    }
    const steps = stringList(record["steps"], "steps");
    const toolsUsed = stringList(record["tools_used"], "tools_used");
    const artifacts = stringList(record["artifacts"], "artifacts");
    const outputRaw = record["output"] ?? {};
    if (outputRaw === null || typeof outputRaw !== "object" || Array.isArray(outputRaw)) {
      throw new SkillRewriteError("rewrite submission output must be an object");
    }
    const output = outputRaw as Readonly<Record<string, unknown>>;
    scores.push(scoreTask(task, { steps, toolsUsed, artifacts, output }));
  }
  return scores.toSorted((left, right) => left.taskId.localeCompare(right.taskId));
}

/**
 * The selection gate, preregistered three arms: a candidate promotes only
 * by strictly beating the baseline by more than the spec's margin with
 * the dev n met; a tie - and anything under the margin - holds; a short
 * dev n is its own arm, never a pass.
 */
export function selectRewriteCandidate(
  baseline: ReadonlyArray<RewriteTaskScore>,
  candidate: ReadonlyArray<RewriteTaskScore>,
  spec: SkillRewriteSpec,
): RewriteSelection {
  const n = Math.min(baseline.length, candidate.length);
  const baselineRate = passedRate(baseline);
  const candidateRate = passedRate(candidate);
  if (n < spec.minDevTasks) {
    return {
      verdict: SKILL_REWRITE_VERDICT.not_enough_evidence,
      baselineRate,
      candidateRate,
    };
  }
  if (candidateRate > baselineRate + spec.requiredMargin) {
    return { verdict: SKILL_REWRITE_VERDICT.promote, baselineRate, candidateRate };
  }
  return { verdict: SKILL_REWRITE_VERDICT.hold, baselineRate, candidateRate };
}

/**
 * The held-out gate, run ONCE, on the candidate that earned promotion: a
 * full pass promotes, any miss - or an empty held-out arm, which is no
 * evidence at all - holds. Every score must name a held-out member; a
 * dev score array handed here is refused by name rather than folded in.
 */
export function checkRewriteHeldout(
  candidate: ReadonlyArray<RewriteTaskScore>,
  spec: SkillRewriteSpec,
): SkillRewriteVerdict {
  const heldoutMembers = new Set(spec.heldoutTaskIds);
  for (const score of candidate) {
    if (!heldoutMembers.has(score.taskId)) {
      throw new SkillRewriteError(
        `held-out gate scored '${score.taskId}', which is not a held-out member of the receipt; ` +
          "the held-out arm scores held-out members only",
      );
    }
  }
  if (candidate.length === 0) return SKILL_REWRITE_VERDICT.hold;
  return candidate.every((score) => score.passed)
    ? SKILL_REWRITE_VERDICT.promote
    : SKILL_REWRITE_VERDICT.hold;
}

/**
 * Resolve the rewrite mode. Absent (or blank) resolves to `gated`, the
 * documented default; `gated` and `iterative` pass through; anything
 * else is a named error, never a silent fallback to the default.
 */
export function resolveSkillRewriteMode(raw: string | undefined): SkillRewriteMode {
  const value = raw?.trim() ?? "";
  if (value === "") return SKILL_REWRITE_MODE.gated;
  if (isSkillRewriteMode(value)) return value;
  throw new SkillRewriteError(
    `skill rewrite mode '${value}' is unknown (expected one of ${SKILL_REWRITE_MODES.join(", ")})`,
  );
}

// ----- the advisory judge -------------------------------------------------------

export interface RewriteJudgeOutcome {
  readonly status: "skipped" | "error" | "ran";
  readonly detail?: string;
  /** Advisory per-task verdicts; never folded into the metric. */
  readonly verdicts?: Readonly<Record<string, boolean>>;
}

/**
 * Optional advisory judge over the score summary, through the one
 * sanctioned external-command boundary. The deterministic scorer stays
 * canonical in every message and every doc line: the judge's verdicts are
 * reported for comparison and can never reach
 * {@link selectRewriteCandidate}, whose signature takes score arrays and
 * a spec only. A failing command is an error status, never a throw.
 */
export function runRewriteJudge(
  cmd: string | undefined,
  summary: Record<string, unknown>,
): RewriteJudgeOutcome {
  const result = runJsonCommandBridge(cmd, summary, { label: "skill rewrite judge command" });
  if (result.status === "skipped") return Object.freeze({ status: "skipped" });
  if (result.status === "error") {
    return Object.freeze({ status: "error", detail: result.detail });
  }
  if (result.output === null || typeof result.output !== "object") {
    return Object.freeze({ status: "error", detail: "judge output is not an object" });
  }
  const parsed = result.output as { verdicts?: Record<string, unknown> };
  const verdicts: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(parsed.verdicts ?? {})) {
    if (typeof value === "boolean") verdicts[id] = value;
  }
  return Object.freeze({ status: "ran", verdicts: Object.freeze(verdicts) });
}

// ----- the grade record ---------------------------------------------------------

/** One per-task row of a grade record: ids and check verdicts only. */
export interface RewriteGradeTaskRow {
  readonly task_id: string;
  readonly passed: boolean;
  readonly failed_checks: ReadonlyArray<string>;
}

/**
 * The `skill_rewrite_eval_grade` payload: identifiers, numbers, booleans
 * and check ids, stamped with the spec hash. NEVER task text and NEVER
 * transcript text - the payload is assembled from score rows, which carry
 * no text by construction, and tests pin that over the serialized form.
 */
export interface RewriteGradeRecordPayload {
  readonly skill: string;
  readonly spec_hash: string;
  readonly tasks_hash: string;
  readonly metric: typeof SKILL_REWRITE_METRIC;
  readonly seed: number;
  readonly split_rule: string;
  /** The final verdict: the selection verdict after the held-out gate. */
  readonly verdict: SkillRewriteVerdict;
  readonly baseline_rate: number;
  readonly candidate_rate: number;
  readonly dev: ReadonlyArray<RewriteGradeTaskRow>;
  readonly held_out: ReadonlyArray<RewriteGradeTaskRow>;
}

export interface RewriteGradeRecordInput {
  readonly skill: string;
  readonly spec: SkillRewriteSpec;
  /** The spec hash stamped on the record and the staged proposal. */
  readonly specHash: string;
  readonly selection: RewriteSelection;
  /** The held-out gate's verdict; `hold` when it has not run yet. */
  readonly heldoutVerdict: SkillRewriteVerdict;
  readonly devScores: ReadonlyArray<RewriteTaskScore>;
  readonly heldoutScores: ReadonlyArray<RewriteTaskScore>;
}

/**
 * Assemble the grade-record payload for a completed gate run. The final
 * verdict applies the one rule the held-out gate owns: a promoted
 * candidate that misses held-out is downgraded to hold. A hold and a
 * short dev n are already final from selection.
 */
export function buildRewriteGradeRecord(input: RewriteGradeRecordInput): RewriteGradeRecordPayload {
  const verdict =
    input.selection.verdict === SKILL_REWRITE_VERDICT.promote
      ? input.heldoutVerdict
      : input.selection.verdict;
  return Object.freeze({
    skill: input.skill,
    spec_hash: input.specHash,
    tasks_hash: input.spec.tasksHash,
    metric: SKILL_REWRITE_METRIC,
    seed: input.spec.seed,
    split_rule: input.spec.splitRule,
    verdict,
    baseline_rate: input.selection.baselineRate,
    candidate_rate: input.selection.candidateRate,
    dev: input.devScores.map(toGradeRow),
    held_out: input.heldoutScores.map(toGradeRow),
  });
}

function toGradeRow(score: RewriteTaskScore): RewriteGradeTaskRow {
  return Object.freeze({
    task_id: score.taskId,
    passed: score.passed,
    failed_checks: Object.freeze([...score.failedChecks]),
  });
}

// ----- the structural predicates -------------------------------------------------

interface NormalizedTranscript {
  readonly steps: ReadonlyArray<string>;
  readonly toolsUsed: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<string>;
  readonly output: Readonly<Record<string, unknown>>;
}

function scoreTask(task: SkillBenchmarkTask, transcript: NormalizedTranscript): RewriteTaskScore {
  const failed: string[] = [];
  for (const expectation of task.expects) {
    const passed = evaluateExpectation(expectation, transcript);
    if (!passed && !failed.includes(expectation.check)) {
      failed.push(expectation.check);
    }
  }
  return Object.freeze({
    taskId: task.id,
    passed: failed.length === 0,
    failedChecks: Object.freeze(failed),
  });
}

function evaluateExpectation(
  expectation: SkillBenchExpectation,
  transcript: NormalizedTranscript,
): boolean {
  switch (expectation.check) {
    case SKILL_BENCH_CHECK.tool_used:
      return transcript.toolsUsed.includes(expectation.tool);
    case SKILL_BENCH_CHECK.artifact_created: {
      const prefix = normalizePath(expectation.path_prefix);
      return transcript.artifacts.some((artifact) => normalizePath(artifact).startsWith(prefix));
    }
    case SKILL_BENCH_CHECK.step_order:
      return isSubsequence(expectation.steps, transcript.steps);
    case SKILL_BENCH_CHECK.forbidden_step:
      return !transcript.steps.includes(expectation.step);
    case SKILL_BENCH_CHECK.output_field:
      return outputValueMatches(transcript.output[expectation.field], expectation.value_class);
  }
}

function isSubsequence(needles: ReadonlyArray<string>, haystack: ReadonlyArray<string>): boolean {
  let cursor = 0;
  for (const step of haystack) {
    if (cursor < needles.length && step === needles[cursor]) cursor++;
  }
  return cursor === needles.length;
}

function outputValueMatches(value: unknown, valueClass: SkillBenchValueClass): boolean {
  switch (valueClass) {
    case "non_empty_string":
      return typeof value === "string" && value.trim().length > 0;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "non_empty_array":
      return Array.isArray(value) && value.length > 0;
  }
}

/** Absent means empty; present means a string array, else a named error. */
function stringList(raw: unknown, field: string): ReadonlyArray<string> {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string")) {
    throw new SkillRewriteError(`rewrite submission ${field} must be a string array`);
  }
  return Object.freeze(raw as string[]);
}

/** Artifact path shapes compare on forward slashes on every platform. */
function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function passedRate(scores: ReadonlyArray<RewriteTaskScore>): number {
  if (scores.length === 0) return 0;
  return scores.filter((score) => score.passed).length / scores.length;
}

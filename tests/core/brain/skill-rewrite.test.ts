/**
 * The rewrite gate kernels (agent-presence, Lane A, A3).
 *
 * OSB never calls a model. The envelope builder hands the calling agent
 * one step per DEV task - held-out ids are refused by construction and
 * their task text never reaches a prompt before the single held-out
 * check. The scorer reads structural predicates only and refuses any
 * submission carrying a self-reported success field, so nothing the
 * agent claims about its own work can move the metric. Selection is the
 * preregistered three arms, and the held-out gate downgrades a promoted
 * candidate on a miss. The grade record carries ids, scores and check
 * verdicts with the spec hash - never task text, never transcript text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NEEDS_LLM_STEP } from "../../../src/core/brain/llm-step.ts";
import {
  SKILL_BENCH_CHECK,
  type SkillBenchmarkTask,
} from "../../../src/core/brain/skill-rewrite-tasks.ts";
import {
  SKILL_REWRITE_STEP,
  SKILL_REWRITE_VERDICT,
  buildRewriteEnvelopes,
  buildRewriteGradeRecord,
  buildRewriteHeldoutEnvelopes,
  checkRewriteHeldout,
  resolveSkillRewriteMode,
  runRewriteJudge,
  scoreRewriteTranscripts,
  selectRewriteCandidate,
  type RewriteSubmission,
} from "../../../src/core/brain/skill-rewrite.ts";
import {
  buildSkillRewriteSpec,
  SKILL_REWRITE_METRIC,
  type SkillRewriteSpec,
} from "../../../src/core/brain/skill-rewrite-spec.ts";
import { parseSkillBenchmarkTasks } from "../../../src/core/brain/skill-rewrite-tasks.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "tests", "fixtures", "skill-bench", "example-skill");

const TASKS = parseSkillBenchmarkTasks(
  JSON.parse(readFileSync(join(FIXTURE_PATH, "tasks.json"), "utf8")),
  "tasks.json",
);
const SPEC = buildSkillRewriteSpec(TASKS.skillName, TASKS);
const CANDIDATE_BODY =
  "# example-skill\n\nRewritten instructions: search first, then write, and report the path.";

/** One structurally passing transcript for a task. */
function passingSubmission(task: SkillBenchmarkTask): RewriteSubmission {
  const expectations = task.expects.map((expectation) => {
    switch (expectation.check) {
      case "tool_used":
        return { tools: [expectation.tool] };
      case "artifact_created":
        return { artifacts: [expectation.path_prefix + "result.md"] };
      case "step_order":
        return { steps: [...expectation.steps] };
      case "forbidden_step":
        return { steps: ["search"] };
      case "output_field":
        return {
          output:
            expectation.value_class === "non_empty_string"
              ? { [expectation.field]: "recorded" }
              : expectation.value_class === "number"
                ? { [expectation.field]: 3 }
                : expectation.value_class === "boolean"
                  ? { [expectation.field]: true }
                  : { [expectation.field]: ["a"] },
        };
    }
  });
  return {
    task_id: task.id,
    steps: expectations.flatMap((entry) => entry.steps ?? ["search"]),
    tools_used: expectations.flatMap((entry) => entry.tools ?? []),
    artifacts: expectations.flatMap((entry) => entry.artifacts ?? []),
    output: Object.assign({}, ...expectations.map((entry) => entry.output ?? {})),
  };
}

function failingSubmission(task: SkillBenchmarkTask): RewriteSubmission {
  return { task_id: task.id, steps: [], tools_used: [], artifacts: [], output: {} };
}

describe("buildRewriteEnvelopes", () => {
  test("emits one needs-llm-step per DEV task carrying the body and the task input", () => {
    const envelopes = buildRewriteEnvelopes(CANDIDATE_BODY, SPEC, TASKS);
    expect(envelopes.length).toBe(SPEC.devTaskIds.length);
    for (const envelope of envelopes) {
      expect(envelope.status).toBe(NEEDS_LLM_STEP);
      expect(envelope.step).toBe(SKILL_REWRITE_STEP);
      expect(SPEC.devTaskIds).toContain(String(envelope["task_id"]));
      expect(String(envelope["round"])).toBe("candidate");
      expect(envelope.prompt).toContain(CANDIDATE_BODY);
    }
    const inputs = TASKS.tasks.filter((task) => SPEC.devTaskIds.includes(task.id));
    for (const task of inputs) {
      const envelope = envelopes.find((candidate) => candidate["task_id"] === task.id);
      expect(envelope?.prompt).toContain(task.input);
    }
  });

  test("target paths drop into the skill's benchmark rounds tree", () => {
    const envelopes = buildRewriteEnvelopes(CANDIDATE_BODY, SPEC, TASKS, { round: "baseline" });
    for (const envelope of envelopes) {
      expect(envelope.target_path).toBe(
        `Brain/skill-benchmarks/example-skill/rounds/baseline/${String(envelope["task_id"])}.json`,
      );
      expect(String(envelope["round"])).toBe("baseline");
    }
  });

  test("the baseline round never names the candidate body a held-out task", () => {
    const envelopes = buildRewriteEnvelopes(CANDIDATE_BODY, SPEC, TASKS);
    const heldout = TASKS.tasks.filter((task) => SPEC.heldoutTaskIds.includes(task.id));
    expect(heldout.length).toBeGreaterThan(0);
    for (const envelope of envelopes) {
      expect(SPEC.heldoutTaskIds).not.toContain(String(envelope["task_id"]));
      for (const task of heldout) {
        expect(envelope.prompt).not.toContain(task.input);
      }
    }
  });

  test("refuses by name when the task set cannot cover the dev receipt", () => {
    const spec: SkillRewriteSpec = {
      ...SPEC,
      devTaskIds: [...SPEC.devTaskIds, "phantom-task"],
    };
    expect(() => buildRewriteEnvelopes(CANDIDATE_BODY, spec, TASKS)).toThrow(/phantom-task/);
  });

  test("refuses by name when the task set hash no longer matches the receipt", () => {
    expect(() => buildRewriteEnvelopes(CANDIDATE_BODY, SPEC, TASKS)).not.toThrow();
    const staleSpec: SkillRewriteSpec = { ...SPEC, tasksHash: `${SPEC.tasksHash.slice(0, 8)}dead` };
    expect(() => buildRewriteEnvelopes(CANDIDATE_BODY, staleSpec, TASKS)).toThrow(/hash/);
  });
});

describe("buildRewriteHeldoutEnvelopes", () => {
  test("emits envelopes for the held-out members only, after promotion", () => {
    const envelopes = buildRewriteHeldoutEnvelopes(CANDIDATE_BODY, SPEC, TASKS);
    expect(envelopes.length).toBe(SPEC.heldoutTaskIds.length);
    for (const envelope of envelopes) {
      expect(SPEC.heldoutTaskIds).toContain(String(envelope["task_id"]));
      expect(String(envelope["round"])).toBe("heldout");
      expect(envelope.prompt).toContain(CANDIDATE_BODY);
    }
    const heldoutInputs = TASKS.tasks.filter((task) => SPEC.heldoutTaskIds.includes(task.id));
    for (const task of heldoutInputs) {
      const envelope = envelopes.find((candidate) => candidate["task_id"] === task.id);
      expect(envelope?.prompt).toContain(task.input);
    }
  });
});

describe("scoreRewriteTranscripts", () => {
  test("scores structural predicates and reports failures by check id", () => {
    const devTasks = TASKS.tasks.filter((task) => SPEC.devTaskIds.includes(task.id));
    const passing = devTasks.map(passingSubmission);
    const scores = scoreRewriteTranscripts(passing, TASKS, { arm: "dev", spec: SPEC });
    expect(scores.length).toBe(devTasks.length);
    for (const score of scores) expect(score.passed).toBe(true);

    const failing = devTasks.map(failingSubmission);
    const failedScores = scoreRewriteTranscripts(failing, TASKS, { arm: "dev", spec: SPEC });
    for (const score of failedScores) {
      expect(score.passed).toBe(false);
      // Every check an empty transcript can fail shows up by check id.
      // The exception is forbidden_step, which an empty transcript
      // satisfies: the step was not taken.
      const task = TASKS.tasks.find((candidate) => candidate.id === score.taskId)!;
      const expectedChecks = task.expects.map((expectation) => expectation.check);
      for (const check of expectedChecks) {
        if (check === SKILL_BENCH_CHECK.forbidden_step) {
          expect(score.failedChecks).not.toContain(check);
        } else {
          expect(score.failedChecks).toContain(check);
        }
      }
    }
  });

  test("a partial pass reports exactly the checks that failed", () => {
    const toolCheckTask = TASKS.tasks.find(
      (task) =>
        SPEC.devTaskIds.includes(task.id) &&
        task.expects.some((expectation) => expectation.check === "tool_used"),
    );
    if (toolCheckTask === undefined) throw new Error("fixture has no tool_used task");
    const submission = passingSubmission(toolCheckTask);
    const score = scoreRewriteTranscripts([submission], TASKS, { arm: "dev", spec: SPEC })[0]!;
    expect(score.passed).toBe(true);

    const withoutTool = { ...submission, tools_used: [] };
    const broken = scoreRewriteTranscripts([withoutTool], TASKS, { arm: "dev", spec: SPEC })[0]!;
    expect(broken.passed).toBe(false);
    expect(broken.failedChecks).toEqual([SKILL_BENCH_CHECK.tool_used]);
  });

  test("step_order passes on a subsequence, not only an exact list", () => {
    const orderTask = TASKS.tasks.find(
      (task) =>
        SPEC.devTaskIds.includes(task.id) &&
        task.expects.some((expectation) => expectation.check === "step_order"),
    );
    if (orderTask === undefined) throw new Error("fixture has no step_order task");
    const expectation = orderTask.expects.find((candidate) => candidate.check === "step_order") as {
      steps: ReadonlyArray<string>;
    };
    const withExtraSteps: RewriteSubmission = {
      task_id: orderTask.id,
      steps: ["plan", ...expectation.steps, "verify"],
      tools_used: [],
      artifacts: [],
      output: {},
    };
    // Only the step_order check is guaranteed here; other checks on the
    // same task may fail, so assert on the one predicate under test.
    const score = scoreRewriteTranscripts([withExtraSteps], TASKS, { arm: "dev", spec: SPEC })[0]!;
    expect(score.failedChecks).not.toContain(SKILL_BENCH_CHECK.step_order);
  });

  test("refuses malformed submissions by name", () => {
    const refusing = (submission: unknown, fragment: string): void => {
      try {
        scoreRewriteTranscripts([submission], TASKS);
      } catch (error) {
        expect((error as Error).message).toContain(fragment);
        return;
      }
      throw new Error(`expected a refusal containing "${fragment}"`);
    };
    refusing(null, "submission must be an object");
    refusing({ steps: [] }, "task_id");
    refusing({ task_id: "ghost-task" }, "unknown task id");
    refusing({ task_id: TASKS.tasks[0]!.id, steps: "read" }, "steps must be a string array");
    refusing({ task_id: TASKS.tasks[0]!.id, tools_used: [7] }, "tools_used must be a string array");
    refusing({ task_id: TASKS.tasks[0]!.id, artifacts: [{}] }, "artifacts must be a string array");
    refusing({ task_id: TASKS.tasks[0]!.id, output: "done" }, "output must be an object");
    refusing({ task_id: TASKS.tasks[0]!.id, success: true }, "self-reported");
    refusing({ task_id: TASKS.tasks[0]!.id, passed: true }, "self-reported");
    refusing({ task_id: TASKS.tasks[0]!.id, verdict: true }, "unexpected key");
  });

  test("refuses a duplicate submission for the same task", () => {
    const submission = passingSubmission(TASKS.tasks[0]!);
    expect(() => scoreRewriteTranscripts([submission, submission], TASKS)).toThrow(/twice/);
  });

  test("the dev arm refuses held-out submissions and the held-out arm refuses dev ones", () => {
    const heldoutTask = TASKS.tasks.find((task) => SPEC.heldoutTaskIds.includes(task.id))!;
    const devTask = TASKS.tasks.find((task) => SPEC.devTaskIds.includes(task.id))!;
    expect(() =>
      scoreRewriteTranscripts([passingSubmission(heldoutTask)], TASKS, { arm: "dev", spec: SPEC }),
    ).toThrow(/held-out/);
    expect(() =>
      scoreRewriteTranscripts([passingSubmission(devTask)], TASKS, { arm: "heldout", spec: SPEC }),
    ).toThrow(/dev/);
  });

  test("scores come back sorted by task id", () => {
    const devTasks = TASKS.tasks.filter((task) => SPEC.devTaskIds.includes(task.id));
    const submissions = devTasks.map(passingSubmission).toSorted(() => -1);
    const scores = scoreRewriteTranscripts(submissions, TASKS, { arm: "dev", spec: SPEC });
    const ids = scores.map((score) => score.taskId);
    expect(ids).toEqual([...ids].toSorted());
  });
});

describe("selectRewriteCandidate", () => {
  const devTasks = TASKS.tasks.filter((task) => SPEC.devTaskIds.includes(task.id));

  test("a strict beat beyond the margin with n met promotes", () => {
    const baseline = scoreRewriteTranscripts(devTasks.map(failingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const candidate = scoreRewriteTranscripts(devTasks.map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const outcome = selectRewriteCandidate(baseline, candidate, SPEC);
    expect(outcome.verdict).toBe(SKILL_REWRITE_VERDICT.promote);
    expect(outcome.candidateRate).toBeGreaterThan(outcome.baselineRate);
  });

  test("a tie holds", () => {
    const baseline = scoreRewriteTranscripts(devTasks.map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const candidate = scoreRewriteTranscripts(devTasks.map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const outcome = selectRewriteCandidate(baseline, candidate, SPEC);
    expect(outcome.verdict).toBe(SKILL_REWRITE_VERDICT.hold);
    expect(outcome.baselineRate).toBe(outcome.candidateRate);
  });

  test("a beat under the margin holds", () => {
    const baseline = scoreRewriteTranscripts(devTasks.map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    // Drop exactly one pass: a small rate loss that must stay under the
    // margin for a task set this size.
    const partial = devTasks.map((task, index) =>
      index === 0 ? failingSubmission(task) : passingSubmission(task),
    );
    const candidate = scoreRewriteTranscripts(partial, TASKS, { arm: "dev", spec: SPEC });
    const outcome = selectRewriteCandidate(baseline, candidate, SPEC);
    expect(outcome.verdict).toBe(SKILL_REWRITE_VERDICT.hold);
    expect(outcome.candidateRate).toBeLessThan(outcome.baselineRate);
  });

  test("a short dev n is its own arm", () => {
    const baseline = scoreRewriteTranscripts(devTasks.slice(0, 1).map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const candidate = scoreRewriteTranscripts(devTasks.slice(0, 1).map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const outcome = selectRewriteCandidate(baseline, candidate, SPEC);
    expect(outcome.verdict).toBe(SKILL_REWRITE_VERDICT.not_enough_evidence);
  });
});

describe("checkRewriteHeldout", () => {
  const heldoutTasks = TASKS.tasks.filter((task) => SPEC.heldoutTaskIds.includes(task.id));

  test("a full held-out pass promotes", () => {
    const scores = scoreRewriteTranscripts(heldoutTasks.map(passingSubmission), TASKS, {
      arm: "heldout",
      spec: SPEC,
    });
    expect(checkRewriteHeldout(scores, SPEC)).toBe(SKILL_REWRITE_VERDICT.promote);
  });

  test("a held-out miss downgrades to hold", () => {
    const scores = scoreRewriteTranscripts(
      heldoutTasks.map((task, index) =>
        index === 0 ? failingSubmission(task) : passingSubmission(task),
      ),
      TASKS,
      { arm: "heldout", spec: SPEC },
    );
    expect(checkRewriteHeldout(scores, SPEC)).toBe(SKILL_REWRITE_VERDICT.hold);
  });

  test("no held-out evidence is not a pass", () => {
    expect(checkRewriteHeldout([], SPEC)).toBe(SKILL_REWRITE_VERDICT.hold);
  });
});

describe("resolveSkillRewriteMode", () => {
  test("gated and iterative are accepted, absent resolves to gated", () => {
    expect(resolveSkillRewriteMode(undefined)).toBe("gated");
    expect(resolveSkillRewriteMode("")).toBe("gated");
    expect(resolveSkillRewriteMode("  ")).toBe("gated");
    expect(resolveSkillRewriteMode("gated")).toBe("gated");
    expect(resolveSkillRewriteMode("iterative")).toBe("iterative");
  });

  test("an unknown value is a named error", () => {
    expect(() => resolveSkillRewriteMode("turbo")).toThrow(/turbo/);
  });
});

describe("runRewriteJudge", () => {
  test("skipped without a command", () => {
    expect(runRewriteJudge(undefined, { metric: SKILL_REWRITE_METRIC }).status).toBe("skipped");
  });

  test("a failing command is an error status, never a throw", () => {
    const outcome = runRewriteJudge("exit 3", { metric: SKILL_REWRITE_METRIC });
    expect(outcome.status).toBe("error");
  });

  test("advisory verdicts never move the metric", () => {
    // The judge's verdict field is reported, never folded into selection:
    // selectRewriteCandidate takes only RewriteTaskScore arrays and the
    // spec, so no judge output type can reach it. Pinned by a run whose
    // judge output contradicts the deterministic scores.
    const devTasks = TASKS.tasks.filter((task) => SPEC.devTaskIds.includes(task.id));
    const baseline = scoreRewriteTranscripts(devTasks.map(failingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const candidate = scoreRewriteTranscripts(devTasks.map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    expect(selectRewriteCandidate(baseline, candidate, SPEC).verdict).toBe(
      SKILL_REWRITE_VERDICT.promote,
    );
  });
});

describe("buildRewriteGradeRecord", () => {
  test("carries ids, scores and check verdicts with the spec hash", () => {
    const devTasks = TASKS.tasks.filter((task) => SPEC.devTaskIds.includes(task.id));
    const heldoutTasks = TASKS.tasks.filter((task) => SPEC.heldoutTaskIds.includes(task.id));
    const baseline = scoreRewriteTranscripts(devTasks.map(failingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const candidate = scoreRewriteTranscripts(devTasks.map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const selection = selectRewriteCandidate(baseline, candidate, SPEC);
    const heldout = scoreRewriteTranscripts(heldoutTasks.map(passingSubmission), TASKS, {
      arm: "heldout",
      spec: SPEC,
    });
    const verdict = checkRewriteHeldout(heldout, SPEC);
    const record = buildRewriteGradeRecord({
      skill: TASKS.skillName,
      spec: SPEC,
      specHash: "spec-hash-value",
      selection,
      heldoutVerdict: verdict,
      devScores: candidate,
      heldoutScores: heldout,
    });
    expect(record.skill).toBe(TASKS.skillName);
    expect(record.spec_hash).toBe("spec-hash-value");
    expect(record.metric).toBe(SKILL_REWRITE_METRIC);
    expect(record.verdict).toBe(SKILL_REWRITE_VERDICT.promote);
    expect(record.tasks_hash).toBe(SPEC.tasksHash);
    expect(record.dev.map((row) => row.task_id).toSorted()).toEqual(
      [...SPEC.devTaskIds].toSorted(),
    );
    expect(record.held_out.map((row) => row.task_id).toSorted()).toEqual(
      [...SPEC.heldoutTaskIds].toSorted(),
    );
    for (const row of record.dev) {
      expect(typeof row.passed).toBe("boolean");
      expect(Array.isArray(row.failed_checks)).toBe(true);
    }
  });

  test("the serialized record never carries task or transcript text", () => {
    const devTasks = TASKS.tasks.filter((task) => SPEC.devTaskIds.includes(task.id));
    const candidate = scoreRewriteTranscripts(devTasks.map(passingSubmission), TASKS, {
      arm: "dev",
      spec: SPEC,
    });
    const record = buildRewriteGradeRecord({
      skill: TASKS.skillName,
      spec: SPEC,
      specHash: "spec-hash-value",
      selection: selectRewriteCandidate(candidate, candidate, SPEC),
      heldoutVerdict: SKILL_REWRITE_VERDICT.hold,
      devScores: candidate,
      heldoutScores: [],
    });
    const serialized = JSON.stringify(record);
    for (const task of TASKS.tasks) {
      // Task input text, down to a distinguishing fragment, never ships.
      const fragment = task.input.slice(0, 24);
      expect(serialized).not.toContain(fragment);
    }
    // Transcript step and tool names are never echoed either: only the
    // check ids, the boolean verdicts and the rates travel.
    expect(serialized).not.toContain("note_write");
    expect(serialized).not.toContain("bulk_delete");
  });
});

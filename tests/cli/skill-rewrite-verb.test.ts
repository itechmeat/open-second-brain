/**
 * `o2b brain skill-proposals rewrite-plan` and `rewrite-score` (Lane A, A5).
 *
 * The two verbs mirror the page-candidates/page-draft split for rewrite
 * rounds: plan validates the frozen receipt and hands out the dev-round
 * envelopes (the incumbent body and the candidate body, never held-out
 * text); score grades the submitted transcripts, runs the selection and
 * held-out gates, prints the verdict, writes the grade record, and stages
 * the pending proposal ONLY on a final promote. The scorer binds every
 * candidate-arm submission to the current candidate body through the
 * `candidate_sha256` its envelope carried, so a transcript left over from
 * a previous candidate never gates this one. Every refusal is a named
 * stderr line and a non-zero exit.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../src/core/brain/continuity/store.ts";
import { skillBenchmarkTasksPath } from "../../src/core/brain/paths.ts";
import { listPendingSkillProposals } from "../../src/core/brain/skill-proposals.ts";
import { sha256Hex } from "../../src/core/integrity/digest.ts";
import {
  SKILL_REWRITE_JUDGE_CMD_ENV_KEY,
  SKILL_REWRITE_MODE_ENV_KEY,
} from "../../src/core/config.ts";
import { _resetHeldLocksForTests } from "../../src/core/brain/sync-lockfile.ts";
import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// The wave's explicit per-test budget (test-audit F3): most tests here boot
// the real CLI, and the budget keeps a loaded machine from turning process
// start into a flaky verdict.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let scratch: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rewrite-verb-"));
  scratch = mkdtempSync(join(tmpdir(), "o2b-rewrite-cand-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  _resetHeldLocksForTests();
  rmSync(vault, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  delete process.env[SKILL_REWRITE_MODE_ENV_KEY];
  delete process.env[SKILL_REWRITE_JUDGE_CMD_ENV_KEY];
});

const FIXTURE_TASKS = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "skill-bench", "example-skill", "tasks.json"),
    "utf8",
  ),
) as { skill: string; tasks: ReadonlyArray<{ id: string }> };
const FIXTURE_SPEC = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "skill-bench", "example-skill", "spec.json"),
    "utf8",
  ),
) as {
  tasks_hash: string;
  dev_task_ids: ReadonlyArray<string>;
  held_out_task_ids: ReadonlyArray<string>;
};

const INCUMBENT_BODY = [
  "---",
  "name: example-skill",
  "description: The incumbent instructions.",
  "triggers:",
  "  - thing",
  "version: 3",
  "---",
  "# example-skill",
  "",
  "Incumbent body: search, then write, then verify.",
  "",
].join("\n");

const CANDIDATE_BODY =
  "Candidate body: plan first, search twice, write once, and report the artifact path.";

/** The hash every candidate-round envelope stamps: sha-256 of the candidate body. */
const CANDIDATE_HASH = sha256Hex(CANDIDATE_BODY);
/** The hash a STALE transcript carries: it was produced against a different body. */
const STALE_HASH = sha256Hex("Candidate body from a round that has since been re-generated.");

const DEV_TASKS = FIXTURE_SPEC.dev_task_ids;
const HELDOUT_TASKS = FIXTURE_SPEC.held_out_task_ids;

/** Seed the vault: benchmark receipt files and an incumbent skill at version 3. */
function seedBenchmark(
  mutateTasks?: (raw: { tasks: Array<Record<string, unknown>> }) => void,
): void {
  const tasks = JSON.parse(JSON.stringify(FIXTURE_TASKS)) as {
    skill: string;
    tasks: Array<Record<string, unknown>>;
  };
  if (mutateTasks) mutateTasks(tasks);
  const tasksPath = skillBenchmarkTasksPath(vault, "example-skill");
  mkdirSync(join(tasksPath, ".."), { recursive: true });
  writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
  const specPath = join(tasksPath, "..", "spec.json");
  writeFileSync(specPath, `${JSON.stringify(FIXTURE_SPEC, null, 2)}\n`, "utf8");

  const skillDir = join(vault, "Brain", "skills", "example-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), INCUMBENT_BODY, "utf8");

  const candidatePath = join(scratch, "candidate.md");
  writeFileSync(candidatePath, CANDIDATE_BODY, "utf8");
}

interface Transcript {
  readonly task_id: string;
  readonly steps: ReadonlyArray<string>;
  readonly tools_used: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<string>;
  readonly output: Record<string, unknown>;
  readonly candidate_sha256?: string;
}

/** A transcript that passes every structural predicate the fixture pins for the task. */
function passingTranscript(taskId: string): Transcript {
  const byTask: Record<string, Omit<Transcript, "task_id">> = {
    "t-03": {
      steps: ["read", "archive"],
      tools_used: ["note_write"],
      artifacts: ["Brain/retired/old-pref.md"],
      output: {},
    },
    "t-04": {
      steps: ["write"],
      tools_used: ["note_write"],
      artifacts: [],
      output: { verdict: "promote" },
    },
    "t-06": {
      steps: ["list"],
      tools_used: ["note_search"],
      artifacts: [],
      output: { entries: ["example-skill"] },
    },
    "t-07": {
      steps: ["read", "edit", "stage"],
      tools_used: ["note_write"],
      artifacts: ["Brain/skill-proposals/pending/x.md"],
      output: {},
    },
    "t-08": {
      steps: ["move"],
      tools_used: ["note_move"],
      artifacts: ["Brain/skill-proposals/accepted/x.md"],
      output: {},
    },
    "t-09": { steps: ["check"], tools_used: [], artifacts: [], output: { enabled: true } },
    "t-10": {
      steps: ["read", "summarize", "write"],
      tools_used: ["note_write"],
      artifacts: [],
      output: { summary: "three invocations, all offered" },
    },
    "t-01": {
      steps: ["write"],
      tools_used: ["note_write"],
      artifacts: ["Brain/notes/meetings/today.md"],
      output: {},
    },
    "t-02": {
      steps: ["search", "read", "edit"],
      tools_used: ["note_search"],
      artifacts: [],
      output: {},
    },
    "t-05": { steps: ["count"], tools_used: [], artifacts: [], output: { count: 2 } },
  };
  const row = byTask[taskId];
  if (!row) throw new Error(`test setup: no transcript scripted for ${taskId}`);
  return { task_id: taskId, ...row };
}

/** A transcript that fails every check: no steps, no tools, no artifacts, empty output. */
function failingTranscript(taskId: string): Transcript {
  return { task_id: taskId, steps: [], tools_used: [], artifacts: [], output: {} };
}

/** Echo the candidate_sha256 the envelope the transcript answers carried. */
function boundWith(transcript: Transcript, hash: string): Transcript {
  return { ...transcript, candidate_sha256: hash };
}

function writeRounds(
  arm: "baseline" | "candidate" | "heldout",
  entries: ReadonlyArray<Transcript>,
): void {
  const dir = join(vault, "Brain", "skill-benchmarks", "example-skill", "rounds", arm);
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    writeFileSync(join(dir, `${entry.task_id}.json`), `${JSON.stringify(entry)}\n`, "utf8");
  }
}

describe("rewrite-plan", () => {
  test("prints the frozen receipt and the dev envelopes for both rounds", async () => {
    seedBenchmark();
    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-plan",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).toBe(0);
    // The receipt: schema, split rule, seed, hashes.
    expect(r.stdout).toContain("o2b.skill-rewrite.v1");
    expect(r.stdout).toContain("hash-order-70-30");
    expect(r.stdout).toContain(FIXTURE_SPEC.tasks_hash);
    // Dev envelopes for both rounds, with the drop sites named.
    for (const taskId of DEV_TASKS) {
      expect(r.stdout).toContain(taskId);
      expect(r.stdout).toContain(`rounds/baseline/${taskId}.json`);
      expect(r.stdout).toContain(`rounds/candidate/${taskId}.json`);
    }
    // The incumbent and candidate bodies travel in the prompts.
    expect(r.stdout).toContain("Incumbent body: search, then write, then verify.");
    expect(r.stdout).toContain("Candidate body: plan first");
    // Held-out members never appear: not their ids, not their text.
    for (const taskId of HELDOUT_TASKS) expect(r.stdout).not.toContain(`rounds/baseline/${taskId}`);
    const heldoutTask = FIXTURE_TASKS.tasks.find((task) => task.id === HELDOUT_TASKS[0]);
    expect(heldoutTask).toBeDefined();
  });

  test("a missing task set refuses by name", async () => {
    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-plan",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("tasks.json");
  });

  test("a task set that no longer matches the receipt refuses with the reason", async () => {
    seedBenchmark((tasks) => {
      tasks.tasks[0] = { ...tasks.tasks[0], input: "A changed task input line." };
    });
    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-plan",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("hash");
  });

  test("an unknown mode refuses by name", async () => {
    seedBenchmark();
    process.env[SKILL_REWRITE_MODE_ENV_KEY] = "turbo";
    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-plan",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("turbo");
  });

  test("the --json receipt aggregates held-out membership to a count, never ids", async () => {
    // The verb docblock promises held-out members never appear on this
    // surface. The JSON receipt is what the calling agent consumes, so the
    // pin covers the serialized payload: a count, and no held-out id
    // anywhere in it.
    seedBenchmark();
    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-plan",
      "example-skill",
      "--vault",
      vault,
      "--json",
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as { receipt: Record<string, unknown> };
    expect(payload.receipt["heldout_task_count"]).toBe(HELDOUT_TASKS.length);
    expect(payload.receipt["heldout_task_ids"]).toBeUndefined();
    const serialized = JSON.stringify(payload);
    for (const taskId of HELDOUT_TASKS) expect(serialized).not.toContain(taskId);
  });
});

describe("rewrite-score", () => {
  test("a tie holds: the grade record lands, the proposal tree is untouched", async () => {
    seedBenchmark();
    const tie = DEV_TASKS.map((taskId, index) =>
      index < 3 ? passingTranscript(taskId) : failingTranscript(taskId),
    );
    writeRounds("baseline", tie);
    // The candidate arm's transcripts echo the candidate_sha256 their
    // envelopes carried; the scorer binds them to the candidate body.
    writeRounds(
      "candidate",
      tie.map((transcript) => boundWith(transcript, CANDIDATE_HASH)),
    );

    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("hold");
    // The grade record is the one write.
    const grades = listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" });
    expect(grades.length).toBe(1);
    // Gate failure stages nothing.
    expect(listPendingSkillProposals(vault).length).toBe(0);
  });

  test("a stale candidate_sha256 refuses the score by name", async () => {
    // The transcripts were produced against a DIFFERENT candidate body than
    // the one on disk now. The scorer binds submissions to the current
    // candidate, so a stale round never gates this candidate - and never
    // reaches the gates at all.
    seedBenchmark();
    writeRounds(
      "baseline",
      DEV_TASKS.map((taskId, index) =>
        index < 3 ? passingTranscript(taskId) : failingTranscript(taskId),
      ),
    );
    writeRounds(
      "candidate",
      DEV_TASKS.map((taskId) => boundWith(passingTranscript(taskId), STALE_HASH)),
    );

    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("candidate_sha256");
    expect(r.stderr).toContain("does not match the current candidate body");
    // Refused before anything was decided: no grade record, no staged draft.
    expect(listPendingSkillProposals(vault).length).toBe(0);
    expect(listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" }).length).toBe(0);
  });

  test("a transcript with no candidate_sha256 refuses once the scorer binds to the candidate", async () => {
    seedBenchmark();
    writeRounds(
      "baseline",
      DEV_TASKS.map((taskId, index) =>
        index < 3 ? passingTranscript(taskId) : failingTranscript(taskId),
      ),
    );
    writeRounds(
      "candidate",
      DEV_TASKS.map((taskId) => passingTranscript(taskId)),
    );

    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("missing candidate_sha256");
    expect(listPendingSkillProposals(vault).length).toBe(0);
    expect(listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" }).length).toBe(0);
  });

  test("a promote with a held-out pass stages the scored_rewrite proposal", async () => {
    seedBenchmark();
    writeRounds(
      "baseline",
      DEV_TASKS.map((taskId, index) =>
        index < 3 ? passingTranscript(taskId) : failingTranscript(taskId),
      ),
    );
    writeRounds(
      "candidate",
      DEV_TASKS.map((taskId) => boundWith(passingTranscript(taskId), CANDIDATE_HASH)),
    );
    writeRounds(
      "heldout",
      HELDOUT_TASKS.map((taskId) => boundWith(passingTranscript(taskId), CANDIDATE_HASH)),
    );

    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("promote");

    const pending = listPendingSkillProposals(vault);
    expect(pending.length).toBe(1);
    expect(pending[0]?.patternKind).toBe("scored_rewrite");
    const grades = listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" });
    expect(grades.length).toBe(1);
    expect(grades[0]?.payload["verdict"]).toBe("promote");
  });

  test("the operator accept lands the rewrite end to end through the CLI", async () => {
    // The designed flow, whole: the gate stages, the operator accepts on
    // the command line, and the accept-time re-verification (security M1)
    // passes against exactly what the gate round wrote - receipt, take,
    // and its own promote grade record.
    seedBenchmark();
    writeRounds(
      "baseline",
      DEV_TASKS.map((taskId, index) =>
        index < 3 ? passingTranscript(taskId) : failingTranscript(taskId),
      ),
    );
    writeRounds(
      "candidate",
      DEV_TASKS.map((taskId) => boundWith(passingTranscript(taskId), CANDIDATE_HASH)),
    );
    writeRounds(
      "heldout",
      HELDOUT_TASKS.map((taskId) => boundWith(passingTranscript(taskId), CANDIDATE_HASH)),
    );
    const scored = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(scored.returncode).toBe(0);
    const pending = listPendingSkillProposals(vault);
    expect(pending.length).toBe(1);

    const accepted = await runCli([
      "brain",
      "skill-proposals",
      "accept",
      pending[0]!.slug,
      "--vault",
      vault,
      "--note",
      "gate passed",
    ]);
    expect(accepted.returncode).toBe(0);
    // The incumbent body was replaced by the candidate, and the draft is
    // consumed - the accept the design promised, still human-initiated.
    const skillPath = join(vault, "Brain", "skills", "example-skill", "SKILL.md");
    expect(readFileSync(skillPath, "utf8")).toContain("Candidate body: plan first");
    expect(listPendingSkillProposals(vault).length).toBe(0);
  });

  test("a promote without held-out transcripts prints the one held-out round and stages nothing", async () => {
    seedBenchmark();
    writeRounds(
      "baseline",
      DEV_TASKS.map((taskId, index) =>
        index < 3 ? passingTranscript(taskId) : failingTranscript(taskId),
      ),
    );
    writeRounds(
      "candidate",
      DEV_TASKS.map((taskId) => boundWith(passingTranscript(taskId), CANDIDATE_HASH)),
    );

    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).toBe(0);
    // The single held-out check's envelopes, and nothing staged or graded yet.
    for (const taskId of HELDOUT_TASKS) {
      expect(r.stdout).toContain(taskId);
      expect(r.stdout).toContain(`rounds/heldout/${taskId}.json`);
    }
    expect(listPendingSkillProposals(vault).length).toBe(0);
    expect(listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" }).length).toBe(0);
  });

  test("a short dev arm is not_enough_evidence and stages nothing", async () => {
    seedBenchmark();
    writeRounds("baseline", [passingTranscript(DEV_TASKS[0]!)]);
    writeRounds(
      "candidate",
      DEV_TASKS.map((taskId) => boundWith(passingTranscript(taskId), CANDIDATE_HASH)),
    );

    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("not_enough_evidence");
    expect(listPendingSkillProposals(vault).length).toBe(0);
  });

  test("a refused take exits non-zero naming the reason", async () => {
    seedBenchmark((tasks) => {
      tasks.tasks[0] = { ...tasks.tasks[0], input: "A changed task input line." };
    });
    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
    ]);
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("hash");
    expect(listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" }).length).toBe(0);
  });

  test("a missing incumbent refuses by name when staging is reached", async () => {
    seedBenchmark();
    rmSync(join(vault, "Brain", "skills", "example-skill"), { recursive: true, force: true });
    writeRounds(
      "baseline",
      DEV_TASKS.map((taskId, index) =>
        index < 3 ? passingTranscript(taskId) : failingTranscript(taskId),
      ),
    );
    writeRounds(
      "candidate",
      DEV_TASKS.map((taskId) => boundWith(passingTranscript(taskId), CANDIDATE_HASH)),
    );
    writeRounds(
      "heldout",
      HELDOUT_TASKS.map((taskId) => boundWith(passingTranscript(taskId), CANDIDATE_HASH)),
    );

    const r = await runCli([
      "brain",
      "skill-proposals",
      "rewrite-score",
      "example-skill",
      "--vault",
      vault,
      "--candidate-file",
      join(scratch, "candidate.md"),
    ]);
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("incumbent");
    expect(listPendingSkillProposals(vault).length).toBe(0);
  });
});

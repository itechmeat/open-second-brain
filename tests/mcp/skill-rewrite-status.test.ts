/**
 * `brain_skill_rewrite_status` - the read-only MCP face of the
 * benchmark-gated rewrite lane (agent-presence, Lane A, A5).
 *
 * MCP NEVER accepts and NEVER scores: the tool reads the frozen receipt
 * and the grade ledger, and reports what a human accept is being asked to
 * review. The pinned behaviors: the tool is registered read-only; the
 * receipt names the take-verification; the grades carry verdicts and
 * rates with the spec hash (ids and numbers, never task or transcript
 * text); an unknown skill is a named empty status, not an error; and the
 * handler writes nothing.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listPendingSkillProposals,
  recordSkillRewriteGrade,
  stageScoredRewriteProposal,
} from "../../src/core/brain/skill-proposals.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import {
  buildSkillRewriteSpec,
  skillRewriteSpecHash,
  SKILL_REWRITE_VERDICT,
} from "../../src/core/brain/skill-rewrite-spec.ts";
import { parseSkillBenchmarkTasks } from "../../src/core/brain/skill-rewrite-tasks.ts";
import { skillBenchmarkSpecPath, skillBenchmarkTasksPath } from "../../src/core/brain/paths.ts";
import { PROCEDURE_TOOLS } from "../../src/mcp/brain/procedure-tools.ts";
import { MCPError, INVALID_PARAMS } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// The wave's explicit per-test budget (test-audit F3): this file drives the
// MCP server objects directly, and the budget keeps a loaded machine from
// turning process-start cost into a flaky verdict.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let ctx: ServerContext;

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "skill-bench", "example-skill");

const TASKS = parseSkillBenchmarkTasks(
  JSON.parse(readFileSync(join(FIXTURE_DIR, "tasks.json"), "utf8")),
  "tasks.json",
);

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rewrite-status-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  ctx = { vault, configPath: join(vault, "brain-config.yaml"), repoRoot: vault } as ServerContext;
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function tool() {
  return PROCEDURE_TOOLS.find((t) => t.name === "brain_skill_rewrite_status");
}

describe("brain_skill_rewrite_status", () => {
  test("is registered as a read tool", () => {
    const definition = tool();
    expect(definition).toBeDefined();
    expect(definition?.kind).toBe("read");
  });

  test("reports the verified receipt, the grades and the pending rewrite", async () => {
    seedBenchmark();
    const spec = buildSkillRewriteSpec("example-skill", TASKS);
    const specHash = skillRewriteSpecHash(spec);
    recordSkillRewriteGrade(vault, {
      payload: {
        skill: "example-skill",
        spec_hash: specHash,
        tasks_hash: spec.tasksHash,
        metric: "tasks_passed_rate",
        seed: spec.seed,
        split_rule: spec.splitRule,
        verdict: SKILL_REWRITE_VERDICT.hold,
        baseline_rate: 0.5,
        candidate_rate: 0.5,
        dev: [{ task_id: "t-03", passed: false, failed_checks: ["tool_used"] }],
        held_out: [],
      },
    });
    stageScoredRewriteProposal(vault, {
      skill: {
        name: "example-skill",
        description: "Does a thing, safely.",
        triggers: ["thing"],
        body: "Candidate body.",
      },
      spec,
      specHash,
      baselineScore: 0.5,
      candidateScore: 0.9,
      heldoutScore: 1,
      incumbentVersion: 3,
    });

    const result = (await tool()?.handler(ctx, { skill_name: "example-skill" })) as {
      skill: string;
      receipt: {
        tasks_hash: string;
        spec_hash: string;
        take_verifies: boolean;
        take_reason: string | null;
      } | null;
      grades: ReadonlyArray<{ verdict: string; baseline_rate: number; spec_hash: string }>;
      pending_rewrite_slug: string | null;
    };

    expect(result.skill).toBe("example-skill");
    expect(result.receipt).not.toBeNull();
    expect(result.receipt?.take_verifies).toBe(true);
    expect(result.receipt?.spec_hash).toBe(specHash);
    expect(result.grades.length).toBe(1);
    expect(result.grades[0]?.verdict).toBe(SKILL_REWRITE_VERDICT.hold);
    expect(result.grades[0]?.spec_hash).toBe(specHash);
    const pending = listPendingSkillProposals(vault);
    expect(result.pending_rewrite_slug).toBe(pending[0]!.slug);
    // Ids and rates only: no task text, no transcript text anywhere.
    expect(JSON.stringify(result)).not.toContain("File the meeting summary");
  });

  test("a corrupt grade row is counted as unreadable, never rendered as a verdict", async () => {
    // Only external corruption reaches this read: the writer rebuilds
    // every payload field by field. A row the writer would have refused
    // must not surface as a plausible `hold` with zeroed rates on the
    // surface a human consults before accepting a rewrite - it is
    // dropped from the rows and counted by name.
    seedBenchmark();
    const spec = buildSkillRewriteSpec("example-skill", TASKS);
    const specHash = skillRewriteSpecHash(spec);
    recordSkillRewriteGrade(vault, {
      payload: {
        skill: "example-skill",
        spec_hash: specHash,
        tasks_hash: spec.tasksHash,
        metric: "tasks_passed_rate",
        seed: spec.seed,
        split_rule: spec.splitRule,
        verdict: SKILL_REWRITE_VERDICT.hold,
        baseline_rate: 0.5,
        candidate_rate: 0.5,
        dev: [{ task_id: "t-03", passed: false, failed_checks: ["tool_used"] }],
        held_out: [],
      },
    });
    appendContinuityRecord(vault, {
      kind: "skill_rewrite_eval_grade",
      createdAt: "2026-05-21T09:00:00Z",
      sourceRefs: [{ id: "src-corrupt" }],
      payload: {
        skill: "example-skill",
        spec_hash: specHash,
        verdict: "promte",
        baseline_rate: "not a number",
      },
    });

    const result = (await tool()?.handler(ctx, { skill_name: "example-skill" })) as {
      grades: ReadonlyArray<{ verdict: string; baseline_rate: number; candidate_rate: number }>;
      unreadable_grades: number;
    };
    expect(result.grades.length).toBe(1);
    expect(result.grades[0]?.verdict).toBe(SKILL_REWRITE_VERDICT.hold);
    expect(result.grades[0]?.baseline_rate).toBe(0.5);
    expect(result.unreadable_grades).toBe(1);
  });

  test("a skill with no benchmark is a named empty status, not an error", async () => {
    const result = (await tool()?.handler(ctx, { skill_name: "absent-skill" })) as {
      skill: string;
      receipt: unknown;
      grades: ReadonlyArray<unknown>;
      pending_rewrite_slug: string | null;
    };
    expect(result.skill).toBe("absent-skill");
    expect(result.receipt).toBeNull();
    expect(result.grades).toEqual([]);
    expect(result.pending_rewrite_slug).toBeNull();
  });

  test("the handler writes nothing", async () => {
    seedBenchmark();
    const before = listPendingSkillProposals(vault).length;
    await tool()?.handler(ctx, { skill_name: "example-skill" });
    expect(listPendingSkillProposals(vault).length).toBe(before);
  });

  test("a missing skill_name argument is refused", async () => {
    await expect(tool()?.handler(ctx, {})).rejects.toThrow(/skill_name/);
  });
});

describe("the MCP accept boundary", () => {
  test("accept refuses a scored_rewrite proposal and names the operator's command", async () => {
    // The design boundary (security M1c): MCP proposes, the operator
    // accepts. The proposal below is fully gate-valid - benchmark on disk,
    // matching promote grade record - so the refusal proves the boundary
    // itself, not a broken gate.
    seedBenchmark();
    const spec = buildSkillRewriteSpec("example-skill", TASKS);
    const specHash = skillRewriteSpecHash(spec);
    recordSkillRewriteGrade(vault, {
      payload: {
        skill: "example-skill",
        spec_hash: specHash,
        tasks_hash: spec.tasksHash,
        metric: "tasks_passed_rate",
        seed: spec.seed,
        split_rule: spec.splitRule,
        verdict: SKILL_REWRITE_VERDICT.promote,
        baseline_rate: 0.5,
        candidate_rate: 0.9,
        dev: [],
        held_out: [],
      },
    });
    stageScoredRewriteProposal(vault, {
      skill: {
        name: "example-skill",
        description: "Does a thing, safely.",
        triggers: ["thing"],
        body: "Candidate body.",
      },
      spec,
      specHash,
      baselineScore: 0.5,
      candidateScore: 0.9,
      heldoutScore: 1,
      incumbentVersion: 3,
    });
    const pending = listPendingSkillProposals(vault);
    expect(pending.length).toBe(1);
    const proposalsTool = PROCEDURE_TOOLS.find((t) => t.name === "brain_skill_proposals");

    let thrown: unknown = null;
    try {
      await proposalsTool?.handler(ctx, { operation: "accept", slug: pending[0]!.slug });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    const err = thrown as MCPError;
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.message).toContain("scored_rewrite");
    expect(err.message).toContain("skill-proposals accept");
    // Refused, not consumed: the draft is still pending for the operator.
    expect(listPendingSkillProposals(vault).length).toBe(1);
  });
});

function seedBenchmark(): void {
  const tasksPath = skillBenchmarkTasksPath(vault, "example-skill");
  mkdirSync(join(tasksPath, ".."), { recursive: true });
  writeFileSync(tasksPath, readFileSync(join(FIXTURE_DIR, "tasks.json"), "utf8"), "utf8");
  writeFileSync(
    skillBenchmarkSpecPath(vault, "example-skill"),
    readFileSync(join(FIXTURE_DIR, "spec.json"), "utf8"),
    "utf8",
  );
}

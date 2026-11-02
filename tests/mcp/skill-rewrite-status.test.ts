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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listPendingSkillProposals,
  recordSkillRewriteGrade,
  stageScoredRewriteProposal,
} from "../../src/core/brain/skill-proposals.ts";
import {
  buildSkillRewriteSpec,
  skillRewriteSpecHash,
  SKILL_REWRITE_VERDICT,
} from "../../src/core/brain/skill-rewrite-spec.ts";
import { parseSkillBenchmarkTasks } from "../../src/core/brain/skill-rewrite-tasks.ts";
import { skillBenchmarkSpecPath, skillBenchmarkTasksPath } from "../../src/core/brain/paths.ts";
import { PROCEDURE_TOOLS } from "../../src/mcp/brain/procedure-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

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

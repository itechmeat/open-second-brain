/**
 * The scored-rewrite apply path (agent-presence, Lane A, A4).
 *
 * A promoted candidate goes through the SAME pipeline every skill write
 * goes through: a pending proposal under `Brain/skill-proposals/`, a
 * human accept, a write-ahead journal, a compensating transaction. The
 * one growth the rewrite needs is content, not just existence: a rewrite
 * OVERWRITES an incumbent SKILL.md, so the journal captures the prior
 * bytes before the overwrite and a crash mid-accept rolls back to the
 * incumbent body. Gate failures stage nothing - a hold round writes only
 * the grade record.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONTINUITY_RECORD_KINDS,
  isContinuityRecordKind,
} from "../../../src/core/brain/continuity/types.ts";
import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import {
  parseSkillBenchmarkTasks,
  skillBenchmarkRelPath,
  SKILL_BENCHMARK_SPEC_FILE,
} from "../../../src/core/brain/skill-rewrite-tasks.ts";
import {
  skillAcceptPriorContentPath,
  skillBenchmarkRoundsDir,
  skillBenchmarkSpecPath,
  skillBenchmarkTasksPath,
} from "../../../src/core/brain/paths.ts";
import {
  buildSkillRewriteSpec,
  skillRewriteSpecHash,
  SKILL_REWRITE_SPEC_SCHEMA,
  SKILL_REWRITE_SPLIT_RULE,
  SKILL_REWRITE_VERDICT,
} from "../../../src/core/brain/skill-rewrite-spec.ts";
import {
  listPendingSkillProposals,
  recoverSkillProposalAccepts,
  SCORED_REWRITE_PATTERN_KIND,
  stageScoredRewriteProposal,
  recordSkillRewriteGrade,
  acceptSkillProposal,
} from "../../../src/core/brain/skill-proposals.ts";
import {
  readSkillAcceptJournals,
  writeSkillAcceptJournal,
} from "../../../src/core/brain/skill-accept-journal.ts";
import {
  resolveSkillRewriteJudgeCmd,
  SKILL_REWRITE_JUDGE_CMD_CONFIG_KEY,
  SKILL_REWRITE_JUDGE_CMD_ENV_KEY,
  SKILL_REWRITE_MODE_CONFIG_KEY,
  SKILL_REWRITE_MODE_ENV_KEY,
  resolveSkillRewriteModeConfig,
} from "../../../src/core/config.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { _resetHeldLocksForTests } from "../../../src/core/brain/sync-lockfile.ts";

let vault: string;
let skillsRoot: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rewrite-apply-"));
  skillsRoot = mkdtempSync(join(tmpdir(), "o2b-rewrite-skills-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  _resetHeldLocksForTests();
  rmSync(vault, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });
  delete process.env[SKILL_REWRITE_MODE_ENV_KEY];
  delete process.env[SKILL_REWRITE_JUDGE_CMD_ENV_KEY];
});

const TASKS = parseSkillBenchmarkTasks(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "..", "fixtures", "skill-bench", "example-skill", "tasks.json"),
      "utf8",
    ),
  ),
  "tasks.json",
);
const SPEC = buildSkillRewriteSpec(TASKS.skillName, TASKS);

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

const CANDIDATE_BODY = [
  "# example-skill",
  "",
  "Candidate body: plan first, search twice, write once, and report the artifact path.",
].join("\n");

function writeIncumbent(): string {
  const skillDir = join(skillsRoot, "example-skill");
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path, INCUMBENT_BODY, "utf8");
  return path;
}

function stagePromoted(): { slug: string; specHash: string } {
  const specHash = skillRewriteSpecHash(SPEC);
  const result = stageScoredRewriteProposal(vault, {
    skill: {
      name: TASKS.skillName,
      description: "Does a thing, safely.",
      triggers: ["thing"],
      body: CANDIDATE_BODY,
    },
    spec: SPEC,
    specHash,
    baselineScore: 0.4,
    candidateScore: 0.7,
    heldoutScore: 1,
    incumbentVersion: 3,
  });
  if (result.outcome !== "created")
    throw new Error(`test setup: staging declined: ${result.outcome}`);
  return { slug: result.slug, specHash };
}

describe("the scored_rewrite pattern kind", () => {
  test("is exported and joins the pattern-kind union", () => {
    expect(SCORED_REWRITE_PATTERN_KIND).toBe("scored_rewrite");
  });

  test("a promoted candidate stages a pending proposal with the scored contract", () => {
    const { slug, specHash } = stagePromoted();
    const pending = listPendingSkillProposals(vault);
    expect(pending.map((proposal) => proposal.slug)).toEqual([slug]);
    expect(pending[0]?.patternKind).toBe(SCORED_REWRITE_PATTERN_KIND);

    const [fm] = parseFrontmatter(
      join(vault, "Brain", "skill-proposals", "pending", `prop-${slug}.md`),
    );
    expect(fm["rewrites_skill"]).toBe("example-skill");
    expect(fm["spec_hash"]).toBe(specHash);
    expect(fm["baseline_score"]).toBe("0.400");
    expect(fm["candidate_score"]).toBe("0.700");
    expect(fm["heldout_score"]).toBe("1.000");
    expect(fm["skill_name"]).toBe("example-skill");
    // The version bump rides staging: incumbent 3, staged proposal 4.
    expect(Number(fm["version"])).toBe(4);
  });

  test("acceptance goes through acceptSkillProposal unchanged and bumps the version", () => {
    const { slug } = stagePromoted();
    writeIncumbent();
    const accepted = acceptSkillProposal(vault, slug, { skillsRoot, note: "gate passed" });
    expect(accepted.status).toBe("accepted");
    expect(accepted.skillPath).toBe(join(skillsRoot, "example-skill", "SKILL.md"));
    expect(existsSync(join(vault, "Brain", "skill-proposals", "pending", `prop-${slug}.md`))).toBe(
      false,
    );

    const [fm, body] = parseFrontmatter(join(skillsRoot, "example-skill", "SKILL.md"));
    expect(Number(fm["version"])).toBe(4);
    expect(body).toContain("Candidate body: plan first");
    expect(existsSync(join(vault, "Brain", "skill-proposals", "accepted", `prop-${slug}.md`))).toBe(
      true,
    );
  });
});

describe("the journal captures prior content", () => {
  test("priorContentPath round-trips through the journal", () => {
    const { slug } = stagePromoted();
    const priorPath = join(vault, "Brain", "skill-proposals", "accept-journal", `${slug}.prior.md`);
    writeSkillAcceptJournal(vault, {
      slug,
      id: `prop-${slug}`,
      phase: "materialize",
      startedAt: "2026-06-01T09:00:00.000Z",
      acceptedExisted: false,
      materializedExisted: true,
      materializedPath: join(skillsRoot, "example-skill", "SKILL.md"),
      priorContentPath: priorPath,
    });
    const [entry] = readSkillAcceptJournals(vault).entries;
    expect(entry?.priorContentPath).toBe(priorPath);

    writeSkillAcceptJournal(vault, {
      slug,
      id: `prop-${slug}`,
      phase: "archive",
      startedAt: "2026-06-01T09:00:00.000Z",
      acceptedExisted: false,
      materializedExisted: false,
    });
    const [without] = readSkillAcceptJournals(vault).entries;
    expect(without?.priorContentPath).toBeUndefined();
  });

  test("a crash mid-accept rolls back to the incumbent BODY, not just existence", () => {
    const { slug } = stagePromoted();
    const skillPath = writeIncumbent();
    // The overwrite landed, then the process died before the commit.
    writeFileSync(
      skillPath,
      "---\nname: example-skill\ndescription: x\nversion: 4\n---\n\nCandidate body: plan first\n",
      "utf8",
    );
    const priorPath = join(vault, "Brain", "skill-proposals", "accept-journal", `${slug}.prior.md`);
    mkdirSync(dirname(priorPath), { recursive: true });
    writeFileSync(priorPath, INCUMBENT_BODY, "utf8");
    writeSkillAcceptJournal(vault, {
      slug,
      id: `prop-${slug}`,
      phase: "materialize",
      startedAt: "2026-06-01T09:00:00.000Z",
      acceptedExisted: false,
      materializedExisted: true,
      materializedPath: skillPath,
      priorContentPath: priorPath,
    });

    const recovered = recoverSkillProposalAccepts(vault);
    expect(recovered.map((entry) => entry.action)).toEqual(["rolled_back"]);
    // Content, not just existence: the incumbent bytes are back.
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
    // The repair artifacts are consumed once the sequence is resolved.
    expect(existsSync(priorPath)).toBe(false);
    expect(readSkillAcceptJournals(vault).entries).toEqual([]);
  });

  test("without a captured prior copy the incumbent is left untouched", () => {
    const { slug } = stagePromoted();
    const skillPath = writeIncumbent();
    writeSkillAcceptJournal(vault, {
      slug,
      id: `prop-${slug}`,
      phase: "materialize",
      startedAt: "2026-06-01T09:00:00.000Z",
      acceptedExisted: false,
      materializedExisted: true,
      materializedPath: skillPath,
    });
    const recovered = recoverSkillProposalAccepts(vault);
    expect(recovered.map((entry) => entry.action)).toEqual(["rolled_back"]);
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
  });
});

describe("the skill_rewrite_eval_grade continuity kind", () => {
  test("is in the union and the runtime kind list in the same edit", () => {
    expect(isContinuityRecordKind("skill_rewrite_eval_grade")).toBe(true);
    expect(CONTINUITY_RECORD_KINDS).toContain("skill_rewrite_eval_grade");
  });

  test("a hold round writes only the grade record and stages nothing", () => {
    const before = listPendingSkillProposals(vault).length;
    const record = recordSkillRewriteGrade(vault, {
      payload: {
        skill: TASKS.skillName,
        spec_hash: skillRewriteSpecHash(SPEC),
        tasks_hash: SPEC.tasksHash,
        metric: "tasks_passed_rate",
        seed: SPEC.seed,
        split_rule: SPEC.splitRule,
        verdict: SKILL_REWRITE_VERDICT.hold,
        baseline_rate: 0.5,
        candidate_rate: 0.5,
        dev: [],
        held_out: [],
      },
    });
    expect(record.kind).toBe("skill_rewrite_eval_grade");
    const grades = listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" });
    expect(grades.length).toBe(1);
    expect(grades[0]?.payload["verdict"]).toBe(SKILL_REWRITE_VERDICT.hold);
    expect(grades[0]?.payload).not.toHaveProperty("task_text");
    // The proposal tree is unchanged: gate failures stage nothing.
    expect(listPendingSkillProposals(vault).length).toBe(before);
  });
});

describe("the config keys", () => {
  test("skill_rewrite.mode resolves from the env twin and refuses unknown values by name", () => {
    expect(resolveSkillRewriteModeConfig()).toBe("gated");
    process.env[SKILL_REWRITE_MODE_ENV_KEY] = "iterative";
    expect(resolveSkillRewriteModeConfig()).toBe("iterative");
    process.env[SKILL_REWRITE_MODE_ENV_KEY] = "turbo";
    expect(() => resolveSkillRewriteModeConfig()).toThrow(/turbo/);
  });

  test("skill_rewrite.mode resolves from the config file's flat dotted key", () => {
    const configPath = join(vault, "brain-config.yaml");
    writeFileSync(configPath, `${SKILL_REWRITE_MODE_CONFIG_KEY}: iterative\n`, "utf8");
    expect(resolveSkillRewriteModeConfig(configPath)).toBe("iterative");
  });

  test("skill_rewrite_judge_cmd resolves from the env twin and the config file", () => {
    expect(resolveSkillRewriteJudgeCmd()).toBeUndefined();
    process.env[SKILL_REWRITE_JUDGE_CMD_ENV_KEY] = "jq .verdicts";
    expect(resolveSkillRewriteJudgeCmd()).toBe("jq .verdicts");
    delete process.env[SKILL_REWRITE_JUDGE_CMD_ENV_KEY];
    const configPath = join(vault, "brain-config.yaml");
    writeFileSync(configPath, `${SKILL_REWRITE_JUDGE_CMD_CONFIG_KEY}: jq .verdicts\n`, "utf8");
    expect(resolveSkillRewriteJudgeCmd(configPath)).toBe("jq .verdicts");
  });
});

describe("the benchmark paths", () => {
  test("the spec receipt names the committed fixture layout", () => {
    expect(skillBenchmarkRelPath("example-skill", SKILL_BENCHMARK_SPEC_FILE)).toBe(
      "Brain/skill-benchmarks/example-skill/spec.json",
    );
    expect(SKILL_REWRITE_SPEC_SCHEMA).toBe("o2b.skill-rewrite.v1");
    expect(SKILL_REWRITE_SPLIT_RULE).toBe("hash-order-70-30");
  });

  test("the vault-side resolvers stay inside the vault", () => {
    expect(skillBenchmarkTasksPath(vault, "example-skill")).toBe(
      join(vault, "Brain", "skill-benchmarks", "example-skill", "tasks.json"),
    );
    expect(skillBenchmarkSpecPath(vault, "example-skill")).toBe(
      join(vault, "Brain", "skill-benchmarks", "example-skill", "spec.json"),
    );
    expect(skillBenchmarkRoundsDir(vault, "example-skill")).toBe(
      join(vault, "Brain", "skill-benchmarks", "example-skill", "rounds"),
    );
    expect(skillAcceptPriorContentPath(vault, "some-slug")).toBe(
      join(vault, "Brain", "skill-proposals", "accept-journal", "some-slug.prior.md"),
    );
  });
});

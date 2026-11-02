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

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "fixtures", "skill-bench", "example-skill");
const TASKS_DOCUMENT = readFileSync(join(FIXTURE_DIR, "tasks.json"), "utf8");
const SPEC_DOCUMENT = readFileSync(join(FIXTURE_DIR, "spec.json"), "utf8");
const TASKS = parseSkillBenchmarkTasks(JSON.parse(TASKS_DOCUMENT), "tasks.json");
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

/**
 * The incumbent at the vault's own default skills root. The rollback
 * validation (review security M4) confines a restore target to the vault
 * and the resolved skills root, so the crash-recovery fixtures stage their
 * incumbents here - a path both arms of that confinement admit.
 */
function writeIncumbentUnderVaultSkills(): string {
  const skillPath = join(vault, "Brain", "skills", "example-skill", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, INCUMBENT_BODY, "utf8");
  return skillPath;
}

/** The benchmark receipt files on disk, as a completed gate round leaves them. */
function seedBenchmark(
  mutateTasks?: (raw: { tasks: Array<Record<string, unknown>> }) => void,
): void {
  const raw = JSON.parse(TASKS_DOCUMENT) as { tasks: Array<Record<string, unknown>> };
  if (mutateTasks) mutateTasks(raw);
  const tasksPath = skillBenchmarkTasksPath(vault, TASKS.skillName);
  mkdirSync(dirname(tasksPath), { recursive: true });
  writeFileSync(tasksPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  writeFileSync(skillBenchmarkSpecPath(vault, TASKS.skillName), SPEC_DOCUMENT, "utf8");
}

/** The gate's final promote, as rewrite-score appends it after staging. */
function recordPromoteGrade(opts: { readonly candidateRate?: number } = {}): string {
  return recordSkillRewriteGrade(vault, {
    payload: {
      skill: TASKS.skillName,
      spec_hash: skillRewriteSpecHash(SPEC),
      tasks_hash: SPEC.tasksHash,
      metric: "tasks_passed_rate",
      seed: SPEC.seed,
      split_rule: SPEC.splitRule,
      verdict: SKILL_REWRITE_VERDICT.promote,
      baseline_rate: 0.4,
      candidate_rate: opts.candidateRate ?? 0.7,
      dev: [],
      held_out: [],
    },
  }).id;
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

/** Everything a completed gate round leaves behind, incumbent included. */
function seedCompletedGateRound(): { slug: string; skillPath: string } {
  const { slug } = stagePromoted();
  seedBenchmark();
  recordPromoteGrade();
  const skillPath = writeIncumbent();
  return { slug, skillPath };
}

function pendingPathFor(slug: string): string {
  return join(vault, "Brain", "skill-proposals", "pending", `prop-${slug}.md`);
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
    // The designed flow: a completed gate round leaves the benchmark receipt
    // and the promote grade record behind, and the human accept re-verifies
    // both before anything is written (review security M1).
    const { slug } = seedCompletedGateRound();
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
    // The restore target sits under the vault's own skills root: a
    // hand-edited journal naming a path outside the vault and the resolved
    // skills root is refused by name (pinned in the rollback-confinement
    // describe below), so the recovery fixtures stage the incumbent where a
    // real accept would resolve it.
    const skillPath = writeIncumbentUnderVaultSkills();
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

describe("the accept-time gate re-verification", () => {
  // The five refusals below are the accept boundary the security review
  // asked for (M1): field presence alone never overwrites an incumbent.
  // Each test hands `acceptSkillProposal` a proposal that passes the old
  // field checks and asserts the new gate refuses it by name, with the
  // incumbent bytes untouched and the draft still pending.

  test("a swapped task set invalidates the proposal and refuses the accept", () => {
    const { slug, skillPath } = seedCompletedGateRound();
    // The task set moved AFTER the gate ran; the spec receipt is unchanged,
    // so the take re-verification is the layer that names the swap.
    seedBenchmark((raw) => {
      raw.tasks[0] = { ...raw.tasks[0], input: "A changed task input line." };
    });

    expect(() => acceptSkillProposal(vault, slug, { skillsRoot })).toThrow(
      /does not match the receipt's frozen hash/,
    );
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
    expect(existsSync(pendingPathFor(slug))).toBe(true);
  });

  test("an edited spec invalidates the proposal and refuses the accept by spec hash", () => {
    const { slug, skillPath } = seedCompletedGateRound();
    // The spec receipt itself was rewritten after the gate ran: its hash no
    // longer equals the proposal's spec_hash, so the proposal is refused
    // before the gate's claim is re-scoped.
    const editedSpec = JSON.parse(SPEC_DOCUMENT) as Record<string, unknown>;
    editedSpec["min_dev_tasks"] = 1;
    writeFileSync(
      skillBenchmarkSpecPath(vault, TASKS.skillName),
      `${JSON.stringify(editedSpec, null, 2)}\n`,
      "utf8",
    );

    expect(() => acceptSkillProposal(vault, slug, { skillsRoot })).toThrow(/spec hash/);
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
    expect(existsSync(pendingPathFor(slug))).toBe(true);
  });

  test("a benchmark missing from the vault refuses the accept by name", () => {
    const { slug } = stagePromoted();
    recordPromoteGrade();
    const skillPath = writeIncumbent();

    expect(() => acceptSkillProposal(vault, slug, { skillsRoot })).toThrow(/benchmark/);
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
    expect(existsSync(pendingPathFor(slug))).toBe(true);
  });

  test("no promote grade record matching the spec hash, no accept", () => {
    const { slug } = stagePromoted();
    seedBenchmark();
    const skillPath = writeIncumbent();
    // A hold round wrote its record, but the gate's final promote is absent.
    recordSkillRewriteGrade(vault, {
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

    expect(() => acceptSkillProposal(vault, slug, { skillsRoot })).toThrow(
      /no skill_rewrite_eval_grade record/,
    );
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
    expect(existsSync(pendingPathFor(slug))).toBe(true);
  });

  test("a promote record for a different candidate rate does not satisfy the gate", () => {
    const { slug } = stagePromoted();
    seedBenchmark();
    recordPromoteGrade({ candidateRate: 0.9 });
    const skillPath = writeIncumbent();

    expect(() => acceptSkillProposal(vault, slug, { skillsRoot })).toThrow(
      /no skill_rewrite_eval_grade record/,
    );
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
    expect(existsSync(pendingPathFor(slug))).toBe(true);
  });

  test("a proposal claiming to rewrite one skill while materializing another refuses", () => {
    const { slug, skillPath } = seedCompletedGateRound();
    // Hand-edited frontmatter: the rewrite claim and the materialize target
    // must name the same skill (self-review B-3, security M1d).
    const pendingPath = pendingPathFor(slug);
    const forged = readFileSync(pendingPath, "utf8").replace(
      /^rewrites_skill: .*$/m,
      "rewrites_skill: other-skill",
    );
    expect(forged).toContain("rewrites_skill: other-skill");
    writeFileSync(pendingPath, forged, "utf8");

    expect(() => acceptSkillProposal(vault, slug, { skillsRoot })).toThrow(
      /other-skill.*example-skill|example-skill.*other-skill/,
    );
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
    expect(existsSync(pendingPath)).toBe(true);
  });

  test("a corrupted scored draft refuses the accept before anything is written", () => {
    // Test-audit F2(b): the scored-contract validation runs before the
    // journal is stamped. Every other gate input here is valid, so
    // deleting the validation call would let this accept succeed and fail
    // this test - the pin is load-bearing, not decorative.
    const { slug, skillPath } = seedCompletedGateRound();
    const pendingPath = pendingPathFor(slug);
    const corrupted = readFileSync(pendingPath, "utf8").replace(
      /^baseline_score: .*$/m,
      "baseline_score: abc",
    );
    expect(corrupted).toContain("baseline_score: abc");
    writeFileSync(pendingPath, corrupted, "utf8");

    expect(() => acceptSkillProposal(vault, slug, { skillsRoot })).toThrow(/baseline_score/);
    expect(readFileSync(skillPath, "utf8")).toBe(INCUMBENT_BODY);
    expect(existsSync(pendingPath)).toBe(true);
  });
});

describe("the rollback guards", () => {
  test("a missing prior-content copy is a named refusal that keeps the journal", () => {
    // Test-audit F2(a): swallowing the read error would silently leave the
    // CANDIDATE body on an incumbent's path, so the refusal is pinned
    // exactly - message names the copy, journal survives, nothing restored.
    const { slug } = stagePromoted();
    const skillPath = writeIncumbentUnderVaultSkills();
    writeFileSync(
      skillPath,
      "---\nname: example-skill\ndescription: x\nversion: 4\n---\n\nCandidate body: plan first\n",
      "utf8",
    );
    const priorPath = join(vault, "Brain", "skill-proposals", "accept-journal", `${slug}.prior.md`);
    // The copy itself is NOT written: it is missing, the way a crash or a
    // hand-cleaned repair directory leaves it.
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

    expect(() => recoverSkillProposalAccepts(vault)).toThrow(/prior-content copy is missing/);
    // The journal is retained so the operator decides, and the candidate
    // body was not quietly ratified by a cleared journal.
    expect(readSkillAcceptJournals(vault).entries.length).toBe(1);
    expect(readFileSync(skillPath, "utf8")).toContain("Candidate body: plan first");
  });

  test("a restore target outside the vault and the skills root refuses by name", () => {
    // Review security M4: the journal's materialized_path is not a recovery
    // input. A hand-edited journal aiming the restore at a file outside the
    // vault and the resolved skills root must be refused, leaving the
    // target untouched and the journal on disk.
    const { slug } = stagePromoted();
    const victimDir = mkdtempSync(join(tmpdir(), "o2b-rewrite-victim-"));
    try {
      const victim = join(victimDir, "victim.md");
      writeFileSync(victim, "operator bytes", "utf8");
      const priorPath = join(
        vault,
        "Brain",
        "skill-proposals",
        "accept-journal",
        `${slug}.prior.md`,
      );
      mkdirSync(dirname(priorPath), { recursive: true });
      writeFileSync(priorPath, INCUMBENT_BODY, "utf8");
      writeSkillAcceptJournal(vault, {
        slug,
        id: `prop-${slug}`,
        phase: "materialize",
        startedAt: "2026-06-01T09:00:00.000Z",
        acceptedExisted: false,
        materializedExisted: true,
        materializedPath: victim,
        priorContentPath: priorPath,
      });

      expect(() => recoverSkillProposalAccepts(vault)).toThrow(/materialized path/);
      expect(readSkillAcceptJournals(vault).entries.length).toBe(1);
      expect(readFileSync(victim, "utf8")).toBe("operator bytes");
    } finally {
      rmSync(victimDir, { recursive: true, force: true });
    }
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

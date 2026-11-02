/**
 * The rewrite-spec kernel (agent-presence, Lane A, A2).
 *
 * A rewrite spec is a preregistration with mechanical teeth: it freezes
 * the task-set hash, the seed, the split rule and the derived dev and
 * held-out membership into one content-hashed receipt, so a benchmark
 * that changes under a gate run is refused by name instead of quietly
 * re-scoping the claim. The committed fixture spec pins the receipt for
 * the example task set; the tests bind the two.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SKILL_REWRITE_DEFAULT_SEED,
  SKILL_REWRITE_DEV_FRACTION,
  SKILL_REWRITE_METRIC,
  SKILL_REWRITE_MIN_DEV_TASKS,
  SKILL_REWRITE_MIN_TASKS,
  SKILL_REWRITE_REQUIRED_MARGIN,
  SKILL_REWRITE_SPEC_SCHEMA,
  SKILL_REWRITE_SPLIT_RULE,
  SKILL_REWRITE_VERDICT,
  SKILL_REWRITE_VERDICTS,
  buildSkillRewriteSpec,
  isSkillRewriteVerdict,
  parseSkillRewriteSpec,
  skillRewriteSpecHash,
  verifyRewriteTake,
} from "../../../src/core/brain/skill-rewrite-spec.ts";
import { parseSkillBenchmarkTasks } from "../../../src/core/brain/skill-rewrite-tasks.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "tests", "fixtures", "skill-bench", "example-skill");

const TASKS = parseSkillBenchmarkTasks(
  JSON.parse(readFileSync(join(FIXTURE_PATH, "tasks.json"), "utf8")),
  "tasks.json",
);
const SPEC = JSON.parse(readFileSync(join(FIXTURE_PATH, "spec.json"), "utf8"));

describe("spec constants and verdict vocabulary", () => {
  test("the schema, split rule and metric are pinned", () => {
    expect(SKILL_REWRITE_SPEC_SCHEMA).toBe("o2b.skill-rewrite.v1");
    expect(SKILL_REWRITE_SPLIT_RULE).toBe("hash-order-70-30");
    expect(SKILL_REWRITE_METRIC).toBe("tasks_passed_rate");
    expect(SKILL_REWRITE_DEV_FRACTION).toBe(0.7);
  });

  test("the verdict vocabulary is frozen and answered by its guard", () => {
    expect(Object.isFrozen(SKILL_REWRITE_VERDICT)).toBe(true);
    expect(Object.isFrozen(SKILL_REWRITE_VERDICTS)).toBe(true);
    expect([...SKILL_REWRITE_VERDICTS].toSorted()).toEqual([
      "hold",
      "not_enough_evidence",
      "promote",
    ]);
    for (const verdict of SKILL_REWRITE_VERDICTS) expect(isSkillRewriteVerdict(verdict)).toBe(true);
    expect(isSkillRewriteVerdict("ship_it")).toBe(false);
    expect(isSkillRewriteVerdict(undefined)).toBe(false);
  });

  test("gate constants carry their reasons in one place", () => {
    expect(SKILL_REWRITE_REQUIRED_MARGIN).toBeGreaterThan(0);
    expect(SKILL_REWRITE_MIN_DEV_TASKS).toBeGreaterThanOrEqual(1);
    expect(SKILL_REWRITE_MIN_TASKS).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(SKILL_REWRITE_DEFAULT_SEED)).toBe(true);
  });
});

describe("buildSkillRewriteSpec", () => {
  test("derives the receipt deterministically from the seed and split rule", () => {
    const first = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    const second = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(SKILL_REWRITE_SPEC_SCHEMA);
    expect(first.tasksHash).toBe(TASKS.hash);
    expect(first.splitRule).toBe(SKILL_REWRITE_SPLIT_RULE);
    expect(first.seed).toBe(SKILL_REWRITE_DEFAULT_SEED);
    expect(first.requiredMargin).toBe(SKILL_REWRITE_REQUIRED_MARGIN);
    expect(first.minDevTasks).toBe(SKILL_REWRITE_MIN_DEV_TASKS);
  });

  test("an explicit seed changes the receipt deterministically", () => {
    const seeded = buildSkillRewriteSpec(TASKS.skillName, TASKS, { seed: 7 });
    expect(seeded.seed).toBe(7);
    const again = buildSkillRewriteSpec(TASKS.skillName, TASKS, { seed: 7 });
    expect(again).toEqual(seeded);
  });

  test("the receipt covers every task id exactly once across the two arms", () => {
    const spec = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    const every = [...spec.devTaskIds, ...spec.heldoutTaskIds].toSorted();
    const taskIds = TASKS.tasks.map((task) => task.id).toSorted();
    expect(every).toEqual(taskIds);
    expect(spec.devTaskIds.length + spec.heldoutTaskIds.length).toBe(TASKS.tasks.length);
  });

  test("the dev share follows the split rule and both arms stay non-empty", () => {
    const spec = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    expect(spec.devTaskIds.length).toBe(Math.ceil(TASKS.tasks.length * SKILL_REWRITE_DEV_FRACTION));
    expect(spec.devTaskIds.length).toBeGreaterThan(0);
    expect(spec.heldoutTaskIds.length).toBeGreaterThan(0);
  });

  test("a task set too small to split is refused by name", () => {
    const raw = {
      skill: "tiny-skill",
      tasks: [
        {
          id: "only-1",
          kind: "invocation_transcript",
          input: "one",
          expects: [{ check: "tool_used", tool: "note_search" }],
        },
        {
          id: "only-2",
          kind: "invocation_transcript",
          input: "two",
          expects: [{ check: "tool_used", tool: "note_search" }],
        },
      ],
    };
    const set = parseSkillBenchmarkTasks(raw, "tiny.json");
    expect(() => buildSkillRewriteSpec(set.skillName, set)).toThrow(/too small to split|minimum/i);
  });
});

describe("verifyRewriteTake", () => {
  test("accepts the matching task set", () => {
    const spec = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    const verdict = verifyRewriteTake(spec, TASKS);
    expect(verdict).toEqual({ ok: true, reason: null });
  });

  test("refuses a changed task set with the hash in the reason", () => {
    const spec = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    const touched = structuredClone(
      JSON.parse(readFileSync(join(FIXTURE_PATH, "tasks.json"), "utf8")),
    ) as { skill: string; tasks: Array<{ input: string }> };
    touched.tasks[0]!.input = `${touched.tasks[0]!.input} edited`;
    const moved = parseSkillBenchmarkTasks(touched, "moved.json");
    const verdict = verifyRewriteTake(spec, moved);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(moved.hash);
  });

  test("refuses a receipt the split no longer derives", () => {
    const spec = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    const swapped = {
      ...spec,
      devTaskIds: [spec.devTaskIds[0]!, ...spec.heldoutTaskIds.slice(0, 1)],
      heldoutTaskIds: [...spec.heldoutTaskIds.slice(1), spec.devTaskIds[1]!],
    };
    const verdict = verifyRewriteTake(swapped, TASKS);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).not.toBeNull();
    expect(verdict.reason?.toLowerCase()).toContain("split");
  });

  test("refuses a spec naming a different skill", () => {
    const spec = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    const renamed = { ...spec, skillName: "other-skill" };
    const verdict = verifyRewriteTake(renamed, TASKS);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason?.toLowerCase()).toContain("skill");
  });
});

describe("parseSkillRewriteSpec", () => {
  test("accepts the committed fixture spec", () => {
    const spec = parseSkillRewriteSpec(SPEC, "spec.json");
    expect(spec.skillName).toBe("example-skill");
    expect(spec.tasksHash).toBe(TASKS.hash);
    expect(spec.devTaskIds.length + spec.heldoutTaskIds.length).toBe(TASKS.tasks.length);
    expect(Object.isFrozen(spec)).toBe(true);
  });

  test("the committed fixture receipt verifies against the committed task set", () => {
    const spec = parseSkillRewriteSpec(SPEC, "spec.json");
    expect(verifyRewriteTake(spec, TASKS)).toEqual({ ok: true, reason: null });
  });

  test("an unknown schema version is refused by name", () => {
    const mutated = {
      ...(SPEC as Record<string, unknown>),
      schema_version: "o2b.skill-rewrite.v9",
    };
    expect(() => parseSkillRewriteSpec(mutated, "spec.json")).toThrow(/schema version/);
  });

  test("refuses malformed fields by name", () => {
    const base = SPEC as Record<string, unknown>;
    const refusing = (mutate: (draft: Record<string, unknown>) => void, fragment: string): void => {
      const draft = structuredClone(base);
      mutate(draft);
      try {
        parseSkillRewriteSpec(draft, "spec.json");
      } catch (error) {
        expect((error as Error).message).toContain(fragment);
        return;
      }
      throw new Error(`expected a refusal containing "${fragment}"`);
    };
    refusing((draft) => delete draft["skill_name"], "skill");
    refusing((draft) => delete draft["tasks_hash"], "tasks_hash");
    refusing((draft) => (draft["tasks_hash"] = "short"), "sha-256");
    refusing((draft) => (draft["split_rule"] = "hash-order-30-70"), "split rule");
    refusing((draft) => (draft["required_margin"] = 1.5), "required_margin");
    refusing((draft) => (draft["required_margin"] = -1), "required_margin");
    refusing((draft) => (draft["min_dev_tasks"] = 0), "min_dev_tasks");
    refusing((draft) => (draft["seed"] = "zero"), "seed");
    refusing((draft) => {
      draft["dev_task_ids"] = [
        ...(draft["dev_task_ids"] as string[]),
        draft["held_out_task_ids"][0],
      ];
    }, "disjoint");
    refusing((draft) => (draft["dev_task_ids"] = []), "dev_task_ids must be a non-empty array");
    refusing(
      (draft) => (draft["held_out_task_ids"] = []),
      "held_out_task_ids must be a non-empty array",
    );
  });
});

describe("skillRewriteSpecHash", () => {
  test("is stable across calls and moves when the spec moves", () => {
    const spec = buildSkillRewriteSpec(TASKS.skillName, TASKS);
    expect(skillRewriteSpecHash(spec)).toBe(skillRewriteSpecHash(spec));
    const tightened = { ...spec, requiredMargin: spec.requiredMargin + 0.05 };
    expect(skillRewriteSpecHash(tightened)).not.toBe(skillRewriteSpecHash(spec));
  });

  test("the built spec hash matches the committed fixture hash", () => {
    const spec = parseSkillRewriteSpec(SPEC, "spec.json");
    const rebuilt = buildSkillRewriteSpec(spec.skillName, TASKS, { seed: spec.seed });
    expect(skillRewriteSpecHash(rebuilt)).toBe(skillRewriteSpecHash(spec));
  });
});

describe("the kernel stays a true leaf", () => {
  test("it imports nothing beyond the digest and the task kernel", () => {
    const text = readFileSync(
      join(REPO_ROOT, "src", "core", "brain", "skill-rewrite-spec.ts"),
      "utf8",
    );
    const imports = [...text.matchAll(/^import\s[^;]*?from\s*"([^"]+)"/gm)].map((m) => m[1]!);
    const allowed = new Set(["../integrity/digest.ts", "./skill-rewrite-tasks.ts"]);
    const unexpected = imports.filter((specifier) => !allowed.has(specifier));
    expect(unexpected).toEqual([]);
  });
});

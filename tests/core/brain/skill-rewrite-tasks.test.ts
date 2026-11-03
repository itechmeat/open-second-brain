/**
 * The per-skill benchmark task-set kernel (agent-presence, Lane A, A1).
 *
 * The parser is the only door to a task set: every malformed shape is a
 * named error carrying the source the document was read from, the
 * vocabularies are frozen and answered by their guards, and the hash is
 * the one digest encoding over the canonical task list - stable across
 * parses and key order, sensitive to any task byte, because a spec
 * freezes that hash as its receipt.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SKILL_BENCHMARKS_DIR,
  SKILL_BENCHMARKS_ROOT_REL,
  SKILL_BENCH_CHECK,
  SKILL_BENCH_CHECKS,
  SKILL_BENCH_TASK_ID_RE,
  SKILL_BENCH_TASK_KIND,
  SKILL_BENCH_TASK_KINDS,
  SKILL_BENCH_VALUE_CLASS,
  SKILL_BENCH_VALUE_CLASSES,
  isSkillBenchCheck,
  isSkillBenchTaskKind,
  isSkillBenchValueClass,
  parseSkillBenchmarkTasks,
  skillBenchmarkRelPath,
  skillBenchmarkTaskSetHash,
} from "../../../src/core/brain/skill-rewrite-tasks.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "tests", "fixtures", "skill-bench", "example-skill");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_PATH, name), "utf8"));
}

describe("skill-benchmark path constants", () => {
  test("the benchmark root composes from the Brain root and the directory name", () => {
    expect(SKILL_BENCHMARKS_DIR).toBe("skill-benchmarks");
    expect(SKILL_BENCHMARKS_ROOT_REL).toBe("Brain/skill-benchmarks");
    expect(skillBenchmarkRelPath("example-skill", "tasks.json")).toBe(
      "Brain/skill-benchmarks/example-skill/tasks.json",
    );
  });
});

describe("closed vocabularies", () => {
  test("task kinds are frozen and answered by their guard", () => {
    expect(Object.isFrozen(SKILL_BENCH_TASK_KIND)).toBe(true);
    expect(Object.isFrozen(SKILL_BENCH_TASK_KINDS)).toBe(true);
    expect([...SKILL_BENCH_TASK_KINDS]).toEqual(["invocation_transcript"]);
    expect(isSkillBenchTaskKind("invocation_transcript")).toBe(true);
    expect(isSkillBenchTaskKind("freeform_chat")).toBe(false);
    expect(isSkillBenchTaskKind(42)).toBe(false);
  });

  test("checks are frozen and answered by their guard", () => {
    expect(Object.isFrozen(SKILL_BENCH_CHECK)).toBe(true);
    expect(Object.isFrozen(SKILL_BENCH_CHECKS)).toBe(true);
    expect([...SKILL_BENCH_CHECKS]).toEqual([
      "tool_used",
      "artifact_created",
      "step_order",
      "forbidden_step",
      "output_field",
    ]);
    for (const check of SKILL_BENCH_CHECKS) expect(isSkillBenchCheck(check)).toBe(true);
    expect(isSkillBenchCheck("vibe_score")).toBe(false);
    expect(isSkillBenchCheck(undefined)).toBe(false);
  });

  test("output value classes are frozen and answered by their guard", () => {
    expect(Object.isFrozen(SKILL_BENCH_VALUE_CLASS)).toBe(true);
    expect(Object.isFrozen(SKILL_BENCH_VALUE_CLASSES)).toBe(true);
    expect([...SKILL_BENCH_VALUE_CLASSES].toSorted()).toEqual([
      "boolean",
      "non_empty_array",
      "non_empty_string",
      "number",
    ]);
    for (const valueClass of SKILL_BENCH_VALUE_CLASSES) {
      expect(isSkillBenchValueClass(valueClass)).toBe(true);
    }
    expect(isSkillBenchValueClass("any")).toBe(false);
  });

  test("task ids stay filename-safe", () => {
    expect(SKILL_BENCH_TASK_ID_RE.test("t-01")).toBe(true);
    expect(SKILL_BENCH_TASK_ID_RE.test("step_2.json")).toBe(true);
    expect(SKILL_BENCH_TASK_ID_RE.test("../escape")).toBe(false);
    expect(SKILL_BENCH_TASK_ID_RE.test("has space")).toBe(false);
  });
});

describe("parseSkillBenchmarkTasks", () => {
  test("accepts the committed example fixture", () => {
    const set = parseSkillBenchmarkTasks(loadFixture("tasks.json"), "tasks.json");
    expect(set.skillName).toBe("example-skill");
    expect(set.tasks.length).toBe(10);
    expect(set.tasks[0]?.kind).toBe("invocation_transcript");
    expect(set.tasks[0]?.expects[0]).toEqual({ check: "tool_used", tool: "note_write" });
    // The parsed set is frozen at every level, so a caller cannot mutate
    // a receipt after the hash was taken over it.
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.tasks)).toBe(true);
    expect(Object.isFrozen(set.tasks[0]?.expects)).toBe(true);
  });

  test("every parsed task id is filename-safe", () => {
    const set = parseSkillBenchmarkTasks(loadFixture("tasks.json"), "tasks.json");
    for (const task of set.tasks) {
      expect(SKILL_BENCH_TASK_ID_RE.test(task.id)).toBe(true);
    }
  });

  test("the hash is 64 hex characters", () => {
    const set = parseSkillBenchmarkTasks(loadFixture("tasks.json"), "tasks.json");
    expect(set.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the hash is stable across parses and key order", () => {
    const raw = loadFixture("tasks.json") as Record<string, unknown>;
    const first = parseSkillBenchmarkTasks(raw, "a");
    const second = parseSkillBenchmarkTasks(raw, "b");
    expect(first.hash).toBe(second.hash);
    // The same tasks under a different OBJECT key order hash identically:
    // the digest is taken over the canonical form, never the file bytes.
    // (Array order is list meaning and stays significant.)
    const tasks = raw["tasks"] as ReadonlyArray<Record<string, unknown>>;
    const reordered = {
      tasks: tasks.map((task) => {
        const entries = Object.entries(task).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return Object.fromEntries(entries);
      }),
      skill: raw["skill"],
    };
    expect(parseSkillBenchmarkTasks(reordered, "c").hash).toBe(first.hash);
  });

  test("the hash moves when any single task moves", () => {
    const raw = loadFixture("tasks.json") as {
      skill: string;
      tasks: Array<Record<string, unknown>>;
    };
    const baseline = parseSkillBenchmarkTasks(raw, "baseline").hash;
    const unmoved: string[] = [];
    for (let index = 0; index < raw.tasks.length; index++) {
      const touched = structuredClone(raw);
      const task = touched.tasks[index] as { input: string };
      task.input = `${task.input}x`;
      const hash = parseSkillBenchmarkTasks(touched, `touched-${index}`).hash;
      if (hash === baseline) unmoved.push(touched.tasks[index]!.id as string);
    }
    expect(unmoved).toEqual([]);
  });

  test("the hash moves when an expectation moves", () => {
    const raw = loadFixture("tasks.json") as {
      skill: string;
      tasks: Array<{ expects: Array<Record<string, unknown>> }>;
    };
    const baseline = parseSkillBenchmarkTasks(raw, "baseline").hash;
    const touched = structuredClone(raw);
    const expectation = touched.tasks[0]!.expects[0] as { tool: string };
    expectation.tool = "other_tool";
    expect(parseSkillBenchmarkTasks(touched, "touched").hash).not.toBe(baseline);
  });

  test("the task-set hash helper agrees with the parse", () => {
    const set = parseSkillBenchmarkTasks(loadFixture("tasks.json"), "tasks.json");
    expect(skillBenchmarkTaskSetHash(set.tasks)).toBe(set.hash);
  });

  test("refuses every malformed shape by name, naming the source", () => {
    const source = "Brain/skill-benchmarks/example-skill/tasks.json";
    const refusing = (raw: unknown, fragment: string): void => {
      try {
        parseSkillBenchmarkTasks(raw, source);
      } catch (error) {
        expect((error as Error).message).toContain(source);
        expect((error as Error).message).toContain(fragment);
        return;
      }
      throw new Error(`expected a refusal containing "${fragment}"`);
    };

    refusing(null, "expected a JSON object");
    refusing("tasks", "expected a JSON object");
    refusing([], "expected a JSON object");
    refusing({}, "skill");
    refusing({ skill: "example-skill" }, "tasks must be a non-empty array");
    refusing({ skill: "example-skill", tasks: [] }, "tasks must be a non-empty array");
    refusing({ tasks: [] }, "skill");
    refusing(
      {
        skill: "Example Skill",
        tasks: [
          {
            id: "t",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "tool_used", tool: "y" }],
          },
        ],
      },
      "skill directory name",
    );
    refusing(
      {
        skill: "../escape",
        tasks: [
          {
            id: "t",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "tool_used", tool: "y" }],
          },
        ],
      },
      "skill directory name",
    );
    refusing({ skill: "example-skill", tasks: [{}] }, "needs a non-empty id");
    refusing({ skill: "example-skill", tasks: [{ id: "" }] }, "needs a non-empty id");
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "freeform_chat",
            input: "x",
            expects: [{ check: "tool_used", tool: "y" }],
          },
        ],
      },
      "unknown kind",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            expects: [{ check: "tool_used", tool: "y" }],
          },
        ],
      },
      "input",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: 7,
            expects: [{ check: "tool_used", tool: "y" }],
          },
        ],
      },
      "input",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [{ id: "t-01", kind: "invocation_transcript", input: "x" }],
      },
      "expects must be a non-empty array",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [{ id: "t-01", kind: "invocation_transcript", input: "x", expects: [] }],
      },
      "expects must be a non-empty array",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [{ id: "t-01", kind: "invocation_transcript", input: "x", expects: [{}] }],
      },
      "unknown check",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "vibe_score" }],
          },
        ],
      },
      "unknown check",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "tool_used" }],
          },
        ],
      },
      "tool",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "artifact_created", path_prefix: "/abs" }],
          },
        ],
      },
      "path_prefix",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "artifact_created", path_prefix: "a/../b" }],
          },
        ],
      },
      "path_prefix",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "step_order", steps: [] }],
          },
        ],
      },
      "steps must be a non-empty string array",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "step_order", steps: ["a", "a"] }],
          },
        ],
      },
      "duplicate step",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "forbidden_step" }],
          },
        ],
      },
      "step",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "output_field", field: "f" }],
          },
        ],
      },
      "value_class",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "output_field", field: "f", value_class: "any" }],
          },
        ],
      },
      "value_class",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "output_field", value_class: "number" }],
          },
        ],
      },
      "field",
    );
    refusing(
      {
        skill: "example-skill",
        tasks: [
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "x",
            expects: [{ check: "tool_used", tool: "y" }],
          },
          {
            id: "t-01",
            kind: "invocation_transcript",
            input: "z",
            expects: [{ check: "tool_used", tool: "y" }],
          },
        ],
      },
      "duplicate task id",
    );
  });
});

describe("the kernel stays a true leaf", () => {
  test("it imports nothing beyond the digest and path-name leaves", () => {
    const text = readFileSync(
      join(REPO_ROOT, "src", "core", "brain", "skill-rewrite-tasks.ts"),
      "utf8",
    );
    const imports = [...text.matchAll(/^import\s[^;]*?from\s*"([^"]+)"/gm)].map((m) => m[1]!);
    const allowed = new Set(["../integrity/digest.ts", "./path-constants.ts", "node:path"]);
    const unexpected = imports.filter((specifier) => !allowed.has(specifier));
    expect(unexpected).toEqual([]);
  });
});

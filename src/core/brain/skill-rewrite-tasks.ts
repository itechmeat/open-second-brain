/**
 * The per-skill benchmark task-set kernel (agent-presence, Lane A).
 *
 * A skill rewrite is gated by measured outcomes, never by vibes: before
 * any candidate instructions are drafted, the skill carries a committed
 * task set - a validated, content-hashed document listing the tasks an
 * agent must perform while following the skill, and the structural
 * predicates the resulting transcript must satisfy. This module is that
 * document's only parser and its only hasher.
 *
 * Posture, pinned here because every later lane leans on it:
 *
 *   - The predicates are STRUCTURAL. A check names a tool, a path shape,
 *     an order, a forbidden step, or an output field class. No check
 *     ever reads prose, and no scorer down-stream of this module ever
 *     will: task text lives in the committed fixture, opaque to the
 *     predicate layer.
 *   - The document is fail-fast: a malformed shape is a named error
 *     carrying the source the document was read from, in the
 *     `parseBenchFixture` style. Nothing partial ever reaches a spec.
 *   - The module is a TRUE LEAF: it imports only the one digest encoding
 *     and the Brain path-name constants, so the import graph cannot grow
 *     a cycle rooted here, and nothing above can be pulled in by
 *     accident - `import type` included, per the architecture ratchet.
 *
 * The task set's home is vault-side, `Brain/skill-benchmarks/<skill>/`,
 * so an operator's benchmarks travel with the vault; the skills root
 * itself may sit outside the vault and cannot carry them. The hash over
 * the canonical task list is what a rewrite spec freezes as its receipt
 * (`skill-rewrite-spec.ts`), so it must be stable across parses and key
 * order and sensitive to any task byte - all three are pinned in tests.
 */

import { posix } from "node:path";

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";

/**
 * The benchmark directory under `Brain/`, one skill-document folder per
 * skill. A constant, not a literal scattered through callers: the state
 * surface row, the paths builder and the CLI all name it from here.
 */
export const SKILL_BENCHMARKS_DIR = "skill-benchmarks";

/** The vault-relative benchmark root: `Brain/skill-benchmarks`. */
export const SKILL_BENCHMARKS_ROOT_REL = posix.join(BRAIN_ROOT_REL, SKILL_BENCHMARKS_DIR);

/**
 * Compose the vault-relative path of one benchmark artifact for `skill`
 * (the tasks document, the spec receipt, a round's transcript drop site).
 * The name was validated at parse time; composing here keeps the one
 * spelling of the layout in the module that owns it.
 */
export function skillBenchmarkRelPath(skillName: string, ...segments: string[]): string {
  return posix.join(SKILL_BENCHMARKS_ROOT_REL, skillName, ...segments);
}

/** The tasks document inside a skill's benchmark folder. */
export const SKILL_BENCHMARK_TASKS_FILE = "tasks.json";
/** The frozen rewrite spec beside the tasks document. */
export const SKILL_BENCHMARK_SPEC_FILE = "spec.json";

/** The closed task-kind vocabulary. One kind today; the union keeps a
 * second kind from arriving as a string scattered across scorers. */
export const SKILL_BENCH_TASK_KIND = Object.freeze({
  invocation_transcript: "invocation_transcript",
} as const);

export type SkillBenchTaskKind = (typeof SKILL_BENCH_TASK_KIND)[keyof typeof SKILL_BENCH_TASK_KIND];

/** The task-kind members, for parse-time refusal and guard sharing. */
export const SKILL_BENCH_TASK_KINDS: ReadonlyArray<SkillBenchTaskKind> = Object.freeze(
  Object.values(SKILL_BENCH_TASK_KIND),
);

export function isSkillBenchTaskKind(value: unknown): value is SkillBenchTaskKind {
  return (
    typeof value === "string" && (SKILL_BENCH_TASK_KINDS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The closed check vocabulary - the ONLY predicates a transcript is ever
 * scored against. Structural by construction: a tool name, a path
 * prefix, an order, a forbidden step, an output field class.
 */
export const SKILL_BENCH_CHECK = Object.freeze({
  tool_used: "tool_used",
  artifact_created: "artifact_created",
  step_order: "step_order",
  forbidden_step: "forbidden_step",
  output_field: "output_field",
} as const);

export type SkillBenchCheck = (typeof SKILL_BENCH_CHECK)[keyof typeof SKILL_BENCH_CHECK];

/** The check members, for parse-time refusal and guard sharing. */
export const SKILL_BENCH_CHECKS: ReadonlyArray<SkillBenchCheck> = Object.freeze(
  Object.values(SKILL_BENCH_CHECK),
);

export function isSkillBenchCheck(value: unknown): value is SkillBenchCheck {
  return typeof value === "string" && (SKILL_BENCH_CHECKS as ReadonlyArray<string>).includes(value);
}

/**
 * The closed value classes an `output_field` check can demand. Deliberately
 * small: classes a scorer can decide without ever reading the value's
 * content. `any` is not a member - a check that accepts anything is not a
 * check.
 */
export const SKILL_BENCH_VALUE_CLASS = Object.freeze({
  non_empty_string: "non_empty_string",
  number: "number",
  boolean: "boolean",
  non_empty_array: "non_empty_array",
} as const);

export type SkillBenchValueClass =
  (typeof SKILL_BENCH_VALUE_CLASS)[keyof typeof SKILL_BENCH_VALUE_CLASS];

/** The value-class members, for parse-time refusal and guard sharing. */
export const SKILL_BENCH_VALUE_CLASSES: ReadonlyArray<SkillBenchValueClass> = Object.freeze(
  Object.values(SKILL_BENCH_VALUE_CLASS),
);

export function isSkillBenchValueClass(value: unknown): value is SkillBenchValueClass {
  return (
    typeof value === "string" &&
    (SKILL_BENCH_VALUE_CLASSES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * One structural predicate over the returned transcript. Field spellings
 * match the committed JSON exactly (`path_prefix`, `value_class`) so the
 * parse is a pass-through freeze and the canonical hash over the parsed
 * tasks equals the hash over the document's task list.
 */
export type SkillBenchExpectation =
  | { readonly check: "tool_used"; readonly tool: string }
  | { readonly check: "artifact_created"; readonly path_prefix: string }
  | { readonly check: "step_order"; readonly steps: ReadonlyArray<string> }
  | { readonly check: "forbidden_step"; readonly step: string }
  | {
      readonly check: "output_field";
      readonly field: string;
      readonly value_class: SkillBenchValueClass;
    };

/** One benchmark task: what to do, and what the transcript must show. */
export interface SkillBenchmarkTask {
  /** Filename-safe id; names the transcript drop file for the round. */
  readonly id: string;
  readonly kind: SkillBenchTaskKind;
  /** The task input, carried verbatim into the dev envelope prompt. */
  readonly input: string;
  readonly expects: ReadonlyArray<SkillBenchExpectation>;
}

/** A validated, content-hashed task set for one skill. */
export interface SkillBenchmarkTaskSet {
  readonly skillName: string;
  readonly tasks: ReadonlyArray<SkillBenchmarkTask>;
  /** sha256 over the canonical task list - the spec receipt's anchor. */
  readonly hash: string;
}

/**
 * A skill's benchmark name becomes a DIRECTORY under the benchmark root,
 * so it follows the skill-directory rule: lowercase letters, digits and
 * single hyphens. Spelled here rather than imported from the proposal
 * module because this kernel is a true leaf and must not reach into the
 * layer above; the materialize path re-checks the same rule (and has its
 * own named constant), so a name that passes one but not the other is
 * refused at whichever door it reaches first.
 */
export const SKILL_BENCH_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Task ids name transcript drop files inside a round directory, so they
 * are filename-safe: letters, digits, dots, hyphens and underscores with
 * a leading alphanumeric. No separators, no traversal.
 */
export const SKILL_BENCH_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The canonical content hash over a parsed task list. */
export function skillBenchmarkTaskSetHash(tasks: ReadonlyArray<SkillBenchmarkTask>): string {
  return sha256Hex(canonicalJson(tasks));
}

/**
 * Parse and validate a raw task-set document. Throws named errors that
 * always carry `source`, so an operator sees WHICH document refused.
 */
export function parseSkillBenchmarkTasks(raw: unknown, source: string): SkillBenchmarkTaskSet {
  const at = (what: string): string => `skill benchmark tasks (${source}): ${what}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(at("expected a JSON object"));
  }
  const record = raw as Record<string, unknown>;

  const skillName = record["skill"];
  if (typeof skillName !== "string" || skillName.trim().length === 0) {
    throw new Error(at("skill must be a non-empty string"));
  }
  if (!SKILL_BENCH_SKILL_NAME_RE.test(skillName)) {
    throw new Error(
      at(
        `skill must be a skill directory name (lowercase letters, digits and single hyphens): ${JSON.stringify(skillName)}`,
      ),
    );
  }

  const tasksRaw = record["tasks"];
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    throw new Error(at("tasks must be a non-empty array"));
  }

  const tasks = tasksRaw.map((task, index) => parseTask(task, at, index));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new Error(at(`duplicate task id: ${task.id}`));
    }
    seen.add(task.id);
  }

  return Object.freeze({
    skillName,
    tasks: Object.freeze(tasks),
    hash: skillBenchmarkTaskSetHash(tasks),
  });
}

function parseTask(raw: unknown, at: (what: string) => string, index: number): SkillBenchmarkTask {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(at(`task ${index} must be an object`));
  }
  const record = raw as Record<string, unknown>;

  const id = record["id"];
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(at(`task ${index} needs a non-empty id`));
  }
  if (!SKILL_BENCH_TASK_ID_RE.test(id)) {
    throw new Error(at(`task id must be filename-safe: ${JSON.stringify(id)}`));
  }

  if (!isSkillBenchTaskKind(record["kind"])) {
    throw new Error(
      at(`task ${id} has an unknown kind (expected one of ${SKILL_BENCH_TASK_KINDS.join(", ")})`),
    );
  }

  const input = record["input"];
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(at(`task ${id} needs a non-empty input`));
  }

  const expectsRaw = record["expects"];
  if (!Array.isArray(expectsRaw) || expectsRaw.length === 0) {
    throw new Error(at(`task ${id} expects must be a non-empty array`));
  }
  const expects = expectsRaw.map((expectation) => parseExpectation(expectation, at, id));

  return Object.freeze({ id, kind: record["kind"], input, expects: Object.freeze(expects) });
}

function parseExpectation(
  raw: unknown,
  at: (what: string) => string,
  taskId: string,
): SkillBenchExpectation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(at(`task ${taskId} expectation must be an object`));
  }
  const record = raw as Record<string, unknown>;
  const check = record["check"];
  if (!isSkillBenchCheck(check)) {
    throw new Error(
      at(`task ${taskId} has an unknown check (expected one of ${SKILL_BENCH_CHECKS.join(", ")})`),
    );
  }
  switch (check) {
    case "tool_used": {
      const tool = nonEmptyString(record["tool"]);
      if (tool === undefined) throw new Error(at(`task ${taskId} tool_used needs a tool name`));
      return Object.freeze({ check, tool });
    }
    case "artifact_created": {
      const prefix = nonEmptyString(record["path_prefix"]);
      if (prefix === undefined) {
        throw new Error(at(`task ${taskId} artifact_created needs a path_prefix`));
      }
      if (isAbsoluteLike(prefix)) {
        throw new Error(
          at(`task ${taskId} artifact_created path_prefix must be vault-relative: ${prefix}`),
        );
      }
      return Object.freeze({ check, path_prefix: prefix });
    }
    case "step_order": {
      const stepsRaw = record["steps"];
      if (
        !Array.isArray(stepsRaw) ||
        stepsRaw.length === 0 ||
        !stepsRaw.every((step) => typeof step === "string" && step.trim().length > 0)
      ) {
        throw new Error(at(`task ${taskId} step_order steps must be a non-empty string array`));
      }
      const steps = stepsRaw as string[];
      const seen = new Set<string>();
      for (const step of steps) {
        if (seen.has(step)) {
          throw new Error(at(`task ${taskId} step_order carries a duplicate step: ${step}`));
        }
        seen.add(step);
      }
      return Object.freeze({ check, steps: Object.freeze([...steps]) });
    }
    case "forbidden_step": {
      const step = nonEmptyString(record["step"]);
      if (step === undefined) {
        throw new Error(at(`task ${taskId} forbidden_step needs a step name`));
      }
      return Object.freeze({ check, step });
    }
    case "output_field": {
      const field = nonEmptyString(record["field"]);
      if (field === undefined) {
        throw new Error(at(`task ${taskId} output_field needs a field name`));
      }
      const valueClass = record["value_class"];
      if (!isSkillBenchValueClass(valueClass)) {
        throw new Error(
          at(
            `task ${taskId} output_field has an unknown value_class (expected one of ${SKILL_BENCH_VALUE_CLASSES.join(", ")})`,
          ),
        );
      }
      return Object.freeze({ check, field, value_class: valueClass });
    }
  }
}

/** Non-empty-string reader used by the per-check parsers. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Vault-relative shape check for an `artifact_created` prefix: no
 * absolute form, no traversal segment, on either separator - the prefix
 * is matched against vault-relative artifact paths, so an absolute or
 * escaping prefix could never match and only ever misleads.
 */
function isAbsoluteLike(prefix: string): boolean {
  const normalized = prefix.replaceAll("\\", "/");
  return posix.isAbsolute(normalized) || normalized.split("/").includes("..");
}

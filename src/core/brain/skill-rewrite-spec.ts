/**
 * The preregistered skill-rewrite spec (agent-presence, Lane A).
 *
 * "Preregistered" is a commitment with mechanical teeth, copied from the
 * decision-model eval specs: before any gate runs, a spec freezes (a) the
 * content hash of the skill's committed benchmark task set, (b) the seed
 * and the hash-order dev/held-out split rule with the derived membership
 * as a frozen receipt, and (c) the selection gate's constants - the
 * required margin and the minimum dev n. The whole spec is content-
 * hashed; every grade record and every staged rewrite proposal stamps
 * that hash, so a spec edited after grades were seen invalidates them
 * instead of quietly re-scoping the claim.
 *
 * The dev arm is the only split the optimizer ever sees: envelopes are
 * built from the receipt's dev members, and the held-out members are
 * read exactly once, by the held-out gate on the candidate that earned
 * promotion. The rule is the same pure derivation the decision-model
 * take uses - rank ids by `sha256Hex(seed + ":" + id)`, ties by id, the
 * first `ceil(0.7 n)` are dev - so the receipt compares equal regardless
 * of derivation order.
 *
 * This module is a TRUE LEAF above the task kernel: it imports only the
 * one digest encoding and `skill-rewrite-tasks.ts`. The import graph
 * cannot grow a cycle rooted here.
 */

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import { SKILL_BENCH_SKILL_NAME_RE, type SkillBenchmarkTaskSet } from "./skill-rewrite-tasks.ts";

/** Bumped on any deliberate re-registration; part of the spec hash. */
export const SKILL_REWRITE_SPEC_SCHEMA = "o2b.skill-rewrite.v1";

/** The only split rule this build derives receipts with. */
export const SKILL_REWRITE_SPLIT_RULE = "hash-order-70-30";

/** The only selection metric this build writes grade records for. */
export const SKILL_REWRITE_METRIC = "tasks_passed_rate";

/** Dev share of the task set; the held-out remainder is checked once. */
export const SKILL_REWRITE_DEV_FRACTION = 0.7;

/**
 * The candidate must beat the baseline by MORE than this rate margin on
 * the dev arm before promotion is on the table. A tie - and anything
 * under the margin - holds.
 */
export const SKILL_REWRITE_REQUIRED_MARGIN = 0.1;

/** Minimum dev tasks with scored transcripts on BOTH arms, below which
 * the verdict is `not_enough_evidence` - a short dev n is its own arm,
 * never a pass. */
export const SKILL_REWRITE_MIN_DEV_TASKS = 2;

/** The split seed when the operator names none. A constant, so the same
 * task set always derives the same receipt. */
export const SKILL_REWRITE_DEFAULT_SEED = 0;

/**
 * Minimum task count for which the 70-30 split leaves BOTH arms
 * non-empty (ceil(0.7 n) < n first holds at n = 4: 3 dev, 1 held-out).
 * Below it a spec would freeze a gate that can never run its held-out
 * check, so building one is refused by name.
 */
export const SKILL_REWRITE_MIN_TASKS = 4;

/**
 * The preregistered three-arm verdict, the same shape the decision-model
 * eval keeps: a candidate promotes only by a strict beat of the pinned
 * margin with the dev n met, a tie holds, and a short dev n is not
 * evidence of anything.
 */
export const SKILL_REWRITE_VERDICT = Object.freeze({
  promote: "promote",
  hold: "hold",
  not_enough_evidence: "not_enough_evidence",
} as const);

export type SkillRewriteVerdict =
  (typeof SKILL_REWRITE_VERDICT)[keyof typeof SKILL_REWRITE_VERDICT];

/** The verdict members, for guard sharing and output validation. */
export const SKILL_REWRITE_VERDICTS: ReadonlyArray<SkillRewriteVerdict> = Object.freeze(
  Object.values(SKILL_REWRITE_VERDICT),
);

export function isSkillRewriteVerdict(value: unknown): value is SkillRewriteVerdict {
  return (
    typeof value === "string" && (SKILL_REWRITE_VERDICTS as ReadonlyArray<string>).includes(value)
  );
}

/** sha-256 hex digest length. */
const HASH_HEX_LENGTH = 64;
const HASH_HEX_RE = new RegExp(`^[0-9a-f]{${HASH_HEX_LENGTH}}$`);

/** The frozen receipt a gate run is held to. */
export interface SkillRewriteSpec {
  readonly schemaVersion: string;
  readonly skillName: string;
  /** sha256 over the canonical task list, frozen at preregistration. */
  readonly tasksHash: string;
  readonly seed: number;
  readonly splitRule: string;
  /** Dev members, sorted lexicographically. Envelopes see these only. */
  readonly devTaskIds: ReadonlyArray<string>;
  /** Held-out members, sorted lexicographically. Read by the one-shot
   * held-out gate; never placed in an envelope before it. */
  readonly heldoutTaskIds: ReadonlyArray<string>;
  readonly requiredMargin: number;
  readonly minDevTasks: number;
}

/**
 * Build the spec for a parsed task set: hash the set, derive the split
 * from the seed, freeze the receipt. Deterministic - the same task set
 * and seed always produce the identical spec.
 */
export function buildSkillRewriteSpec(
  skillName: string,
  tasks: SkillBenchmarkTaskSet,
  opts: { readonly seed?: number } = {},
): SkillRewriteSpec {
  if (tasks.tasks.length < SKILL_REWRITE_MIN_TASKS) {
    throw new Error(
      `skill rewrite spec: task set for '${skillName}' is too small to split ` +
        `(has ${tasks.tasks.length} tasks, the ${SKILL_REWRITE_SPLIT_RULE} rule needs at least ${SKILL_REWRITE_MIN_TASKS} ` +
        "so both arms stay non-empty)",
    );
  }
  const seed = opts.seed ?? SKILL_REWRITE_DEFAULT_SEED;
  const split = hashOrderSplit(
    seed,
    tasks.tasks.map((task) => task.id),
  );
  return Object.freeze({
    schemaVersion: SKILL_REWRITE_SPEC_SCHEMA,
    skillName,
    tasksHash: tasks.hash,
    seed,
    splitRule: SKILL_REWRITE_SPLIT_RULE,
    devTaskIds: split.dev,
    heldoutTaskIds: split.heldout,
    requiredMargin: SKILL_REWRITE_REQUIRED_MARGIN,
    minDevTasks: SKILL_REWRITE_MIN_DEV_TASKS,
  });
}

/**
 * The runner-side preregistration guard: the task set must still hash to
 * the receipt's frozen hash, still belong to the named skill, and still
 * derive into exactly the receipted split. Any mismatch names what moved
 * - a spec edited after grades were seen invalidates them, it never
 * re-scopes the claim.
 */
export function verifyRewriteTake(
  spec: SkillRewriteSpec,
  tasks: SkillBenchmarkTaskSet,
): { readonly ok: boolean; readonly reason: string | null } {
  if (tasks.hash !== spec.tasksHash) {
    return {
      ok: false,
      reason:
        `task set hash ${tasks.hash} does not match the receipt's frozen hash ${spec.tasksHash}; ` +
        "the benchmark changed under the spec",
    };
  }
  if (tasks.skillName !== spec.skillName) {
    return {
      ok: false,
      reason: `task set names skill '${tasks.skillName}' but the receipt names '${spec.skillName}'`,
    };
  }
  const derived = hashOrderSplit(
    spec.seed,
    tasks.tasks.map((task) => task.id),
  );
  if (
    !sameSortedIds(derived.dev, spec.devTaskIds) ||
    !sameSortedIds(derived.heldout, spec.heldoutTaskIds)
  ) {
    return {
      ok: false,
      reason:
        "the task set no longer derives into the receipted split " +
        `(seed ${spec.seed}, rule ${spec.splitRule}); the receipt is stale`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * The spec hash every grade record and staged proposal stamps: sha-256
 * over the canonical JSON of the whole spec, so any edit - receipt,
 * seed, margin, n floor - invalidates what came before.
 */
export function skillRewriteSpecHash(spec: SkillRewriteSpec): string {
  return sha256Hex(canonicalJson(spec));
}

/**
 * Parse a stored spec document (the JSON beside the tasks document).
 * Field spellings match the stored file (`schema_version`,
 * `held_out_task_ids`, ...). An unknown schema version is refused by
 * name: a spec written by a different build is a different
 * preregistration, not a compatible one.
 */
export function parseSkillRewriteSpec(raw: unknown, source: string): SkillRewriteSpec {
  const at = (what: string): string => `skill rewrite spec (${source}): ${what}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(at("expected a JSON object"));
  }
  const record = raw as Record<string, unknown>;

  if (record["schema_version"] !== SKILL_REWRITE_SPEC_SCHEMA) {
    throw new Error(
      at(
        `unknown schema version ${JSON.stringify(record["schema_version"] ?? null)} ` +
          `(expected '${SKILL_REWRITE_SPEC_SCHEMA}')`,
      ),
    );
  }
  const skillName = record["skill_name"];
  if (typeof skillName !== "string" || !SKILL_BENCH_SKILL_NAME_RE.test(skillName)) {
    throw new Error(at("skill_name must be a skill directory name"));
  }
  const tasksHash = record["tasks_hash"];
  if (typeof tasksHash !== "string" || !HASH_HEX_RE.test(tasksHash)) {
    throw new Error(at(`tasks_hash must be a ${HASH_HEX_LENGTH}-character sha-256 hex digest`));
  }
  const seed = record["seed"];
  if (typeof seed !== "number" || !Number.isInteger(seed)) {
    throw new Error(at("seed must be an integer"));
  }
  if (record["split_rule"] !== SKILL_REWRITE_SPLIT_RULE) {
    throw new Error(at(`split rule must be '${SKILL_REWRITE_SPLIT_RULE}'`));
  }
  const devTaskIds = idList(record["dev_task_ids"], "dev_task_ids", at);
  const heldoutTaskIds = idList(record["held_out_task_ids"], "held_out_task_ids", at);
  if (devTaskIds.some((id) => heldoutTaskIds.includes(id))) {
    throw new Error(at("dev_task_ids and held_out_task_ids must be disjoint"));
  }
  const requiredMargin = record["required_margin"];
  if (
    typeof requiredMargin !== "number" ||
    !Number.isFinite(requiredMargin) ||
    requiredMargin < 0 ||
    requiredMargin >= 1
  ) {
    throw new Error(at("required_margin must be a number in [0, 1)"));
  }
  const minDevTasks = record["min_dev_tasks"];
  if (typeof minDevTasks !== "number" || !Number.isInteger(minDevTasks) || minDevTasks < 1) {
    throw new Error(at("min_dev_tasks must be a positive integer"));
  }

  return Object.freeze({
    schemaVersion: SKILL_REWRITE_SPEC_SCHEMA,
    skillName,
    tasksHash,
    seed,
    splitRule: SKILL_REWRITE_SPLIT_RULE,
    devTaskIds,
    heldoutTaskIds,
    requiredMargin,
    minDevTasks,
  });
}

// ----- the hash-order split -----------------------------------------------------

interface RewriteSplit {
  /** Dev ids, sorted lexicographically. Envelopes see these only. */
  readonly dev: ReadonlyArray<string>;
  /** Held-out ids, sorted lexicographically. Checked exactly once. */
  readonly heldout: ReadonlyArray<string>;
}

/**
 * The preregistered split: rank ids by `sha256Hex(seed + ":" + id)`
 * (ties by id), the first `ceil(0.7 n)` are dev, the rest held out.
 * Pure and reorder-stable; both lists come back sorted lexicographically
 * so a receipt compares equal regardless of derivation order.
 */
function hashOrderSplit(seed: number, ids: ReadonlyArray<string>): RewriteSplit {
  const ranked = ids
    .map((id) => ({ id, hash: sha256Hex(`${seed}:${id}`) }))
    .toSorted(
      (left, right) =>
        (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0) ||
        left.id.localeCompare(right.id),
    );
  const devCount = Math.ceil(ids.length * SKILL_REWRITE_DEV_FRACTION);
  return {
    dev: ranked
      .slice(0, devCount)
      .map((entry) => entry.id)
      .toSorted(),
    heldout: ranked
      .slice(devCount)
      .map((entry) => entry.id)
      .toSorted(),
  };
}

/** Whether two lexicographically sorted id lists hold the same ids. */
function sameSortedIds(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function idList(raw: unknown, field: string, at: (what: string) => string): ReadonlyArray<string> {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((id) => typeof id === "string" && id.trim().length > 0)
  ) {
    throw new Error(at(`${field} must be a non-empty array of task ids`));
  }
  const list = raw as string[];
  if (new Set(list).size !== list.length) {
    throw new Error(at(`${field} carries a duplicate task id`));
  }
  return Object.freeze([...list].toSorted());
}

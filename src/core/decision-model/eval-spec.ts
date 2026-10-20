/**
 * The preregistered decision-model eval specs (cycle 20261020, card
 * t_4e1681b3).
 *
 * "Preregistered" is a commitment with mechanical teeth: before any
 * grading happens, a spec freezes (a) the committed fixture and its
 * content hash, (b) the seed and the hash-order dev/counted split rule
 * with the derived membership as a frozen receipt, (c) the promotion
 * metric with its ceiling and minimum counted n, and (d) the exact
 * threshold values of the use being validated - so a profile can never
 * be marked tuned against thresholds that later moved. The whole spec is
 * content-hashed; every cached grade record and every machine-side
 * tuning mark stamps that hash, so a spec edited after grades were seen
 * invalidates them instead of quietly re-scoping the claim.
 *
 * This file, with the fixtures it references, landed in one reviewable
 * commit BEFORE the eval runner existed (task C1 precedes C2); the
 * runner verifies the fixture and take against the receipt at run time
 * (`eval/take.ts`) and refuses mismatches.
 *
 * Scope: the registry holds the uses with a committed, labeled take.
 * `extract_prefilter` is deliberately absent - its gate is the
 * zero-regret shadow-span rule already measured by its report
 * (`reports/extract-prefilter.ts`), and it keeps that loop. The other
 * advisory uses gain specs the same way when a take is committed for
 * them.
 *
 * Grading protocol, frozen with the specs: the deterministic scorer is
 * canonical, an external judge is advisory only, and graded requests are
 * real spend counted toward the daily cost gate (`eval/grade.ts`).
 */

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import { isDecisionModelUse, type DecisionModelUse } from "./contract.ts";
import { RECALL_INJECT_ANY_MIN, RECALL_INJECT_NOTE_MIN } from "./questions.ts";

/** Bumped on any deliberate re-registration; part of the spec hash. */
export const DECISION_EVAL_SPEC_VERSION = 1;

/** The only split rule this build derives receipts with. */
export const DECISION_EVAL_SPLIT_RULE = "hash-order-30-70";

/** Dev share of the take; the counted remainder produces the metric. */
export const DECISION_EVAL_DEV_FRACTION = 0.3;

/** The only promotion metric this build writes marks for. */
export const DECISION_EVAL_METRIC = "counted_error_rate";

/**
 * The preregistered three-arm verdict, the same shape the
 * extract_prefilter report keeps: a use promotes only when the counted
 * error meets the ceiling, does not regress against the deterministic
 * baseline, and the counted n is met; too few counted items is its own
 * arm, not a failure.
 */
export type DecisionEvalVerdict = "promote" | "hold" | "not_enough_evidence";

export const DECISION_EVAL_VERDICTS: ReadonlyArray<DecisionEvalVerdict> = Object.freeze([
  "promote",
  "hold",
  "not_enough_evidence",
]);

/** sha-256 hex digest length. */
const HASH_HEX_LENGTH = 64;

export interface DecisionEvalSpec {
  readonly version: number;
  /** The use this spec validates. */
  readonly use: DecisionModelUse;
  /** The committed fixture file, repo-relative. */
  readonly fixture: string;
  /** The split seed; `sha256Hex(seed + ":" + id)` ranks the take ids. */
  readonly seed: string;
  readonly split: {
    readonly rule: typeof DECISION_EVAL_SPLIT_RULE;
    readonly dev_fraction: number;
  };
  /**
   * The frozen membership receipt: the take ids with their dev/counted
   * assignment, each list sorted lexicographically. Frozen at
   * preregistration so fixture growth cannot silently move the counted
   * boundary; the runner derives the split fresh and refuses mismatches.
   */
  readonly receipt: {
    readonly dev: ReadonlyArray<string>;
    readonly counted: ReadonlyArray<string>;
  };
  /** sha-256 of the canonical fixture document, frozen at preregistration. */
  readonly fixture_hash: string;
  readonly metric: typeof DECISION_EVAL_METRIC;
  /**
   * The counted error rate at or below which the use may be marked
   * tuned. Conservative starting constants: rerank 0.05 (one top-1 miss
   * in twenty), recall_inject 0 - a dropped useful note is regret, the
   * same zero-regret target its report family keeps.
   */
  readonly ceiling: number;
  /** Minimum counted n below which the verdict is "not enough evidence". */
  readonly min_counted: number;
  /**
   * The exact threshold values the use reads from `questions.ts` when it
   * enforces, pinned so a mark written against these values is refused
   * the day they move. Empty where the use reads no probability floor
   * from the table (rerank's reorder is threshold-free).
   */
  readonly thresholds: Readonly<Record<string, number>>;
}

/** Validate one spec. A missing or malformed element is a construction error. */
export function validateDecisionEvalSpec(spec: DecisionEvalSpec): void {
  const at = (what: string): string => `eval spec '${spec.use ?? "?"}': ${what}`;
  if (spec.version !== DECISION_EVAL_SPEC_VERSION) {
    throw new Error(
      at(`version must be ${DECISION_EVAL_SPEC_VERSION}, got ${String(spec.version)}`),
    );
  }
  if (!isDecisionModelUse(spec.use)) {
    throw new Error(at(`use ${JSON.stringify(spec.use)} is not a decision-model use`));
  }
  if (typeof spec.fixture !== "string" || spec.fixture.trim() === "") {
    throw new Error(at("fixture must name the committed fixture file"));
  }
  if (typeof spec.seed !== "string" || spec.seed.trim() === "") {
    throw new Error(at("seed must be a non-empty string"));
  }
  if (spec.split?.rule !== DECISION_EVAL_SPLIT_RULE) {
    throw new Error(at(`split rule must be '${DECISION_EVAL_SPLIT_RULE}'`));
  }
  if (spec.split?.dev_fraction !== DECISION_EVAL_DEV_FRACTION) {
    throw new Error(at(`dev fraction must be ${DECISION_EVAL_DEV_FRACTION}`));
  }
  const receiptOk =
    Array.isArray(spec.receipt?.dev) &&
    Array.isArray(spec.receipt?.counted) &&
    spec.receipt.dev.length > 0 &&
    spec.receipt.counted.length > 0 &&
    [...spec.receipt.dev, ...spec.receipt.counted].every(
      (id) => typeof id === "string" && id.trim() !== "",
    ) &&
    new Set([...spec.receipt.dev, ...spec.receipt.counted]).size ===
      spec.receipt.dev.length + spec.receipt.counted.length;
  if (!receiptOk) {
    throw new Error(at("receipt must freeze non-empty, disjoint dev and counted id lists"));
  }
  if (
    typeof spec.fixture_hash !== "string" ||
    !new RegExp(`^[0-9a-f]{${HASH_HEX_LENGTH}}$`).test(spec.fixture_hash)
  ) {
    throw new Error(at("fixture hash must be a 64-character sha-256 hex digest"));
  }
  if (spec.metric !== DECISION_EVAL_METRIC) {
    throw new Error(at(`metric must be '${DECISION_EVAL_METRIC}'`));
  }
  if (
    typeof spec.ceiling !== "number" ||
    !Number.isFinite(spec.ceiling) ||
    spec.ceiling < 0 ||
    spec.ceiling > 1
  ) {
    throw new Error(at("ceiling must be a number in [0, 1]"));
  }
  if (!Number.isInteger(spec.min_counted) || spec.min_counted < 1) {
    throw new Error(at("minimum counted n must be a positive integer"));
  }
  const thresholds = spec.thresholds ?? {};
  for (const [name, value] of Object.entries(thresholds)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(at(`thresholds must hold finite numbers, got ${name}: ${String(value)}`));
    }
  }
}

/**
 * The spec hash every grade record and tuning mark stamps: sha-256 over
 * the canonical JSON of the whole spec, so any edit - receipt, seed,
 * ceiling, pinned thresholds, version - invalidates what came before.
 */
export function decisionEvalSpecHash(spec: DecisionEvalSpec): string {
  return sha256Hex(canonicalJson(spec));
}

/**
 * The preregistered specs, one per use with a committed labeled take.
 * `cycle-20261020` is the registration seed for this cycle's takes.
 */
export const DECISION_EVAL_SPECS: Readonly<Partial<Record<DecisionModelUse, DecisionEvalSpec>>> =
  Object.freeze({
    rerank: Object.freeze({
      version: DECISION_EVAL_SPEC_VERSION,
      use: "rerank",
      fixture: "tests/fixtures/decision-model/rerank-take.json",
      seed: "cycle-20261020",
      split: Object.freeze({
        rule: DECISION_EVAL_SPLIT_RULE,
        dev_fraction: DECISION_EVAL_DEV_FRACTION,
      }),
      receipt: Object.freeze({
        dev: Object.freeze([
          "rk-006",
          "rk-007",
          "rk-009",
          "rk-010",
          "rk-012",
          "rk-014",
          "rk-017",
          "rk-026",
          "rk-028",
          "rk-033",
          "rk-038",
          "rk-039",
          "rk-043",
        ]),
        counted: Object.freeze([
          "rk-001",
          "rk-002",
          "rk-003",
          "rk-004",
          "rk-005",
          "rk-008",
          "rk-011",
          "rk-013",
          "rk-015",
          "rk-016",
          "rk-018",
          "rk-019",
          "rk-020",
          "rk-021",
          "rk-022",
          "rk-023",
          "rk-024",
          "rk-025",
          "rk-027",
          "rk-029",
          "rk-030",
          "rk-031",
          "rk-032",
          "rk-034",
          "rk-035",
          "rk-036",
          "rk-037",
          "rk-040",
          "rk-041",
          "rk-042",
        ]),
      }),
      fixture_hash: "1c0553c47a2288b35bdd4c54a234ffa12642290d4a337d122020d96441615308",
      metric: DECISION_EVAL_METRIC,
      ceiling: 0.05,
      min_counted: 30,
      // The enforced reorder consults no probability floor in
      // questions.ts; the no-regression rule carries the quality burden.
      thresholds: Object.freeze({}),
    }),
    recall_inject: Object.freeze({
      version: DECISION_EVAL_SPEC_VERSION,
      use: "recall_inject",
      fixture: "tests/fixtures/decision-model/recall-inject-take.json",
      seed: "cycle-20261020",
      split: Object.freeze({
        rule: DECISION_EVAL_SPLIT_RULE,
        dev_fraction: DECISION_EVAL_DEV_FRACTION,
      }),
      receipt: Object.freeze({
        dev: Object.freeze([
          "ri-001",
          "ri-003",
          "ri-006",
          "ri-008",
          "ri-011",
          "ri-020",
          "ri-021",
          "ri-024",
          "ri-027",
        ]),
        counted: Object.freeze([
          "ri-002",
          "ri-004",
          "ri-005",
          "ri-007",
          "ri-009",
          "ri-010",
          "ri-012",
          "ri-013",
          "ri-014",
          "ri-015",
          "ri-016",
          "ri-017",
          "ri-018",
          "ri-019",
          "ri-022",
          "ri-023",
          "ri-025",
          "ri-026",
          "ri-028",
          "ri-029",
        ]),
      }),
      fixture_hash: "396e5e459d3a30ab5dd5c0df9d73187c42a6e9348b91f98868a195d66a850e93",
      metric: DECISION_EVAL_METRIC,
      // A dropped useful note is lost context: the target is zero regret,
      // exactly what the extract_prefilter report family demands.
      ceiling: 0,
      min_counted: 20,
      // Pinned to the enforce floors this use actually reads.
      thresholds: Object.freeze({
        any_min: RECALL_INJECT_ANY_MIN,
        note_min: RECALL_INJECT_NOTE_MIN,
      }),
    }),
  });

/** The spec registered for `use`, or null when none is (yet). */
export function decisionEvalSpecFor(use: DecisionModelUse): DecisionEvalSpec | null {
  return DECISION_EVAL_SPECS[use] ?? null;
}

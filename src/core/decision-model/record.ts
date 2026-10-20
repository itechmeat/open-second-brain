/**
 * `decision_model_call` accounting records.
 *
 * One record per decision request, written through the continuity log
 * with the same gated, fail-open discipline as `generation_report`: a
 * failed write never fails the caller, and with no vault nothing is
 * built. Records exist only while the feature is active, so an install
 * that never enabled it has none.
 *
 * A record carries identifiers and numbers - the use, mode, answering
 * model, token counts, cost, latency, the outcome and a sha-256 of the
 * redacted state - plus each use's own evaluation identifiers (for a
 * rerank, the ordered result paths). It never carries the state, a
 * passage, a prompt or a question text.
 *
 * The same records feed the daily cost gate and `o2b decision-model
 * report`. Nothing trains on them, and operators should not build that
 * on them either.
 *
 * Records written by the eval gate and by `check --ping` carry an
 * `origin` (`eval`, `ping`), so the report can keep them out of the
 * shadow agreement. They still count toward the daily gate: they are
 * real spend.
 */

import { emitGatedTelemetry } from "../brain/continuity/emit.ts";
import { appendContinuityRecord, listContinuityRecords } from "../brain/continuity/store.ts";
import type { ContinuityRecord } from "../brain/continuity/types.ts";
import type {
  DecisionCallOrigin,
  DecisionModelMode,
  DecisionModelUse,
  DecisionUsage,
} from "./contract.ts";
import { isDecisionModelUse } from "./contract.ts";
import { DECISION_EVAL_VERDICTS, type DecisionEvalVerdict } from "./eval-spec.ts";

export const DECISION_MODEL_CALL_KIND = "decision_model_call";

export type DecisionCostSource = "reported" | "estimated" | "unknown";

export interface DecisionCallRecordInput {
  /** The use, or `ping` for the connectivity check. */
  readonly use: DecisionModelUse | "ping";
  readonly mode: DecisionModelMode;
  readonly provider: string;
  /** Answering model when a reply arrived, else the pinned id. */
  readonly model: string;
  readonly calibrated: boolean;
  readonly questionCount: number;
  readonly candidateCount: number;
  readonly usage?: DecisionUsage;
  readonly inputPriceUsdPerMtok: number | null;
  /**
   * Output price, set only for `llm-emulation` (the one route that bills
   * output); its cost is estimated from both prices or unknown.
   */
  readonly outputPriceUsdPerMtok?: number | null;
  readonly latencyMs: number;
  /** `ok` or a degrade reason. */
  readonly outcome: string;
  readonly stateHash?: string;
  /** Per-use evaluation identifiers (paths, ids, probabilities), never text. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly origin?: DecisionCallOrigin;
  readonly createdAt?: string;
}

/**
 * The cost of one request. A reported cost wins. Otherwise it is estimated
 * from the input price, plus the output price when one is given (only
 * `llm-emulation` bills output; without its output tokens the cost is
 * unknown rather than understated).
 */
export function decisionCost(
  usage: DecisionUsage | undefined,
  inputPriceUsdPerMtok: number | null,
  outputPriceUsdPerMtok: number | null = null,
): { readonly costUsd: number | null; readonly source: DecisionCostSource } {
  if (usage?.costUsd !== undefined) return { costUsd: usage.costUsd, source: "reported" };
  if (usage?.inputTokens !== undefined && inputPriceUsdPerMtok !== null) {
    const input = usage.inputTokens * inputPriceUsdPerMtok;
    if (outputPriceUsdPerMtok === null) {
      return { costUsd: input / 1_000_000, source: "estimated" };
    }
    if (usage.outputTokens === undefined) return { costUsd: null, source: "unknown" };
    return {
      costUsd: (input + usage.outputTokens * outputPriceUsdPerMtok) / 1_000_000,
      source: "estimated",
    };
  }
  return { costUsd: null, source: "unknown" };
}

/** Emit one record; returns null when there is no vault or the write failed. */
export function emitDecisionModelCall(
  vault: string | null,
  input: DecisionCallRecordInput,
): ContinuityRecord | null {
  return emitGatedTelemetry(vault, (v) => {
    const cost = decisionCost(
      input.usage,
      input.inputPriceUsdPerMtok,
      input.outputPriceUsdPerMtok ?? null,
    );
    // Per-use details go first so they can never overwrite an accounting
    // field (the cost gate sums `cost_usd`).
    const payload: Record<string, unknown> = {
      ...input.details,
      use: input.use,
      mode: input.mode,
      provider: input.provider,
      model: input.model,
      calibrated: input.calibrated,
      question_count: input.questionCount,
      candidate_count: input.candidateCount,
      ...(input.usage?.inputTokens !== undefined ? { input_tokens: input.usage.inputTokens } : {}),
      ...(input.usage?.outputTokens !== undefined
        ? { output_tokens: input.usage.outputTokens }
        : {}),
      ...(cost.costUsd !== null ? { cost_usd: cost.costUsd } : {}),
      cost_source: cost.source,
      latency_ms: Math.max(0, Math.round(input.latencyMs)),
      outcome: input.outcome,
      ...(input.stateHash !== undefined ? { state_hash: input.stateHash } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    };
    const createdAt = input.createdAt ?? new Date().toISOString();
    const written = appendContinuityRecord(v, {
      kind: DECISION_MODEL_CALL_KIND,
      createdAt,
      sourceRefs: [],
      payload,
    });
    if (cost.costUsd !== null) noteSpend(v, createdAt, cost.costUsd);
    return written;
  });
}

/**
 * Commit-side records of the extract-signals turn pre-filter (Part 4):
 * which written items cited a plan turn. Session and turn ids only.
 */
export const DECISION_MODEL_EXTRACT_COMMIT_KIND = "decision_model_extract_commit";

/** Extract pre-filter commit records, oldest first, optionally since an instant. */
export function listDecisionModelExtractCommits(
  vault: string,
  since?: string,
): ReadonlyArray<ContinuityRecord> {
  return listContinuityRecords(vault, {
    kind: DECISION_MODEL_EXTRACT_COMMIT_KIND,
    ...(since !== undefined ? { since } : {}),
  });
}

// ----- eval grade records (preregistered eval, cycle 20261020) ---------------

/**
 * One cached verdict set of the preregistered evaluation (`eval/grade.ts`):
 * what the graded run measured, under which spec, for which profile and
 * use. These records are REVIEW EVIDENCE only - the authoritative
 * machine-consumed tuning mark lives outside the vault
 * (`eval/mark.ts`), and a hand-written grade record can never promote a
 * use on its own. Identifiers, numbers and booleans only.
 */
export const DECISION_MODEL_EVAL_GRADE_KIND = "decision_model_eval_grade";

/** Input for one grade record, as the eval runner produced it. */
export interface DecisionEvalGradeRecordInput {
  readonly profile: string | null;
  readonly use: DecisionModelUse;
  readonly specHash: string;
  readonly fixtureHash: string;
  readonly seed: string;
  readonly metric: string;
  readonly ceiling: number;
  readonly minCounted: number;
  readonly countedN: number;
  readonly countedError: number | null;
  readonly baselineError: number | null;
  readonly devError: number | null;
  readonly verdict: DecisionEvalVerdict;
  readonly devIds: ReadonlyArray<string>;
  readonly countedIds: ReadonlyArray<string>;
  /** Boolean scorer verdict per counted item id. */
  readonly verdicts: Readonly<Record<string, boolean>>;
  /** The correlated `decision_model_call` record ids, in run order. */
  readonly callIds: ReadonlyArray<string>;
  readonly createdAt?: string;
}

/** Emit one grade record; returns null when there is no vault or the write failed. */
export function emitDecisionModelEvalGrade(
  vault: string | null,
  input: DecisionEvalGradeRecordInput,
): ContinuityRecord | null {
  return emitGatedTelemetry(vault, (v) =>
    appendContinuityRecord(v, {
      kind: DECISION_MODEL_EVAL_GRADE_KIND,
      createdAt: input.createdAt ?? new Date().toISOString(),
      sourceRefs: [],
      payload: {
        use: input.use,
        ...(input.profile !== null ? { profile: input.profile } : {}),
        spec_hash: input.specHash,
        fixture_hash: input.fixtureHash,
        seed: input.seed,
        metric: input.metric,
        ceiling: input.ceiling,
        min_counted: input.minCounted,
        counted_n: input.countedN,
        counted_error: input.countedError,
        baseline_error: input.baselineError,
        dev_error: input.devError,
        verdict: input.verdict,
        dev_ids: [...input.devIds],
        counted_ids: [...input.countedIds],
        verdicts: { ...input.verdicts },
        call_ids: [...input.callIds],
      },
    }),
  );
}

/** The typed grade a well-formed record parses into. */
export interface DecisionEvalGrade {
  readonly recordId: string;
  readonly createdAt: string;
  readonly use: DecisionModelUse;
  readonly profile: string | null;
  readonly specHash: string;
  readonly fixtureHash: string;
  readonly seed: string;
  readonly metric: string;
  readonly ceiling: number;
  readonly minCounted: number;
  readonly countedN: number;
  readonly countedError: number | null;
  readonly baselineError: number | null;
  readonly devError: number | null;
  readonly verdict: DecisionEvalVerdict;
  readonly devIds: ReadonlyArray<string>;
  readonly countedIds: ReadonlyArray<string>;
  readonly verdicts: Readonly<Record<string, boolean>>;
  readonly callIds: ReadonlyArray<string>;
}

export type DecisionEvalGradeParse =
  | { readonly ok: true; readonly grade: DecisionEvalGrade }
  | { readonly ok: false; readonly note: string };

function stringAt(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function numberAt(payload: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringListAt(payload: Readonly<Record<string, unknown>>, key: string): string[] | null {
  const value = payload[key];
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : null;
}

/**
 * Parse one continuity record into a typed grade, or return a note that
 * names why it is malformed. A hand-written record missing any required
 * field never masquerades as a measurement.
 */
export function parseDecisionModelEvalGrade(record: ContinuityRecord): DecisionEvalGradeParse {
  const skip = (why: string): DecisionEvalGradeParse => ({
    ok: false,
    note: `${DECISION_MODEL_EVAL_GRADE_KIND} record ${record.id} skipped: ${why}`,
  });
  if (record.kind !== DECISION_MODEL_EVAL_GRADE_KIND) {
    return skip(`kind is '${record.kind}'`);
  }
  const p = record.payload;
  const use = p["use"];
  if (!isDecisionModelUse(use))
    return skip(`use ${JSON.stringify(use)} is not a decision-model use`);
  const specHash = stringAt(p, "spec_hash");
  if (specHash === null) return skip("spec_hash is missing or not a string");
  const fixtureHash = stringAt(p, "fixture_hash");
  if (fixtureHash === null) return skip("fixture_hash is missing or not a string");
  const seed = stringAt(p, "seed");
  if (seed === null) return skip("seed is missing or not a string");
  const metric = stringAt(p, "metric");
  if (metric === null) return skip("metric is missing or not a string");
  const ceiling = numberAt(p, "ceiling");
  if (ceiling === null) return skip("ceiling is missing or not a number");
  const minCounted = numberAt(p, "min_counted");
  if (minCounted === null) return skip("min_counted is missing or not a number");
  const countedN = numberAt(p, "counted_n");
  if (countedN === null) return skip("counted_n is missing or not a number");
  const countedError = p["counted_error"];
  if (countedError !== null && typeof countedError !== "number") {
    return skip("counted_error must be a number or null");
  }
  const baselineError = p["baseline_error"];
  if (baselineError !== null && typeof baselineError !== "number") {
    return skip("baseline_error must be a number or null");
  }
  const devError = p["dev_error"];
  if (devError !== null && typeof devError !== "number") {
    return skip("dev_error must be a number or null");
  }
  const verdictRaw = stringAt(p, "verdict");
  if (
    verdictRaw === null ||
    !(DECISION_EVAL_VERDICTS as ReadonlyArray<string>).includes(verdictRaw)
  ) {
    return skip(`verdict must be one of ${DECISION_EVAL_VERDICTS.join(", ")}`);
  }
  const devIds = stringListAt(p, "dev_ids");
  if (devIds === null) return skip("dev_ids is missing or not a string array");
  const countedIds = stringListAt(p, "counted_ids");
  if (countedIds === null) return skip("counted_ids is missing or not a string array");
  const verdictsRaw = p["verdicts"];
  if (
    verdictsRaw === null ||
    typeof verdictsRaw !== "object" ||
    Array.isArray(verdictsRaw) ||
    !Object.values(verdictsRaw).every((v) => typeof v === "boolean")
  ) {
    return skip("verdicts must be an object of booleans");
  }
  const callIds = stringListAt(p, "call_ids");
  if (callIds === null) return skip("call_ids is missing or not a string array");
  const profileRaw = p["profile"];
  const profile =
    profileRaw === undefined || profileRaw === null
      ? null
      : typeof profileRaw === "string"
        ? profileRaw
        : null;
  if (profileRaw !== undefined && profileRaw !== null && profile === null) {
    return skip("profile must be a string or null");
  }
  return {
    ok: true,
    grade: {
      recordId: record.id,
      createdAt: record.createdAt,
      use,
      profile,
      specHash,
      fixtureHash,
      seed,
      metric,
      ceiling,
      minCounted,
      countedN,
      countedError,
      baselineError,
      devError,
      verdict: verdictRaw as DecisionEvalVerdict,
      devIds,
      countedIds,
      verdicts: verdictsRaw as Readonly<Record<string, boolean>>,
      callIds,
    },
  };
}

/**
 * Cached grade records, oldest first, each parsed; a malformed record is
 * skipped with a named note instead of poisoning the list.
 */
export function listDecisionModelEvalGrades(
  vault: string,
  since?: string,
): { readonly grades: ReadonlyArray<DecisionEvalGrade>; readonly skipped: ReadonlyArray<string> } {
  const grades: DecisionEvalGrade[] = [];
  const skipped: string[] = [];
  for (const record of listContinuityRecords(vault, {
    kind: DECISION_MODEL_EVAL_GRADE_KIND,
    ...(since !== undefined ? { since } : {}),
  })) {
    const parsed = parseDecisionModelEvalGrade(record);
    if (parsed.ok) grades.push(parsed.grade);
    else skipped.push(parsed.note);
  }
  return { grades, skipped };
}

/** Start of the current UTC day, canonical ISO form. */
export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** Records of this kind, oldest first, optionally since an instant. */
export function listDecisionModelCalls(
  vault: string,
  since?: string,
): ReadonlyArray<ContinuityRecord> {
  return listContinuityRecords(vault, {
    kind: DECISION_MODEL_CALL_KIND,
    ...(since !== undefined ? { since } : {}),
  });
}

/**
 * How long a loaded day total is trusted before the log is read again.
 * Within this window the total moves only by this process's own records;
 * the reload picks up what other processes spent meanwhile.
 */
export const SPEND_CACHE_TTL_MS = 60_000;

interface SpendEntry {
  /** The UTC day this total is for (`YYYY-MM-DD`). */
  readonly day: string;
  total: number;
  readonly loadedAtMs: number;
}

/**
 * Today's spend per vault, loaded from the log once and then kept current
 * by this process's own writes, so the gate does not parse the month's
 * continuity shard on every request.
 */
const SPEND_CACHE = new Map<string, SpendEntry>();

/** Tests only: forget every loaded total. */
export function resetDecisionSpendCache(): void {
  SPEND_CACHE.clear();
}

function noteSpend(vault: string, createdAt: string, costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  const entry = SPEND_CACHE.get(vault);
  if (entry !== undefined && entry.day === createdAt.slice(0, 10)) entry.total += costUsd;
}

function readDaySpend(vault: string, now: Date): number {
  let total = 0;
  for (const record of listDecisionModelCalls(vault, utcDayStart(now))) {
    const cost = record.payload["cost_usd"];
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
  }
  return total;
}

/**
 * Today's (UTC) spend: the sum of recorded `cost_usd`. Records without a
 * cost (unknown price) contribute nothing. The total is read from the log
 * at most once per {@link SPEND_CACHE_TTL_MS} and per UTC day, and this
 * process's own records are added as they are written; other processes'
 * records show up on the next reload, which keeps the gate a soft limit
 * across processes. A log that cannot be read throws, and the caller
 * decides what that means (the gate treats it as over the limit).
 */
export function todaySpendUsd(vault: string, now: Date = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();
  const entry = SPEND_CACHE.get(vault);
  if (
    entry !== undefined &&
    entry.day === day &&
    nowMs >= entry.loadedAtMs &&
    nowMs - entry.loadedAtMs < SPEND_CACHE_TTL_MS
  ) {
    return entry.total;
  }
  const total = readDaySpend(vault, now);
  SPEND_CACHE.set(vault, { day, total, loadedAtMs: nowMs });
  return total;
}

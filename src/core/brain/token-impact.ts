/**
 * Token-impact + context-pack-quality telemetry ledger
 * (context-pack-economics-observability suite).
 *
 * Open Second Brain enforces token/char budgets (`recall-budget.ts`,
 * `text-budget.ts`, `active-budget.ts`) and records recall/gate decision
 * telemetry (`recall-telemetry.ts`, `gate-telemetry.ts`), but it could not
 * answer the core value-of-memory question: "how many prompt tokens did the
 * memory layer actually keep out of (or add to) the agent call?". This
 * surface is the durable ledger for exactly that question.
 *
 * TWO STRICTLY SEPARATED LEDGERS, never conflated into one headline number:
 *
 *   1. Prompt-token delta - the token cost the memory layer contributed.
 *      `delta_tokens = baseline_tokens - packed_tokens` (positive = tokens
 *      KEPT OUT of the prompt, negative = tokens ADDED).
 *
 *      This surface used to label each sample `method: "exact" |
 *      "fallback"`, and the `"exact"` was a claim this module is in no
 *      position to make. It COUNTS NOTHING: `baseline_tokens` and
 *      `packed_tokens` are integers a caller posted, and nothing here
 *      verifies where they came from. Calling one of them exact asserted a
 *      property of a number the server never saw produced - and this repo
 *      has no exact token count to offer anywhere: there is no BPE
 *      tokenizer in the tree, only {@link ../brain/text/tokenizer.ts}'s
 *      documented `ceil(utf8_bytes / 4)` heuristic.
 *
 *      So the vocabulary now names PROVENANCE instead of ACCURACY - see
 *      {@link TOKEN_COUNT_METHOD}. A caller genuinely knows whether a
 *      tokenizer produced its number; neither the caller nor this module
 *      knows whether that number is exact for the model that will read the
 *      prompt. The summary keeps the per-method split, so which lane a
 *      figure came from stays inspectable; what it no longer does is
 *      certify one lane as truth.
 *
 *   2. MODELED inference-avoidance - a counterfactual estimate of the
 *      inferences (repairs/retries) the memory layer avoided, valued at
 *      `avoided_inferences * tokens_per_inference`. This is a model, not a
 *      measurement, so it lives in its own block and is CALIBRATED (never
 *      replaced) by real first-pass/repair/retry outcomes posted through
 *      {@link recordTokenImpactOutcome}: `calibrated = raw * first_pass_rate`
 *      (null until at least one outcome is posted).
 *
 * Durable + restart-surviving: samples are `token_impact` continuity
 * records and outcomes are `token_impact_outcome` records, so aggregates are
 * recomputed from disk on every read and survive a restart for free (the
 * continuity store is the byte-durable, month-sharded sink). The summary
 * accepts a `maxSamples` cap so a long-lived ledger stays bounded at
 * aggregation time.
 *
 * Privacy-preserving by construction: only COUNTS and an opaque `pack_id`
 * (a receipt id or request hash the caller chooses) ever land on disk - no
 * raw prompt, no recalled text. The whole payload still passes
 * `safeContinuityPayload` redaction.
 *
 * Gated + fail-open: emits route through `emitGatedTelemetry`, so with the
 * gate off no payload is built and no write happens, and a throwing write
 * never fails the operation being measured.
 */

import { emitGatedTelemetry } from "./continuity/emit.ts";
import {
  appendContinuityRecord,
  clipPayloadToBudget,
  listContinuityRecords,
} from "./continuity/store.ts";
import {
  CONTINUITY_AGENT_ID_KEY,
  CONTINUITY_SESSION_ID_KEY,
  type ContinuityRecord,
} from "./continuity/types.ts";

/**
 * How the prompt-token counts on a sample were PRODUCED - never how
 * accurate they are.
 *
 * Both members describe the caller's method, which the caller knows and
 * this module cannot check. Neither asserts that the resulting integer
 * matches what the model receiving the prompt will actually charge; see
 * this module's header for why the former `exact` / `fallback` pair was a
 * claim the ledger had no standing to make.
 */
export const TOKEN_COUNT_METHOD = Object.freeze({
  /** The caller ran a tokenizer and reported its count. */
  tokenizer: "tokenizer",
  /** The caller estimated, e.g. through `estimateTokens`. */
  heuristic: "heuristic",
} as const);

/** Closed union over {@link TOKEN_COUNT_METHOD}. */
export type TokenCountMethod = (typeof TOKEN_COUNT_METHOD)[keyof typeof TOKEN_COUNT_METHOD];

/** Membership list; every surface renders its vocabulary from this array. */
export const TOKEN_COUNT_METHODS: ReadonlyArray<TokenCountMethod> = Object.freeze([
  TOKEN_COUNT_METHOD.tokenizer,
  TOKEN_COUNT_METHOD.heuristic,
]);

/**
 * The labels this vocabulary replaced, mapped to their successors.
 *
 * A ledger written before the rename is on operators' disks right now.
 * Letting the strict guard reject those rows would drop them out of the
 * per-method split while still counting them in the totals - a silent,
 * misleading loss - so the read path translates them explicitly instead.
 * Writes only ever produce the current members.
 */
const LEGACY_TOKEN_COUNT_METHODS: Readonly<Record<string, TokenCountMethod>> = Object.freeze({
  exact: TOKEN_COUNT_METHOD.tokenizer,
  fallback: TOKEN_COUNT_METHOD.heuristic,
});

/** First-pass/repair/retry outcome posted to calibrate the modeled ledger. */
export type TokenImpactOutcome = "first_pass" | "repair" | "retry";

export interface TokenImpactInput {
  readonly createdAt?: string;
  readonly host?: string;
  readonly sessionId?: string;
  /** Authoring agent id, clip-protected beside session_id (t_5be0654d). */
  readonly agentId?: string;
  readonly turnId?: string;
  /**
   * Opaque correlation id for the context pack this sample measures - a
   * context-receipt id or a request hash the caller chooses. Never a raw
   * prompt or recalled text.
   */
  readonly packId?: string;
  /** Prompt-token cost WITHOUT the memory layer's compaction/selection. */
  readonly baselineTokens: number;
  /** Prompt-token cost the memory layer actually shipped. */
  readonly packedTokens: number;
  /** How the caller produced the counts - provenance, not accuracy. */
  readonly method: TokenCountMethod;
  /** Modeled count of inferences (repairs/retries) the layer is estimated to have avoided. */
  readonly modeledAvoidedInferences?: number;
  /** Modeled average prompt tokens per avoided inference. */
  readonly modeledTokensPerInference?: number;
}

export interface TokenImpactOutcomeInput {
  readonly createdAt?: string;
  readonly host?: string;
  readonly sessionId?: string;
  /** Authoring agent id, clip-protected beside session_id (t_5be0654d). */
  readonly agentId?: string;
  readonly packId?: string;
  readonly outcome: TokenImpactOutcome;
  /** Observed prompt tokens for the inference this outcome describes. */
  readonly tokensPerInference?: number;
}

export interface TokenImpactFilter {
  readonly host?: string;
  readonly packId?: string;
  readonly method?: TokenCountMethod;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  /**
   * Cap the number of most-recent samples aggregated by
   * {@link summarizeTokenImpact}. Keeps a long-lived ledger bounded at
   * aggregation time without truncating the durable log.
   */
  readonly maxSamples?: number;
  /**
   * Per-record output-budget clip in characters for {@link listTokenImpact}
   * (t_5be0654d). When set, each returned sample's payload is clipped to
   * this many characters with the identity keys (session_id, agent_id)
   * always retained; other keys are dropped only as far as needed to fit.
   * Omitted (the default) returns payloads unchanged - byte-identical.
   * Never applied to {@link summarizeTokenImpact}, which needs every field.
   */
  readonly payloadBudgetChars?: number;
}

export interface TokenImpactMethodStats {
  readonly samples: number;
  readonly net_savings_tokens: number;
}

/** Prompt-token delta ledger over the counts callers posted. */
export interface PromptTokenDeltaSummary {
  readonly total_samples: number;
  /** Sum of `delta_tokens` over all samples (signed: + kept out, − added). */
  readonly net_savings_tokens: number;
  /** Sum of positive deltas (tokens the layer kept out of the prompt). */
  readonly saved_tokens: number;
  /** Sum of |negative deltas| (tokens the layer added to the prompt). */
  readonly added_tokens: number;
  /** `net_savings_tokens / total_samples`, rounded to 1 dp; 0 for no samples. */
  readonly mean_savings_tokens: number;
  readonly by_method: {
    readonly tokenizer: TokenImpactMethodStats;
    readonly heuristic: TokenImpactMethodStats;
  };
}

export interface TokenImpactCalibration {
  readonly total_outcomes: number;
  readonly first_pass: number;
  readonly repair: number;
  readonly retry: number;
  /** `first_pass / total_outcomes`, rounded to 4 dp; null when no outcomes. */
  readonly first_pass_rate: number | null;
  /** Mean of posted `tokens_per_inference`, rounded to 1 dp; null when none. */
  readonly mean_tokens_per_inference: number | null;
}

/** MODELED counterfactual inference-avoidance ledger (strictly separate). */
export interface ModeledInferenceAvoidanceSummary {
  readonly samples: number;
  /** Sum of `modeled_savings_tokens` over samples that carry a modeled estimate. */
  readonly raw_savings_tokens: number;
  readonly calibration: TokenImpactCalibration;
  /**
   * `raw_savings_tokens * first_pass_rate`, rounded to 1 dp. Null until at
   * least one outcome has been posted - the modeled figure is uncalibrated,
   * not zero, so we refuse to imply precision we do not have.
   */
  readonly calibrated_savings_tokens: number | null;
}

export interface TokenImpactSummary {
  readonly total_samples: number;
  readonly prompt_token_delta: PromptTokenDeltaSummary;
  readonly modeled_inference_avoidance: ModeledInferenceAvoidanceSummary;
}

export function isTokenCountMethod(value: unknown): value is TokenCountMethod {
  return (
    typeof value === "string" && (TOKEN_COUNT_METHODS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Narrow a method read back off disk or across a tool boundary, accepting
 * the pre-rename labels through {@link LEGACY_TOKEN_COUNT_METHODS}.
 * Returns `null` for anything else - the caller decides what an
 * unclassifiable sample means, rather than being handed a default.
 */
export function normalizeTokenCountMethod(value: unknown): TokenCountMethod | null {
  if (isTokenCountMethod(value)) return value;
  if (typeof value !== "string") return null;
  return LEGACY_TOKEN_COUNT_METHODS[value] ?? null;
}

export function isTokenImpactOutcome(value: unknown): value is TokenImpactOutcome {
  return value === "first_pass" || value === "repair" || value === "retry";
}

/**
 * Emit one `token_impact` sample, gated and fail-open. `gate` doubles as the
 * opt-in switch: with `false | null | undefined` no payload is built and no
 * write happens (returns `null`). A throwing build - including invalid
 * counts - is swallowed and reported as `null` so the ledger can never fail
 * the operation it measures.
 */
export function emitTokenImpact<G>(
  vault: string,
  input: TokenImpactInput,
  gate: G | false | null | undefined,
): ContinuityRecord | null {
  return emitGatedTelemetry(gate, () => {
    if (!isTokenCountMethod(input.method)) {
      throw new TypeError(`token impact: method must be one of ${TOKEN_COUNT_METHODS.join(" | ")}`);
    }
    const baseline = nonNegativeCount("baseline_tokens", input.baselineTokens);
    const packed = nonNegativeCount("packed_tokens", input.packedTokens);
    const delta = baseline - packed;
    const modeled = resolveModeled(input);
    const payload: Record<string, unknown> = {
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.sessionId !== undefined ? { [CONTINUITY_SESSION_ID_KEY]: input.sessionId } : {}),
      ...(input.agentId !== undefined ? { [CONTINUITY_AGENT_ID_KEY]: input.agentId } : {}),
      ...(input.turnId !== undefined ? { turn_id: input.turnId } : {}),
      ...(input.packId !== undefined ? { pack_id: input.packId } : {}),
      method: input.method,
      baseline_tokens: baseline,
      packed_tokens: packed,
      delta_tokens: delta,
      ...(modeled !== null
        ? {
            modeled_avoided_inferences: modeled.avoided,
            modeled_tokens_per_inference: modeled.perInference,
            modeled_savings_tokens: modeled.savings,
          }
        : {}),
    };
    return appendContinuityRecord(vault, {
      kind: "token_impact",
      createdAt: input.createdAt ?? new Date().toISOString(),
      sourceRefs: [],
      payload,
    });
  });
}

/**
 * Record one first-pass/repair/retry outcome (the `/outcome` calibration
 * hook), gated and fail-open. Used only to calibrate the modeled ledger -
 * it never touches the prompt-token delta figures.
 */
export function recordTokenImpactOutcome<G>(
  vault: string,
  input: TokenImpactOutcomeInput,
  gate: G | false | null | undefined,
): ContinuityRecord | null {
  return emitGatedTelemetry(gate, () => {
    if (!isTokenImpactOutcome(input.outcome)) {
      throw new TypeError("token impact outcome: outcome must be first_pass | repair | retry");
    }
    const payload: Record<string, unknown> = {
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.sessionId !== undefined ? { [CONTINUITY_SESSION_ID_KEY]: input.sessionId } : {}),
      ...(input.agentId !== undefined ? { [CONTINUITY_AGENT_ID_KEY]: input.agentId } : {}),
      ...(input.packId !== undefined ? { pack_id: input.packId } : {}),
      outcome: input.outcome,
      ...(input.tokensPerInference !== undefined
        ? {
            tokens_per_inference: nonNegativeCount(
              "tokens_per_inference",
              input.tokensPerInference,
            ),
          }
        : {}),
    };
    return appendContinuityRecord(vault, {
      kind: "token_impact_outcome",
      createdAt: input.createdAt ?? new Date().toISOString(),
      sourceRefs: [],
      payload,
    });
  });
}

/** List `token_impact` samples newest-first, after applying filters. */
export function listTokenImpact(
  vault: string,
  filter: TokenImpactFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "token_impact",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => matchesFilter(record, filter));
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  // Output-budget clip (t_5be0654d): trim each retained sample's payload to
  // the char budget with the identity keys protected. A record that fits (or
  // no budget) is returned by the SAME reference, so the default is
  // byte-identical.
  if (filter.payloadBudgetChars !== undefined) {
    const budget = filter.payloadBudgetChars;
    records = records.map((record) => {
      const clipped = clipPayloadToBudget(record.payload, budget);
      return clipped === record.payload ? record : { ...record, payload: clipped };
    });
  }
  return Object.freeze(records);
}

/** List `token_impact_outcome` calibration posts newest-first. */
export function listTokenImpactOutcomes(
  vault: string,
  filter: TokenImpactFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "token_impact_outcome",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => matchesOutcomeFilter(record, filter));
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

/**
 * Roll the two ledgers up into a single summary that keeps them strictly
 * separated: the prompt-token delta (with a per-method split) and the
 * MODELED inference-avoidance figure (calibrated by posted outcomes). A
 * `limit` bounds only the raw list; `maxSamples` bounds aggregation.
 */
export function summarizeTokenImpact(
  vault: string,
  filter: TokenImpactFilter = {},
): TokenImpactSummary {
  // The roll-up spans the full filtered window - `limit` never bounds it,
  // and the per-record clip budget never applies (aggregation needs every
  // field, e.g. delta_tokens, which the clip may drop).
  const {
    limit: _limit,
    maxSamples,
    payloadBudgetChars: _payloadBudgetChars,
    ...summaryFilter
  } = filter;
  let samples = listTokenImpact(vault, summaryFilter);
  if (maxSamples !== undefined) samples = samples.slice(0, Math.max(0, Math.floor(maxSamples)));

  let net = 0;
  let saved = 0;
  let added = 0;
  const byMethod = {
    tokenizer: { samples: 0, net: 0 },
    heuristic: { samples: 0, net: 0 },
  };
  let modeledSamples = 0;
  let rawModeled = 0;

  for (const record of samples) {
    const payload = record.payload;
    const delta = numberOr(payload["delta_tokens"], null);
    if (delta !== null) {
      net += delta;
      if (delta > 0) saved += delta;
      else if (delta < 0) added += -delta;
    }
    // Legacy-aware so a pre-rename row is classified rather than dropped
    // from the split while still counting toward the totals.
    const method = normalizeTokenCountMethod(payload["method"]);
    if (method !== null && delta !== null) {
      byMethod[method].samples += 1;
      byMethod[method].net += delta;
    }
    const modeled = numberOr(payload["modeled_savings_tokens"], null);
    if (modeled !== null) {
      modeledSamples += 1;
      rawModeled += modeled;
    }
  }

  const calibration = summarizeCalibration(vault, summaryFilter);
  const calibrated =
    calibration.first_pass_rate === null ? null : round1(rawModeled * calibration.first_pass_rate);

  return Object.freeze({
    total_samples: samples.length,
    prompt_token_delta: Object.freeze({
      total_samples: samples.length,
      net_savings_tokens: net,
      saved_tokens: saved,
      added_tokens: added,
      mean_savings_tokens: samples.length > 0 ? round1(net / samples.length) : 0,
      by_method: Object.freeze({
        tokenizer: Object.freeze({
          samples: byMethod.tokenizer.samples,
          net_savings_tokens: byMethod.tokenizer.net,
        }),
        heuristic: Object.freeze({
          samples: byMethod.heuristic.samples,
          net_savings_tokens: byMethod.heuristic.net,
        }),
      }),
    }),
    modeled_inference_avoidance: Object.freeze({
      samples: modeledSamples,
      raw_savings_tokens: round1(rawModeled),
      calibration,
      calibrated_savings_tokens: calibrated,
    }),
  });
}

function summarizeCalibration(
  vault: string,
  filter: Omit<TokenImpactFilter, "limit" | "maxSamples">,
): TokenImpactCalibration {
  const outcomes = listTokenImpactOutcomes(vault, filter);
  let firstPass = 0;
  let repair = 0;
  let retry = 0;
  let tpiSum = 0;
  let tpiCount = 0;
  for (const record of outcomes) {
    const outcome = record.payload["outcome"];
    if (outcome === "first_pass") firstPass += 1;
    else if (outcome === "repair") repair += 1;
    else if (outcome === "retry") retry += 1;
    const tpi = numberOr(record.payload["tokens_per_inference"], null);
    if (tpi !== null) {
      tpiSum += tpi;
      tpiCount += 1;
    }
  }
  const total = firstPass + repair + retry;
  return Object.freeze({
    total_outcomes: total,
    first_pass: firstPass,
    repair,
    retry,
    first_pass_rate: total > 0 ? round4(firstPass / total) : null,
    mean_tokens_per_inference: tpiCount > 0 ? round1(tpiSum / tpiCount) : null,
  });
}

function resolveModeled(
  input: TokenImpactInput,
): { avoided: number; perInference: number; savings: number } | null {
  if (
    input.modeledAvoidedInferences === undefined &&
    input.modeledTokensPerInference === undefined
  ) {
    return null;
  }
  // Partial modeled input would otherwise default the missing field to 0 and
  // look like a measurement. Require both together; the throw fail-opens
  // to null (emitGatedTelemetry swallows it), matching the "omit, don't invent"
  // honesty goal stated in this module's header.
  if (
    input.modeledAvoidedInferences === undefined ||
    input.modeledTokensPerInference === undefined
  ) {
    throw new TypeError(
      "token impact: modeledAvoidedInferences and modeledTokensPerInference must both be supplied together",
    );
  }
  const avoided = nonNegativeCount("modeled_avoided_inferences", input.modeledAvoidedInferences);
  const perInference = nonNegativeCount(
    "modeled_tokens_per_inference",
    input.modeledTokensPerInference,
  );
  return { avoided, perInference, savings: round1(avoided * perInference) };
}

function nonNegativeCount(field: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`token impact: ${field} must be a finite number >= 0`);
  }
  return value;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function matchesFilter(record: ContinuityRecord, filter: TokenImpactFilter): boolean {
  const payload = record.payload;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  if (filter.packId !== undefined && payload["pack_id"] !== filter.packId) return false;
  if (
    filter.method !== undefined &&
    normalizeTokenCountMethod(payload["method"]) !== filter.method
  ) {
    return false;
  }
  return true;
}

function matchesOutcomeFilter(record: ContinuityRecord, filter: TokenImpactFilter): boolean {
  const payload = record.payload;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  if (filter.packId !== undefined && payload["pack_id"] !== filter.packId) return false;
  return true;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

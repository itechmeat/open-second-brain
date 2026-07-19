/**
 * Token-impact + context-pack-quality telemetry ledger
 * (context-pack-economics-observability suite).
 *
 * Open Second Brain enforces token/char budgets (`recall-budget.ts`,
 * `text-budget.ts`, `active-budget.ts`) and records recall/gate decision
 * telemetry (`recall-telemetry.ts`, `gate-telemetry.ts`), but it could not
 * answer the core value-of-memory question: "how many prompt tokens did the
 * memory layer actually keep out of (or add to) the agent call?". This
 * surface is the durable ledger that measures exactly that.
 *
 * TWO STRICTLY SEPARATED LEDGERS, never conflated into one headline number:
 *
 *   1. EXACT prompt-token delta - the real, measured token cost the memory
 *      layer contributed. `delta_tokens = baseline_tokens - packed_tokens`
 *      (positive = tokens KEPT OUT of the prompt, negative = tokens ADDED).
 *      Each sample is labelled `method: "exact" | "fallback"` so a
 *      tokenizer-exact count (posted by a host that ran a real BPE
 *      tokenizer) is never silently averaged in with a heuristic
 *      `estimateTokens` fallback. The summary keeps a per-method split so
 *      the honesty of the number is always inspectable.
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

/** How the prompt-token counts on a sample were obtained. */
export type TokenCountMethod = "exact" | "fallback";

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
  /** Whether the counts are tokenizer-exact or a heuristic fallback estimate. */
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

/** EXACT-type prompt-token delta ledger (real measurement). */
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
    readonly exact: TokenImpactMethodStats;
    readonly fallback: TokenImpactMethodStats;
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
  return value === "exact" || value === "fallback";
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
      throw new TypeError("token impact: method must be 'exact' or 'fallback'");
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
 * it never touches the exact prompt-token delta figures.
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
 * separated: the EXACT prompt-token delta (with a per-method split) and the
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
    exact: { samples: 0, net: 0 },
    fallback: { samples: 0, net: 0 },
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
    const method = payload["method"];
    if (isTokenCountMethod(method) && delta !== null) {
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
        exact: Object.freeze({
          samples: byMethod.exact.samples,
          net_savings_tokens: byMethod.exact.net,
        }),
        fallback: Object.freeze({
          samples: byMethod.fallback.samples,
          net_savings_tokens: byMethod.fallback.net,
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
  // look like an exact measurement. Require both together; the throw fail-opens
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
  if (filter.method !== undefined && payload["method"] !== filter.method) return false;
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

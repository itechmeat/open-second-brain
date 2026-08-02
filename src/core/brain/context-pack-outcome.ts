/**
 * Agent-operable context-pack outcome loop
 * (context-pack-economics-observability suite, C5).
 *
 * The token-impact ledger ({@link ./token-impact.ts}) measures the
 * prompt-token cost of the memory layer, but nothing closed the loop on
 * *recall quality*: whether the context OSB assembled actually led to a
 * first-pass success or forced a repair/retry. This surface is that loop.
 *
 * The agent carries the latest recall/context-pack quality-sample id (a
 * context-receipt id from {@link ContextPackReport.receiptId}) through its
 * session as BOUNDED LOCAL STATE - {@link SampleCarrier}, a small ring, not
 * a daemon - then on completion posts one compact OUTCOME ROW correlated to
 * that sample.
 *
 * THREE STRICTLY SEPARATED TOKEN SIGNALS, never merged into one headline
 * number - each lands in its own payload key:
 *
 *   1. EXACT prompt-token savings (`exact_prompt_token_savings`) - a
 *      tokenizer-aware delta, a real measurement.
 *   2. MODELED inference avoidance (`modeled_inference_avoidance`) - a
 *      confidence-banded counterfactual, a model, not a measurement.
 *   3. OBSERVED provider usage (`observed_provider_tokens`) - what the
 *      provider actually reported.
 *
 * Compact counters only: the payload never carries a raw prompt, completion,
 * source text, or secret, and the whole payload still passes
 * `safeContinuityPayload` redaction. The agent OMITS a field it does not
 * have rather than inventing a zero - every optional counter is written only
 * when the caller supplies it.
 *
 * Composes C3: every outcome row also posts a first-pass/repair/retry
 * calibration record to the token-impact ledger (via
 * {@link recordTokenImpactOutcome}), correlated by the same sample id, so the
 * modeled figure there is calibrated by measured recall outcomes.
 *
 * Composes the evidence half (provenance-at-the-boundary, unit I): every
 * outcome row also posts a `context_pack_evidence` record on the same sample
 * id, carrying the evidence the kernel read back off disk and the verdict of
 * the acting agent's claim against it (via {@link recordContextPackEvidence}).
 * The outcome row itself is never altered by that verdict - a contradicted
 * claim is recorded as a mismatch, not rejected and not silently corrected.
 *
 * Gated + fail-open: emits route through {@link emitGatedTelemetry}, so with
 * the gate off no payload is built and no write happens, and a throwing write
 * never fails the operation being measured.
 */

import {
  recordContextPackEvidence,
  type ContextPackEvidenceClaim,
} from "./context-pack-evidence.ts";
import { emitGatedTelemetry } from "./continuity/emit.ts";
import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import { CONTINUITY_AGENT_ID_KEY, type ContinuityRecord } from "./continuity/types.ts";
import { recordTokenImpactOutcome, type TokenImpactOutcome } from "./token-impact.ts";

export interface ContextPackOutcomeInput {
  readonly createdAt?: string;
  readonly host?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  /**
   * The carried recall/context-pack quality-sample id - a context-receipt
   * id ({@link ContextPackReport.receiptId}) or an opaque request hash. Never
   * a raw prompt or recalled text.
   */
  readonly sampleId: string;
  /**
   * The ACTING agent posting this outcome, clip-protected beside
   * session_id (t_5be0654d) and spread onto all three rows this post
   * lands. Self-asserted, like every identity in this system, and never
   * presented as a verifier.
   *
   * Supplied by the CALLER, not resolved from config here. The sibling
   * `token_impact*` payloads have declared the same field since
   * t_5be0654d and no production caller has ever set it, so "the siblings
   * already carry it" was never true of anything on disk; the surface that
   * makes it true is `brain_context_pack_outcome`'s `agent_id` argument,
   * which reaches this row, the token-impact calibration row and the
   * evidence row from one place. Omitted records no actor - a guessed
   * identity is worse than a missing one.
   */
  readonly agentId?: string;
  /** Whether the packed context led to a first-pass success (no repair/retry). */
  readonly firstPassSuccess: boolean;
  /** Whether the agent had to repair the first completion. */
  readonly repairRequired?: boolean;
  /** How many retries the completion needed. */
  readonly retryCount?: number;
  /** Compact count of tokens spent on follow-up turns after the first pass. */
  readonly followUpTokens?: number;
  /** EXACT tokenizer-aware prompt-token savings (measurement). */
  readonly exactPromptTokenSavings?: number;
  /** MODELED confidence-banded inference-avoidance estimate (a model). */
  readonly modeledInferenceAvoidance?: number;
  /** OBSERVED provider-reported token usage for this inference. */
  readonly observedProviderTokens?: number;
  /**
   * What the acting agent asserts about the sample it is reporting on,
   * checked against the evidence the kernel reads off disk. Omitted when
   * the agent asserts nothing - the evidence record is still written, and
   * says so.
   */
  readonly evidenceClaim?: ContextPackEvidenceClaim;
}

export interface ContextPackOutcomeFilter {
  readonly host?: string;
  readonly sampleId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  /**
   * Cap the number of most-recent rows aggregated by
   * {@link summarizeContextPackOutcomes}. Keeps a long-lived ledger bounded
   * at aggregation time without truncating the durable log.
   */
  readonly maxSamples?: number;
}

export interface ContextPackOutcomeSummary {
  readonly total: number;
  readonly first_pass_success: number;
  readonly repair_required: number;
  /** Sum of posted `retry_count` across rows. */
  readonly retries: number;
  /** `first_pass_success / total`, rounded to 4 dp; null when no rows. */
  readonly first_pass_rate: number | null;
  /** The three token signals kept strictly separate - never a merged total. */
  readonly token_signals: {
    readonly exact: { readonly samples: number; readonly prompt_token_savings: number };
    readonly modeled: { readonly samples: number; readonly inference_avoidance: number };
    readonly observed: { readonly samples: number; readonly provider_tokens: number };
  };
  readonly follow_up: { readonly samples: number; readonly tokens: number };
}

/** The records one `post` lands, so a caller need not read them back. */
export interface ContextPackOutcomePost {
  /** The `context_pack_outcome` row. */
  readonly outcome: ContinuityRecord;
  /**
   * The `context_pack_evidence` row joined to it on the sample id.
   * `null` only when that half fail-opened - the evidence writer is
   * gated and fail-open in its own right, so it can never take the
   * outcome row down with it.
   */
  readonly evidence: ContinuityRecord | null;
}

/**
 * Post one outcome: the `context_pack_outcome` row, the matching
 * first-pass/repair/retry calibration record on the token-impact ledger
 * (C3), and the `context_pack_evidence` record carrying the kernel's
 * reading of the sample against the agent's claim (unit I). All three are
 * joined by the one sample id.
 *
 * `gate` doubles as the opt-in switch: with `false | null | undefined` no
 * payload is built and no write happens (returns `null`). A throwing build -
 * including a blank sample id - is swallowed and reported as `null` so the
 * loop can never fail the operation it measures.
 */
export function postContextPackOutcome<G>(
  vault: string,
  input: ContextPackOutcomeInput,
  gate: G | false | null | undefined,
): ContextPackOutcomePost | null {
  return emitGatedTelemetry(gate, (openGate) => {
    const sampleId = requireSampleId(input.sampleId);
    if (typeof input.firstPassSuccess !== "boolean") {
      throw new TypeError("context pack outcome: firstPassSuccess must be a boolean");
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const payload: Record<string, unknown> = {
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
      ...(input.turnId !== undefined ? { turn_id: input.turnId } : {}),
      ...(input.agentId !== undefined ? { [CONTINUITY_AGENT_ID_KEY]: input.agentId } : {}),
      sample_id: sampleId,
      first_pass_success: input.firstPassSuccess,
      // Omit-don't-invent: every optional counter is written only when supplied.
      ...(input.repairRequired !== undefined ? { repair_required: input.repairRequired } : {}),
      ...(input.retryCount !== undefined
        ? { retry_count: nonNegativeCount("retry_count", input.retryCount) }
        : {}),
      ...(input.followUpTokens !== undefined
        ? { follow_up_tokens: nonNegativeCount("follow_up_tokens", input.followUpTokens) }
        : {}),
      // Three strictly separate token signals - never a merged headline field.
      ...(input.exactPromptTokenSavings !== undefined
        ? {
            exact_prompt_token_savings: nonNegativeCount(
              "exact_prompt_token_savings",
              input.exactPromptTokenSavings,
            ),
          }
        : {}),
      ...(input.modeledInferenceAvoidance !== undefined
        ? {
            modeled_inference_avoidance: nonNegativeCount(
              "modeled_inference_avoidance",
              input.modeledInferenceAvoidance,
            ),
          }
        : {}),
      ...(input.observedProviderTokens !== undefined
        ? {
            observed_provider_tokens: nonNegativeCount(
              "observed_provider_tokens",
              input.observedProviderTokens,
            ),
          }
        : {}),
    };
    const record = appendContinuityRecord(vault, {
      kind: "context_pack_outcome",
      createdAt,
      sourceRefs: [],
      payload,
    });
    // Compose C3: calibrate the token-impact ledger with the measured
    // recall outcome, correlated by the same sample id. `recordTokenImpactOutcome`
    // is itself gated + fail-open, so it never throws through this thunk.
    recordTokenImpactOutcome(
      vault,
      {
        createdAt,
        ...(input.host !== undefined ? { host: input.host } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        packId: sampleId,
        outcome: deriveOutcome(input),
        ...(input.observedProviderTokens !== undefined
          ? { tokensPerInference: input.observedProviderTokens }
          : {}),
      },
      openGate,
    );
    // Compose the evidence half: what the kernel reads off disk for this
    // sample, and how the agent's claim compares. Also gated + fail-open,
    // so it never throws through this thunk either - the outcome row above
    // is already durable and stays that way regardless of the verdict.
    const evidence = recordContextPackEvidence(
      vault,
      {
        createdAt,
        ...(input.host !== undefined ? { host: input.host } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        sampleId,
        ...(input.evidenceClaim !== undefined ? { claim: input.evidenceClaim } : {}),
      },
      openGate,
    );
    return Object.freeze({ outcome: record, evidence });
  });
}

/**
 * Emit one `context_pack_outcome` row and its two joined side effects,
 * returning the outcome record alone. The thin form of
 * {@link postContextPackOutcome} for callers that only need the row; the
 * calibration and evidence records are durable side effects, listable via
 * `listTokenImpactOutcomes` and `listContextPackEvidence`.
 */
export function emitContextPackOutcome<G>(
  vault: string,
  input: ContextPackOutcomeInput,
  gate: G | false | null | undefined,
): ContinuityRecord | null {
  return postContextPackOutcome(vault, input, gate)?.outcome ?? null;
}

/**
 * Extract the recall/context-pack quality-sample id from a pack report to
 * carry through the session. The context-receipt id ({@link
 * ContextPackReport.receiptId}) is the durable sample id; the telemetry id is
 * a fallback when only telemetry was emitted. Returns null when the pack
 * emitted neither (no opt-in receipt/telemetry) - there is then no sample to
 * post an outcome against. Deliberately reads the report's PUBLIC ids rather
 * than mutating its shape, so an opted-out pack stays byte-identical.
 */
export function contextPackSampleId(report: {
  readonly receiptId?: string;
  readonly telemetryId?: string;
}): string | null {
  return report.receiptId ?? report.telemetryId ?? null;
}

/** List `context_pack_outcome` rows newest-first, after applying filters. */
export function listContextPackOutcomes(
  vault: string,
  filter: ContextPackOutcomeFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "context_pack_outcome",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => matchesFilter(record, filter));
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

/**
 * Roll the outcome rows up into a summary that keeps the three token
 * signals strictly separated and reports a measured first-pass rate. A
 * `limit` bounds only the raw list; `maxSamples` bounds aggregation.
 */
export function summarizeContextPackOutcomes(
  vault: string,
  filter: ContextPackOutcomeFilter = {},
): ContextPackOutcomeSummary {
  const { limit: _limit, maxSamples, ...summaryFilter } = filter;
  let rows = listContextPackOutcomes(vault, summaryFilter);
  if (maxSamples !== undefined) rows = rows.slice(0, Math.max(0, Math.floor(maxSamples)));

  let firstPass = 0;
  let repair = 0;
  let retries = 0;
  const exact = { samples: 0, sum: 0 };
  const modeled = { samples: 0, sum: 0 };
  const observed = { samples: 0, sum: 0 };
  const followUp = { samples: 0, sum: 0 };

  for (const record of rows) {
    const payload = record.payload;
    if (payload["first_pass_success"] === true) firstPass += 1;
    if (payload["repair_required"] === true) repair += 1;
    const retry = numberOr(payload["retry_count"], null);
    if (retry !== null) retries += retry;
    accumulate(exact, payload["exact_prompt_token_savings"]);
    accumulate(modeled, payload["modeled_inference_avoidance"]);
    accumulate(observed, payload["observed_provider_tokens"]);
    accumulate(followUp, payload["follow_up_tokens"]);
  }

  return Object.freeze({
    total: rows.length,
    first_pass_success: firstPass,
    repair_required: repair,
    retries,
    first_pass_rate: rows.length > 0 ? round4(firstPass / rows.length) : null,
    token_signals: Object.freeze({
      exact: Object.freeze({ samples: exact.samples, prompt_token_savings: exact.sum }),
      modeled: Object.freeze({ samples: modeled.samples, inference_avoidance: modeled.sum }),
      observed: Object.freeze({ samples: observed.samples, provider_tokens: observed.sum }),
    }),
    follow_up: Object.freeze({ samples: followUp.samples, tokens: followUp.sum }),
  });
}

/**
 * Bounded local state that carries the latest recall/context-pack
 * quality-sample ids through a session - a small most-recent ring, NOT a
 * daemon. `remember` de-dupes an id to most-recent without growing; `latest`
 * returns the head to post an outcome against on completion.
 */
export class SampleCarrier {
  private readonly capacity: number;
  private readonly ids: string[] = [];

  constructor(capacity = 8) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Record a sample id as the most-recent, evicting the oldest past capacity. */
  remember(sampleId: string): void {
    const trimmed = typeof sampleId === "string" ? sampleId.trim() : "";
    if (trimmed === "") return;
    const existing = this.ids.indexOf(trimmed);
    if (existing !== -1) this.ids.splice(existing, 1);
    this.ids.push(trimmed);
    while (this.ids.length > this.capacity) this.ids.shift();
  }

  /** The most-recent carried sample id, or null when none has been seen. */
  latest(): string | null {
    return this.ids.length > 0 ? (this.ids[this.ids.length - 1] as string) : null;
  }

  has(sampleId: string): boolean {
    return this.ids.includes(typeof sampleId === "string" ? sampleId.trim() : "");
  }

  /** All carried ids, oldest-first. */
  all(): ReadonlyArray<string> {
    return Object.freeze([...this.ids]);
  }

  get size(): number {
    return this.ids.length;
  }
}

/**
 * Map a compact outcome row onto the token-impact ledger's single outcome
 * enum. A retry dominates (it implies more than a repair); a repair dominates
 * a clean first pass; only a flagged first-pass success with no repair/retry
 * is `first_pass`. Anything else (not first-pass, no explicit repair/retry)
 * is honestly recorded as a `repair`.
 */
function deriveOutcome(input: ContextPackOutcomeInput): TokenImpactOutcome {
  if ((input.retryCount ?? 0) > 0) return "retry";
  if (input.repairRequired === true) return "repair";
  if (input.firstPassSuccess === true) return "first_pass";
  return "repair";
}

function accumulate(acc: { samples: number; sum: number }, raw: unknown): void {
  const value = numberOr(raw, null);
  if (value !== null) {
    acc.samples += 1;
    acc.sum += value;
  }
}

function requireSampleId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new TypeError("context pack outcome: sampleId must be a non-empty string");
  }
  return raw.trim();
}

function nonNegativeCount(field: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`context pack outcome: ${field} must be a finite number >= 0`);
  }
  return value;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function matchesFilter(record: ContinuityRecord, filter: ContextPackOutcomeFilter): boolean {
  const payload = record.payload;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  if (filter.sampleId !== undefined && payload["sample_id"] !== filter.sampleId) return false;
  return true;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

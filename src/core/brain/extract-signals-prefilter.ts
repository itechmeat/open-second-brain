/**
 * Optional decision-model turn pre-filter for `extract-signals` (issue
 * #213, Part 4, use `extract_prefilter`).
 *
 * {@link planExtractSignals} hands the host every mined user turn in one
 * envelope. Most user turns are tasks, questions or one-off instructions,
 * and the host pays for each of them, plus a whole round trip when the
 * session states no rule at all. This module asks a decision model one
 * `noul` per turn ("does this turn state a durable taste signal?") and,
 * in `enforce`, drops the turns that clearly do not.
 *
 *   - `off` (the default, and every configuration that is not active):
 *     exactly {@link planExtractSignals}, synchronous path, byte-identical
 *     output, no request, no record.
 *   - `shadow`: the requests are sent and the per-turn probabilities are
 *     recorded, but the envelope and `turnsMined` are the full ones.
 *   - `enforce`: a turn is dropped only when its probability is below
 *     {@link EXTRACT_PREFILTER_DROP_BELOW}. When every turn is dropped the
 *     plan carries no envelope and says why (`skipped`), a new explicit
 *     outcome distinct from the "nothing to mine" refusal.
 *
 * A dropped turn is a lost signal, so everything leans towards keeping a
 * turn: an unscored turn (withheld, over budget, invalid item) is kept,
 * and any failure of a request sends every turn as today and names the
 * reason in `decisionModel.degraded`. The decision only filters turns this
 * module's own code produced; it never writes to the vault.
 *
 * With the use not `off`, the envelope's schema hints also name the
 * optional `source_turn` item field, so the commit can say which turn an
 * item came from and `report` can measure regret (accepted items whose
 * turn scored below the threshold). Principles are often written in the
 * operator's language while hosted models are strongest in English; until
 * a vault's own evaluation shows zero regret the use should stay in
 * shadow.
 */

import { randomUUID } from "node:crypto";

import { discoverConfig } from "../config.ts";
import {
  decisionModelModeFor,
  resolveDecisionModelConfig,
  type ResolvedDecisionModelConfig,
} from "../decision-model/config.ts";
import {
  decisionTokenImpactSource,
  type DecisionDegradeReason,
  type DecisionProvider,
  type DecisionQuestion,
} from "../decision-model/contract.ts";
import { makeDecisionProvider } from "../decision-model/provider.ts";
import { DECISION_MODEL_EXTRACT_COMMIT_KIND } from "../decision-model/record.ts";
import {
  EXTRACT_PREFILTER_DROP_BELOW,
  EXTRACT_PREFILTER_QUESTIONS,
} from "../decision-model/questions.ts";
import { runDecision, type BuiltDecisionState } from "../decision-model/run.ts";
import {
  buildCandidateState,
  type CandidateStateResult,
  type StateCandidate,
} from "../decision-model/state.ts";
import { privateRegionTexts } from "../redactor.ts";
import { appendContinuityRecord } from "./continuity/store.ts";
import { emitGatedTelemetry } from "./continuity/emit.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import {
  buildMiningStep,
  planExtractSignals,
  type CommitExtractedSignalsResult,
  type MinedTurn,
  type SignalExtractionPlan,
} from "./extract-signals.ts";
import type { NeedsLlmStep } from "./llm-step.ts";
import { listSessionRawTurns } from "./session-recall.ts";
import { estimateTokens as estimateTextTokens } from "./text/tokenizer.ts";
import { emitTokenImpact, TOKEN_COUNT_METHOD } from "./token-impact.ts";

const USE = "extract_prefilter" as const;

/** `skipped.reason` when every mined turn scored below the threshold. */
export const EXTRACT_PREFILTER_SKIP_REASON = "decision_model_prefilter";

/** `token_impact.source` for this use's samples. */
export const EXTRACT_PREFILTER_TOKEN_SOURCE = decisionTokenImpactSource("extract_prefilter");

/** A plan the pre-filter path returns. Equal to {@link SignalExtractionPlan} when nothing applied. */
export interface PrefilteredSignalExtractionPlan extends Omit<SignalExtractionPlan, "llmStep"> {
  /** Null only when {@link skipped} is set. */
  readonly llmStep: NeedsLlmStep | null;
  /** Enforce only: ids of the turns left out of the envelope, in record order. */
  readonly turnsDropped?: ReadonlyArray<string>;
  /** Enforce only: every mined turn was dropped, so there is nothing to mine. */
  readonly skipped?: {
    readonly reason: typeof EXTRACT_PREFILTER_SKIP_REASON;
    readonly turnsDropped: number;
  };
  /** Present only when the use is not `off` and a request failed. */
  readonly decisionModel?: { readonly degraded: DecisionDegradeReason };
}

export interface PrefilteredPlanOptions {
  readonly now: Date;
  readonly decisionModel: ResolvedDecisionModelConfig | null | undefined;
  /** Injected provider (tests). */
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The operator's `token_impact` ledger opt-in. */
  readonly tokenImpactEnabled?: boolean;
}

/** Whether this configuration runs the pre-filter at all. */
export function extractPrefilterActive(
  cfg: ResolvedDecisionModelConfig | null | undefined,
): boolean {
  return decisionModelModeFor(cfg, USE) !== "off";
}

/**
 * The decision config for this use, or null when the pre-filter does not
 * run (feature disabled, no key, invalid or unreadable config, vault
 * opt-out, or the use `off`). Never throws.
 */
export function resolveExtractPrefilterConfig(
  vault: string,
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDecisionModelConfig | null {
  try {
    const cfg = resolveDecisionModelConfig({
      env,
      config: discoverConfig(configPath).data,
      vault,
    });
    return extractPrefilterActive(cfg) ? cfg : null;
  } catch {
    return null;
  }
}

// ----- state chunks ------------------------------------------------------------

/** One request's worth of turns, or a turn that could not be scored. */
type PrefilterChunk =
  | {
      readonly kind: "ok";
      readonly state: Readonly<Record<string, unknown>>;
      /** Mined-turn index for each mask position: `turns[k]` is `T<k>`. */
      readonly turns: ReadonlyArray<number>;
    }
  /** A turn that does not fit `max_state_tokens` even alone: unscored, kept. */
  | { readonly kind: "budget"; readonly turns: ReadonlyArray<number> };

function stateCandidate(turn: MinedTurn): StateCandidate {
  // A session turn is not a vault page: it has no visibility of its own,
  // and the capture boundary has already removed suppressed messages. Its
  // own `<private>` regions are stripped, and a turn that still carries a
  // line of one is withheld (unscored, so kept).
  return { text: turn.text, visibility: [], privateRegions: privateRegionTexts(turn.text) };
}

function buildState(indices: ReadonlyArray<number>, turns: ReadonlyArray<MinedTurn>, max: number) {
  return buildCandidateState({
    candidates: indices.map((i) => stateCandidate(turns[i]!)),
    prefix: EXTRACT_PREFILTER_QUESTIONS.prefix,
    clipChars: EXTRACT_PREFILTER_QUESTIONS.clipChars,
    maxStateTokens: max,
    frame: (texts) => ({ turns: texts }),
  });
}

/**
 * Split the mined turns into as few requests as fit `maxStateTokens`,
 * in record order. No turn is ever dropped for budget: a turn the state
 * builder cannot place is carried into the next request, and one that
 * does not fit even alone becomes a `budget` chunk (unscored, kept).
 * Withheld turns appear in no chunk (unscored, kept).
 */
function planPrefilterChunks(
  turns: ReadonlyArray<MinedTurn>,
  maxStateTokens: number,
): ReadonlyArray<PrefilterChunk> {
  const chunks: PrefilterChunk[] = [];
  let remaining: ReadonlyArray<number> = turns.map((_, i) => i);
  while (remaining.length > 0) {
    const built: CandidateStateResult = buildState(remaining, turns, maxStateTokens);
    if (built.kind === "empty") break;
    if (built.kind === "ok") {
      chunks.push({
        kind: "ok",
        state: built.state,
        turns: Object.freeze(built.included.map((k) => remaining[k]!)),
      });
      remaining = built.dropped.map((k) => remaining[k]!);
      continue;
    }
    // Not even the first eligible turn fits alone: find it, mark it
    // unscored, and go on with the rest.
    const first = remaining.findIndex(
      (i) => buildState([i], turns, maxStateTokens).kind !== "empty",
    );
    if (first < 0) break;
    chunks.push({ kind: "budget", turns: Object.freeze([remaining[first]!]) });
    remaining = remaining.slice(first + 1);
  }
  return Object.freeze(chunks);
}

function questionsFor(count: number): Readonly<Record<string, DecisionQuestion>> {
  const qs: Record<string, DecisionQuestion> = {};
  for (let k = 0; k < count; k++) {
    qs[EXTRACT_PREFILTER_QUESTIONS.signalId(k)] = EXTRACT_PREFILTER_QUESTIONS.signal(k);
  }
  return qs;
}

// ----- the plan ------------------------------------------------------------------

/**
 * The plan phase with the optional pre-filter. With the use `off` this is
 * exactly {@link planExtractSignals}. Refusals ({@link ExtractSignalsError})
 * are thrown as there, before any request.
 */
export async function planExtractSignalsPrefiltered(
  vault: string,
  sessionId: string,
  opts: PrefilteredPlanOptions,
): Promise<PrefilteredSignalExtractionPlan> {
  const cfg = opts.decisionModel;
  if (!extractPrefilterActive(cfg)) return planExtractSignals(vault, sessionId, { now: opts.now });
  const provider = opts.provider ?? makeDecisionProvider(cfg, opts.env ?? process.env, vault);
  if (provider === null) return planExtractSignals(vault, sessionId, { now: opts.now });

  const full = planExtractSignals(vault, sessionId, { now: opts.now, sourceTurnHint: true });
  const mined = full.turnsMined;
  const correlationId = randomUUID();
  const chunks = planPrefilterChunks(mined, cfg!.maxStateTokens);
  const probability = new Map<number, number>();
  let mode: "shadow" | "enforce" | null = null;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const details = (probs: ReadonlyArray<number | null>): Record<string, unknown> => ({
      session_id: full.sessionId,
      correlation_id: correlationId,
      request_index: chunkIndex,
      request_count: chunks.length,
      plan_turn_count: mined.length,
      turn_ids: chunk.turns.map((i) => mined[i]!.turnId),
      turn_chars: chunk.turns.map((i) =>
        Math.min([...mined[i]!.text].length, EXTRACT_PREFILTER_QUESTIONS.clipChars),
      ),
      probabilities: probs,
      threshold: EXTRACT_PREFILTER_DROP_BELOW,
    });
    // Sequential on purpose: the first failed request stops the rest (all
    // turns are then sent anyway), and each request passes the cost gate
    // after the previous one's spend is recorded.
    // oxlint-disable-next-line no-await-in-loop
    const run = await runDecision<ReadonlyArray<number>>(
      USE,
      (): BuiltDecisionState<ReadonlyArray<number>> =>
        chunk.kind === "ok"
          ? {
              kind: "ok",
              state: chunk.state,
              candidateCount: chunk.turns.length,
              context: chunk.turns,
            }
          : { kind: "budget" },
      (built) => questionsFor(built.candidateCount),
      {
        config: cfg,
        provider,
        secretsVault: vault,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        now: () => opts.now,
        recordDetails: (response) =>
          details(
            chunk.turns.map((_, k) => {
              const a = response?.answers[EXTRACT_PREFILTER_QUESTIONS.signalId(k)];
              return a !== undefined && a.valid && typeof a.value === "number" ? a.value : null;
            }),
          ),
      },
    );
    if (run.status === "off") return planExtractSignals(vault, sessionId, { now: opts.now });
    if (run.status === "empty") continue;
    mode = run.mode === "enforce" ? "enforce" : "shadow";
    if (run.status === "degraded") {
      // Budget of one oversized turn leaves that turn unscored; every
      // other degrade is a failed decision: all turns, reason named.
      if (run.reason === "budget") continue;
      return Object.freeze({ ...full, decisionModel: Object.freeze({ degraded: run.reason }) });
    }
    run.context.forEach((turnIndex, k) => {
      const a = run.response.answers[EXTRACT_PREFILTER_QUESTIONS.signalId(k)];
      if (a !== undefined && a.valid && typeof a.value === "number" && Number.isFinite(a.value)) {
        probability.set(turnIndex, a.value);
      }
    });
  }

  if (mode !== "enforce") return full;

  const kept: MinedTurn[] = [];
  const dropped: string[] = [];
  mined.forEach((turn, i) => {
    const p = probability.get(i);
    if (p !== undefined && p < EXTRACT_PREFILTER_DROP_BELOW) dropped.push(turn.turnId);
    else kept.push(turn);
  });
  const baselineTokens = envelopeTokens(full.llmStep);
  if (kept.length === 0) {
    emitPrefilterTokenImpact(vault, opts, full.sessionId, baselineTokens, 0, true);
    return Object.freeze({
      ...full,
      turnsMined: Object.freeze([]),
      llmStep: null,
      turnsDropped: Object.freeze(dropped),
      skipped: Object.freeze({
        reason: EXTRACT_PREFILTER_SKIP_REASON,
        turnsDropped: dropped.length,
      }),
    });
  }
  const llmStep =
    dropped.length === 0
      ? full.llmStep
      : buildMiningStep(full.sessionId, kept, { sourceTurnHint: true });
  emitPrefilterTokenImpact(
    vault,
    opts,
    full.sessionId,
    baselineTokens,
    envelopeTokens(llmStep),
    false,
  );
  return Object.freeze({
    ...full,
    turnsMined: Object.freeze(kept),
    llmStep,
    turnsDropped: Object.freeze(dropped),
  });
}

function envelopeTokens(step: NeedsLlmStep): number {
  return estimateTextTokens(JSON.stringify(step));
}

function emitPrefilterTokenImpact(
  vault: string,
  opts: PrefilteredPlanOptions,
  sessionId: string,
  baselineTokens: number,
  packedTokens: number,
  skipped: boolean,
): void {
  emitTokenImpact(
    vault,
    {
      createdAt: opts.now.toISOString(),
      sessionId,
      source: EXTRACT_PREFILTER_TOKEN_SOURCE,
      method: TOKEN_COUNT_METHOD.heuristic,
      baselineTokens,
      packedTokens,
      ...(skipped
        ? { modeledAvoidedInferences: 1, modeledTokensPerInference: baselineTokens }
        : {}),
    },
    opts.tokenImpactEnabled === true || undefined,
  );
}

// ----- the commit side --------------------------------------------------------------

/**
 * Record which written items cited a plan turn, for the regret metric.
 * Only when the use is not `off`, only for `source_turn` values that are
 * real turn ids of the session (host text never reaches the record), and
 * never fails the commit. Returns null when nothing was written.
 */
export function recordExtractPrefilterCommit(
  vault: string,
  cfg: ResolvedDecisionModelConfig | null | undefined,
  result: CommitExtractedSignalsResult,
  now: Date,
): ContinuityRecord | null {
  if (!extractPrefilterActive(cfg) || result.written.length === 0) return null;
  return emitGatedTelemetry(vault, (v) => {
    const known = new Set(listSessionRawTurns(v, result.sessionId).map((t) => t.turn_id));
    const cited = result.written
      .map((w) => w.sourceTurn)
      .filter((t): t is string => t !== undefined && known.has(t));
    return appendContinuityRecord(v, {
      kind: DECISION_MODEL_EXTRACT_COMMIT_KIND,
      createdAt: now.toISOString(),
      sourceRefs: [],
      payload: {
        session_id: result.sessionId,
        mode: decisionModelModeFor(cfg, USE),
        written_count: result.written.length,
        source_turns: cited,
        without_source_turn_count: result.written.length - cited.length,
      },
    });
  });
}

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
 * Before any of that, the plan passes the mining ledger's zero-yield gate
 * (session-mining-ledger.ts): a session whose current turn material was
 * already mined and yielded nothing accepted is suppressed outright, on
 * every configuration, before a single request is built - the tombstone's
 * saving is the caller's whole mining round trip, which is more than the
 * pre-filter could ever measure.
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
import { readMiningTombstone, type SessionMiningOutcome } from "./session-mining-ledger.ts";
import { closedSurveyFailure, recordMiningSurvey } from "./session-mining-surveys.ts";
import { listSessionRawTurns } from "./session-recall.ts";
import { estimateTokens as estimateTextTokens } from "./text/tokenizer.ts";
import { emitTokenImpact, TOKEN_COUNT_METHOD } from "./token-impact.ts";

const USE = "extract_prefilter" as const;

/** `skipped.reason` when every mined turn scored below the threshold. */
export const EXTRACT_PREFILTER_SKIP_REASON = "decision_model_prefilter";

/**
 * `skipped.reason` when the session's current turn material is already
 * tombstoned in the mining ledger: it was mined before and the commit
 * yielded nothing accepted, so there is no envelope to answer and the
 * recorded breakdown rides along as evidence.
 */
export const EXTRACT_MINING_TOMBSTONE_SKIP_REASON = "mining_tombstone";

/** `token_impact.source` for this use's samples. */
export const EXTRACT_PREFILTER_TOKEN_SOURCE = decisionTokenImpactSource("extract_prefilter");

/** A plan the pre-filter path returns. Equal to {@link SignalExtractionPlan} when nothing applied. */
export interface PrefilteredSignalExtractionPlan extends Omit<SignalExtractionPlan, "llmStep"> {
  /** Null only when {@link skipped} is set. */
  readonly llmStep: NeedsLlmStep | null;
  /** Enforce only: ids of the turns left out of the envelope, in record order. */
  readonly turnsDropped?: ReadonlyArray<string>;
  /**
   * There is no envelope, and here is why - one channel for every
   * suppression. With the pre-filter reason, every mined turn was dropped
   * and `turnsDropped` counts them. With the tombstone reason, the
   * session's current material was already mined and yielded nothing
   * accepted; `miningOutcome` carries the recorded breakdown as evidence.
   */
  readonly skipped?: {
    readonly reason:
      | typeof EXTRACT_PREFILTER_SKIP_REASON
      | typeof EXTRACT_MINING_TOMBSTONE_SKIP_REASON;
    /** Present with the pre-filter reason: how many turns were dropped. */
    readonly turnsDropped?: number;
    /** Present with the tombstone reason: the recorded zero-yield breakdown. */
    readonly miningOutcome?: SessionMiningOutcome;
  };
  /** Present only when the use is not `off` and a request failed. */
  readonly decisionModel?: { readonly degraded: DecisionDegradeReason };
  /**
   * Present only when the plan handed out an envelope but could not record
   * its survey: a barren commit answering it then needs the relayed
   * `surveyed_turns_hash` to write its tombstone.
   */
  readonly surveyRecordFailure?: string;
}

export interface PrefilteredPlanOptions {
  readonly now: Date;
  readonly decisionModel: ResolvedDecisionModelConfig | null | undefined;
  /** Injected provider (tests). */
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The operator's `token_impact` ledger opt-in. */
  readonly tokenImpactEnabled?: boolean;
  /**
   * Bypass the mining tombstone gate for this ONE plan call - the re-mine
   * escape for "I removed the downstream item and want it re-proposed",
   * since removing a preference does not change a session's turns and so
   * never lifts its tombstone on its own. The ledger is still read and
   * still fails closed: force ignores a matching entry, never a corrupt
   * file, and it changes nothing else about the plan.
   */
  readonly force?: boolean;
  /**
   * Name a survey-record failure by its store and errno code only, never
   * by the raised message, which carries an absolute host path. Set by
   * surfaces that answer a caller below local reach.
   */
  readonly closeHostErrors?: boolean;
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
 * The tombstone gate, run on every plan this module returns and always
 * before any decision-model work, so a barren session costs no requests
 * here and none downstream either. A hit suppresses the whole plan: no
 * envelope, no turns, the recorded breakdown as evidence - shaped exactly
 * like the pre-filter's own skip, so there is one "no envelope, and why"
 * channel. A session the ledger cannot verify (corrupt file, unknown
 * schema) throws by the read's contract rather than passing as eligible -
 * `force` bypasses the HIT, never the read, so the refusal still names a
 * broken ledger to an operator who asked for a re-mine.
 *
 * The plan's `turnsMined` is both the gate's hash input and what a pass
 * leaves untouched; only a hit empties it. The token-impact ledger is not
 * consulted here: the avoided spend is the caller's mining inference, not
 * a decision-model one this module would otherwise have made.
 */
function miningTombstoneGate(
  vault: string,
  plan: SignalExtractionPlan,
  force: boolean,
): PrefilteredSignalExtractionPlan {
  const entry = readMiningTombstone(vault, plan.sessionId, plan.turnsMined);
  if (entry === null || force) return plan;
  return Object.freeze({
    ...plan,
    turnsMined: Object.freeze([]),
    llmStep: null,
    skipped: Object.freeze({
      reason: EXTRACT_MINING_TOMBSTONE_SKIP_REASON,
      miningOutcome: Object.freeze({ ...entry.outcome }),
    }),
  });
}

/**
 * The plan phase with the optional pre-filter. With the use `off` this is
 * exactly {@link planExtractSignals}, unless the session is tombstoned -
 * the mining ledger's zero-yield gate runs on every configuration, before
 * the pre-filter, because the spend it prevents is the caller's mining
 * round trip and not only this module's requests. Refusals
 * ({@link ExtractSignalsError}) are thrown as there, before the gate.
 * `opts.force` lifts the gate for this one call. A plan that hands out an
 * envelope records its surveyed-turns hash as a pending survey - the one
 * write of the plan phase - so a commit that relays no hash can still
 * withhold a tombstone over turns the plan never offered.
 */
export async function planExtractSignalsPrefiltered(
  vault: string,
  sessionId: string,
  opts: PrefilteredPlanOptions,
): Promise<PrefilteredSignalExtractionPlan> {
  const plan = await planPrefilteredEnvelope(vault, sessionId, opts);
  // A plan that hands out an envelope records what it surveyed, so the
  // commit that answers it without relaying the hash can still tell
  // whether the session changed in between (session-mining-surveys.ts).
  // A failed record never fails the plan - the plan is still right - and
  // is named so the caller knows the commit will need the relay.
  if (plan.llmStep === null) return plan;
  try {
    recordMiningSurvey(vault, plan.sessionId, plan.surveyedTurnsHash, opts.now);
    return plan;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return Object.freeze({
      ...plan,
      surveyRecordFailure: opts.closeHostErrors === true ? closedSurveyFailure(err) : raw,
    });
  }
}

async function planPrefilteredEnvelope(
  vault: string,
  sessionId: string,
  opts: PrefilteredPlanOptions,
): Promise<PrefilteredSignalExtractionPlan> {
  const cfg = opts.decisionModel;
  const force = opts.force === true;
  if (!extractPrefilterActive(cfg)) {
    return miningTombstoneGate(
      vault,
      planExtractSignals(vault, sessionId, { now: opts.now }),
      force,
    );
  }
  const provider = opts.provider ?? makeDecisionProvider(cfg, opts.env ?? process.env, vault);
  if (provider === null) {
    return miningTombstoneGate(
      vault,
      planExtractSignals(vault, sessionId, { now: opts.now }),
      force,
    );
  }

  const planned = planExtractSignals(vault, sessionId, { now: opts.now, sourceTurnHint: true });
  const suppressed = miningTombstoneGate(vault, planned, force);
  if (suppressed.skipped !== undefined) return suppressed;
  // The gate passed the plan through unchanged, so `full` is the base
  // plan and its envelope is the non-null one the rest of this function
  // has always read.
  const full = planned;
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

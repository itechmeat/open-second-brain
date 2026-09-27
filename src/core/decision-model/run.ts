/**
 * `runDecision` - the one entry point every use goes through.
 *
 * Uses never call `provider.decide` directly. This function owns the
 * rules that must hold for all of them:
 *
 *   - `off` (the default, and every configuration that is not `active`):
 *     no state is built, nothing is sent, nothing is recorded.
 *   - the daily cost gate, checked before the state is built;
 *   - the state builder's own budget refusal;
 *   - the request itself, with the configured timeout;
 *   - exactly one `decision_model_call` record per attempted request, with
 *     the outcome (`ok` or the degrade reason);
 *   - the per-route latency component for MCP route metrics.
 *
 * It never throws. A degrade is returned as a typed reason and the use
 * applies its own failure policy (context uses fall back to the
 * deterministic result; advisory uses omit their field).
 */

import {
  DecisionProviderError,
  type DecisionDegradeReason,
  type DecisionModelMode,
  type DecisionModelUse,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionResponse,
  type DecisionState,
} from "./contract.ts";
import { decisionModelModeFor, type ResolvedDecisionModelConfig } from "./config.ts";
import { noteDecisionLatency } from "./latency.ts";
import { makeDecisionProvider } from "./provider.ts";
import { emitDecisionModelCall, todaySpendUsd } from "./record.ts";

/** What a use's state builder hands back. */
export type BuiltDecisionState<C> =
  | {
      readonly kind: "ok";
      readonly state: DecisionState;
      readonly candidateCount: number;
      /** Use-private context (e.g. the mask mapping); never sent or recorded. */
      readonly context: C;
    }
  /** The minimum useful state does not fit `max_state_tokens`. */
  | { readonly kind: "budget" }
  /** Nothing to decide (e.g. every candidate is private); no request, no record. */
  | { readonly kind: "empty" };

export type DecisionRunResult<C> =
  | { readonly status: "off" }
  | { readonly status: "empty"; readonly mode: Exclude<DecisionModelMode, "off"> }
  | {
      readonly status: "ok";
      readonly mode: Exclude<DecisionModelMode, "off">;
      readonly response: DecisionResponse;
      readonly context: C;
      readonly latencyMs: number;
    }
  | {
      readonly status: "degraded";
      readonly mode: Exclude<DecisionModelMode, "off">;
      readonly reason: DecisionDegradeReason;
    };

export interface RunDecisionOptions<C> {
  readonly config: ResolvedDecisionModelConfig | null | undefined;
  /** Injected provider (tests). Defaults to the configured adapter. */
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Overrides `decision_model_timeout_ms` (e.g. a hook sub-budget). */
  readonly timeoutMs?: number;
  /** Forces a mode (the eval gate measures `enforce` regardless of config). */
  readonly modeOverride?: Exclude<DecisionModelMode, "off">;
  readonly now?: () => Date;
  /**
   * Per-use evaluation identifiers for the record, given the reply (null
   * on a degrade). Identifiers and numbers only, never text.
   */
  readonly recordDetails?: (
    response: DecisionResponse | null,
    context: C | null,
  ) => Readonly<Record<string, unknown>> | undefined;
}

export async function runDecision<C>(
  use: DecisionModelUse,
  buildState: () => BuiltDecisionState<C>,
  questions: (
    built: Extract<BuiltDecisionState<C>, { kind: "ok" }>,
  ) => Readonly<Record<string, DecisionQuestion>>,
  opts: RunDecisionOptions<C>,
): Promise<DecisionRunResult<C>> {
  const cfg = opts.config;
  const configured = decisionModelModeFor(cfg, use);
  if (configured === "off" || cfg === null || cfg === undefined) return { status: "off" };
  const mode = opts.modeOverride ?? configured;
  const provider = opts.provider ?? makeDecisionProvider(cfg, opts.env ?? process.env);
  if (provider === null) return { status: "off" };
  const now = opts.now ?? (() => new Date());

  const record = (
    outcome: string,
    extra: {
      readonly questionCount?: number;
      readonly candidateCount?: number;
      readonly response?: DecisionResponse;
      readonly context?: C;
      readonly latencyMs?: number;
    } = {},
  ): void => {
    let details: Readonly<Record<string, unknown>> | undefined;
    try {
      details = opts.recordDetails?.(extra.response ?? null, extra.context ?? null);
    } catch {
      details = undefined;
    }
    emitDecisionModelCall(cfg.vault, {
      use,
      mode,
      provider: provider.name,
      model: extra.response?.model ?? provider.model,
      calibrated: extra.response?.calibrated ?? provider.calibrated,
      questionCount: extra.questionCount ?? 0,
      candidateCount: extra.candidateCount ?? 0,
      ...(extra.response !== undefined ? { usage: extra.response.usage } : {}),
      inputPriceUsdPerMtok: cfg.inputPriceUsdPerMtok,
      latencyMs: extra.latencyMs ?? 0,
      outcome,
      ...(extra.response?.stateHash !== undefined ? { stateHash: extra.response.stateHash } : {}),
      ...(details !== undefined ? { details } : {}),
      createdAt: now().toISOString(),
    });
  };

  // Daily cost gate, before any state is built. A gate of 0 is off.
  if (cfg.dailyCostGateUsd > 0 && cfg.vault !== null) {
    let spend: number;
    try {
      spend = todaySpendUsd(cfg.vault, now());
    } catch {
      spend = Number.POSITIVE_INFINITY;
    }
    if (spend >= cfg.dailyCostGateUsd) {
      record("cost_gate");
      return { status: "degraded", mode, reason: "cost_gate" };
    }
  }

  let built: BuiltDecisionState<C>;
  try {
    built = buildState();
  } catch {
    built = { kind: "budget" };
  }
  if (built.kind === "empty") return { status: "empty", mode };
  if (built.kind === "budget") {
    record("budget");
    return { status: "degraded", mode, reason: "budget" };
  }

  const qs = questions(built);
  const questionCount = Object.keys(qs).length;
  const started = Date.now();
  let response: DecisionResponse;
  try {
    response = await provider.decide(
      { use, state: built.state, questions: qs },
      { timeoutMs: opts.timeoutMs ?? cfg.timeoutMs },
    );
  } catch (e) {
    const latencyMs = Date.now() - started;
    noteDecisionLatency(latencyMs);
    const reason: DecisionDegradeReason = e instanceof DecisionProviderError ? e.reason : "network";
    record(reason, {
      questionCount,
      candidateCount: built.candidateCount,
      context: built.context,
      latencyMs,
    });
    return { status: "degraded", mode, reason };
  }
  const latencyMs = Date.now() - started;
  noteDecisionLatency(latencyMs);
  record("ok", {
    questionCount,
    candidateCount: built.candidateCount,
    response,
    context: built.context,
    latencyMs,
  });
  return { status: "ok", mode, response, context: built.context, latencyMs };
}

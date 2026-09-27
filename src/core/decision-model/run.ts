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
import { estimateTokens } from "./state.ts";

/** Estimated cost of requests in flight in this process, per vault. */
const IN_FLIGHT_USD = new Map<string, number>();

function inFlightUsd(vault: string): number {
  return IN_FLIGHT_USD.get(vault) ?? 0;
}

/** Reserve an estimate until the request settles; returns the release. */
function reserveInFlight(vault: string | null, usd: number): () => void {
  if (vault === null || usd <= 0) return () => undefined;
  IN_FLIGHT_USD.set(vault, inFlightUsd(vault) + usd);
  return () => {
    const left = inFlightUsd(vault) - usd;
    if (left > 1e-12) IN_FLIGHT_USD.set(vault, left);
    else IN_FLIGHT_USD.delete(vault);
  };
}

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
      ...(cfg.outputPriceUsdPerMtok !== undefined && cfg.outputPriceUsdPerMtok !== null
        ? { outputPriceUsdPerMtok: cfg.outputPriceUsdPerMtok }
        : {}),
      latencyMs: extra.latencyMs ?? 0,
      outcome,
      ...(extra.response?.stateHash !== undefined ? { stateHash: extra.response.stateHash } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(cfg.recordOrigin !== undefined ? { origin: cfg.recordOrigin } : {}),
      createdAt: now().toISOString(),
    });
  };

  // Daily cost gate, before any state is built. A gate of 0 is off. The
  // check counts requests still in flight in this process, and the new
  // request's estimate is reserved in the same synchronous step (no await
  // between the check, the build and the reservation), so concurrent
  // requests cannot all pass against the same recorded spend. Separate
  // processes still share only the recorded spend, so the gate is a
  // soft limit that can be passed by the requests in flight elsewhere.
  const gated = cfg.dailyCostGateUsd > 0 && cfg.vault !== null;
  if (gated) {
    let spend: number;
    try {
      spend = todaySpendUsd(cfg.vault!, now()) + inFlightUsd(cfg.vault!);
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

  const ready: Extract<BuiltDecisionState<C>, { kind: "ok" }> = built;
  const qs = questions(ready);
  const questionCount = Object.keys(qs).length;
  const reservation =
    gated && cfg.inputPriceUsdPerMtok !== null
      ? (estimateTokens({ state: ready.state, questions: qs }) * cfg.inputPriceUsdPerMtok) /
        1_000_000
      : 0;
  const send = async (): Promise<DecisionRunResult<C>> => {
    const started = Date.now();
    let response: DecisionResponse;
    try {
      response = await provider.decide(
        { use, state: ready.state, questions: qs },
        { timeoutMs: opts.timeoutMs ?? cfg.timeoutMs },
      );
    } catch (e) {
      const latencyMs = Date.now() - started;
      noteDecisionLatency(latencyMs);
      const reason: DecisionDegradeReason =
        e instanceof DecisionProviderError ? e.reason : "network";
      record(reason, {
        questionCount,
        candidateCount: ready.candidateCount,
        context: ready.context,
        latencyMs,
      });
      return { status: "degraded", mode, reason };
    }
    const latencyMs = Date.now() - started;
    noteDecisionLatency(latencyMs);
    record("ok", {
      questionCount,
      candidateCount: ready.candidateCount,
      response,
      context: ready.context,
      latencyMs,
    });
    return { status: "ok", mode, response, context: ready.context, latencyMs };
  };
  const release = reserveInFlight(gated ? cfg.vault : null, reservation);
  try {
    return await send();
  } finally {
    release();
  }
}

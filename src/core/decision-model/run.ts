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
 *   - the request itself, over the configured provider chain in order:
 *     an entry that is not configured is skipped, a connection error or
 *     timeout falls through to the next entry, and the whole chain
 *     shares the caller's one timeout budget (each attempt gets an even
 *     slice of what remains, so a dead first server can never stretch
 *     the call);
 *   - exactly one `decision_model_call` record per attempted request,
 *     each naming the provider and model that attempted or answered it;
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
import {
  decisionModelModeFor,
  resolvedProviderEntries,
  type ResolvedDecisionModelConfig,
} from "./config.ts";
import type { ResolvedDecisionProvider } from "./config-types.ts";
import { noteDecisionLatency } from "./latency.ts";
import { makeEntryDecisionProvider } from "./provider.ts";
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
  /**
   * Injected provider (tests): replaces the whole chain with this one
   * adapter. Defaults to the configured chain, first entry first.
   */
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Vault whose custody store backs a `$secret:NAME` key value at the use
   * site. Absent, the key value is read from `env` exactly as before the
   * resolver routing existed.
   */
  readonly secretsVault?: string | null;
  /** Overrides `decision_model_timeout_ms` (e.g. a hook sub-budget). */
  readonly timeoutMs?: number;
  /**
   * The caller's cancellation (the search's composite hybrid deadline).
   * Handed to the provider, whose transport stops the request when it
   * aborts; the run then degrades and records it like any cut request.
   */
  readonly signal?: AbortSignal;
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

/** One attempt of the chain: an adapter plus the mode it answers under. */
interface ChainAttempt {
  readonly adapter: DecisionProvider;
  readonly entry: ResolvedDecisionProvider;
  readonly mode: Exclude<DecisionModelMode, "off">;
}

/** The chain options `buildChain` reads; a subset of {@link RunDecisionOptions}. */
interface ChainOptions {
  readonly provider?: DecisionProvider;
  readonly modeOverride?: Exclude<DecisionModelMode, "off">;
}

/**
 * The chain of attempts for one call, in configured order. An entry the
 * factory cannot build (no endpoint, a missing key) is skipped: it is
 * not configured, exactly as the resolver's status rules say. An
 * injected provider (tests) is the whole chain.
 */
function buildChain(
  cfg: ResolvedDecisionModelConfig,
  use: DecisionModelUse,
  mode: Exclude<DecisionModelMode, "off">,
  opts: ChainOptions,
  env: Readonly<Record<string, string | undefined>>,
  secretsVault: string | null | undefined,
): ReadonlyArray<ChainAttempt> {
  if (opts.provider !== undefined) {
    const entry = resolvedProviderEntries(cfg)[0];
    if (entry === undefined) return [];
    return [{ adapter: opts.provider, entry, mode }];
  }
  const attempts: ChainAttempt[] = [];
  for (const [index, entry] of resolvedProviderEntries(cfg).entries()) {
    const adapter = makeEntryDecisionProvider(
      entry,
      { allowInsecureHttp: cfg.allowInsecureHttp, timeoutMs: cfg.timeoutMs },
      env,
      secretsVault,
    );
    if (adapter === null) continue;
    // The first entry answers for the config as written: the top-level
    // modes are its held modes, and a caller that overrode them (the
    // eval gate forces enforce) means it for the primary. A later entry
    // is judged by its own thresholds - a fallback model without tuned
    // thresholds answers as shadow even when the primary enforces. A
    // held mode is never off (off-ness is the global config's decision);
    // anything but enforce is shadow.
    const held = opts.modeOverride ?? (index === 0 ? cfg.uses[use] : (entry.uses[use] ?? "shadow"));
    attempts.push({ adapter, entry, mode: held === "enforce" ? "enforce" : "shadow" });
  }
  return attempts;
}

/** The degrade reasons that mean "this route could not answer": fall through. */
function isFailoverReason(reason: DecisionDegradeReason): boolean {
  return reason === "network" || reason === "timeout";
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
  const env = opts.env ?? process.env;
  const chain = buildChain(cfg, use, mode, opts, env, opts.secretsVault);
  if (chain.length === 0 || chain[0] === undefined) return { status: "off" };
  const primary = chain[0];
  const now = opts.now ?? (() => new Date());

  const record = (
    attempt: ChainAttempt,
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
      mode: attempt.mode,
      provider: attempt.adapter.name,
      model: extra.response?.model ?? attempt.adapter.model,
      calibrated: extra.response?.calibrated ?? attempt.adapter.calibrated,
      questionCount: extra.questionCount ?? 0,
      candidateCount: extra.candidateCount ?? 0,
      ...(extra.response !== undefined ? { usage: extra.response.usage } : {}),
      inputPriceUsdPerMtok: attempt.entry.inputPriceUsdPerMtok,
      ...(attempt.entry.outputPriceUsdPerMtok !== undefined &&
      attempt.entry.outputPriceUsdPerMtok !== null
        ? { outputPriceUsdPerMtok: attempt.entry.outputPriceUsdPerMtok }
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
  // The estimate uses the FIRST entry's price; a fallback attempt is
  // judged by its own price only in its own record.
  const gated = cfg.dailyCostGateUsd > 0 && cfg.vault !== null;
  if (gated) {
    let spend: number;
    try {
      spend = todaySpendUsd(cfg.vault!, now()) + inFlightUsd(cfg.vault!);
    } catch {
      spend = Number.POSITIVE_INFINITY;
    }
    if (spend >= cfg.dailyCostGateUsd) {
      record(primary, "cost_gate");
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
    record(primary, "budget");
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

  // The whole chain shares the caller's one budget (`timeout_ms`, or the
  // hook sub-budget): each attempt gets an even slice of what remains, so
  // a dead first server can never stretch the call past the budget, and
  // the last entry always keeps a real slice to answer in.
  const budgetMs = opts.timeoutMs ?? cfg.timeoutMs;
  const send = async (): Promise<DecisionRunResult<C>> => {
    const deadline = Date.now() + budgetMs;
    let last: {
      readonly reason: DecisionDegradeReason;
      readonly mode: Exclude<DecisionModelMode, "off">;
    } | null = null;
    for (const [index, attempt] of chain.entries()) {
      const remaining = chain.length - index;
      const slice = Math.max(1, Math.floor((deadline - Date.now()) / remaining));
      const started = Date.now();
      let response: DecisionResponse;
      try {
        // eslint-disable-next-line no-await-in-loop -- the fallback is sequential by design: an attempt must settle before the next starts
        response = await attempt.adapter.decide(
          { use, state: ready.state, questions: qs },
          {
            timeoutMs: slice,
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          },
        );
      } catch (e) {
        const latencyMs = Date.now() - started;
        noteDecisionLatency(latencyMs);
        const reason: DecisionDegradeReason =
          e instanceof DecisionProviderError ? e.reason : "network";
        record(attempt, reason, {
          questionCount,
          candidateCount: ready.candidateCount,
          context: ready.context,
          latencyMs,
        });
        // Only a route that could not answer falls through; an HTTP or
        // reply-shape failure is the endpoint's answer about THIS
        // request, and retrying it elsewhere would multiply the same
        // refusal.
        if (!isFailoverReason(reason)) {
          return { status: "degraded", mode: attempt.mode, reason };
        }
        last = { reason, mode: attempt.mode };
        continue;
      }
      const latencyMs = Date.now() - started;
      noteDecisionLatency(latencyMs);
      record(attempt, "ok", {
        questionCount,
        candidateCount: ready.candidateCount,
        response,
        context: ready.context,
        latencyMs,
      });
      return { status: "ok", mode: attempt.mode, response, context: ready.context, latencyMs };
    }
    return {
      status: "degraded",
      mode: last?.mode ?? mode,
      reason: last?.reason ?? "network",
    };
  };
  const release = reserveInFlight(gated ? cfg.vault : null, reservation);
  try {
    return await send();
  } finally {
    release();
  }
}

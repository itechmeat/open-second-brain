/**
 * The live embedding-provider probe of `o2b search check`, and the closed
 * vocabulary it answers in (wiring-what-exists, unit E1).
 *
 * The probe itself is not new: `indexCheck` has always built the
 * configured provider and asked it for one vector through
 * `EmbeddingProvider.ping` - the cheap form, a single-item batch with the
 * retry loop switched off. What was new is that its answer had nowhere to
 * live. It was folded into `providerReachable: boolean | null`, which has
 * two truth values and three questions to answer, so the two states that
 * do not fit shared the one that did:
 *
 *   - a provider that ANSWERED and refused, and a provider that never
 *     answered at all, were both `false`. The first is a fault; the second
 *     is a measurement that did not complete, and reporting it as a fault
 *     is the mirror of reporting it as a pass.
 *   - "nothing is configured" and "the probe was not run" were both
 *     `null`, which reads as absence for a configuration the operator
 *     never wrote AND for one they wrote and asked not to test.
 *
 * So the outcome is a vocabulary of five, and every arm below is reachable:
 * `not-configured` (there is nothing to ask), `reachable`, `unreachable`
 * (the provider answered, and the answer was a refusal), `timed-out` (no
 * answer arrived inside a budget) and `skipped` (the caller asked for no
 * network call). Only `unreachable` is a fault. `timed-out` and `skipped`
 * are the two ways of saying "I could not find out", kept apart because
 * one of them is a measurement that failed and the other is a measurement
 * nobody asked for.
 *
 * A timeout reaches this module by two routes and both mean the same
 * thing: the provider's own per-request budget (`embedding_timeout_ms`)
 * elapsing, which `ping` reports through {@link PingFailure.timedOut}, and
 * this module's outer budget elapsing, which no provider can report
 * because it is imposed from outside. `withTimeout` rejects on the second,
 * so the rejection is built here as a private sentinel rather than left as
 * a bare `Error` whose message a caller would have to pattern-match.
 *
 * A LEAF of the search layer, in the sense `import-cycles.test.ts`
 * polices: this module names the provider CONTRACT and the timeout
 * utility, never the module that constructs a provider nor the aggregate
 * that collects the search types - the report type in `types.ts` names the
 * state below, so an edge back would close a loop. That is why
 * {@link probeProvider} takes a factory rather than a provider: it keeps
 * every way of not reaching an endpoint - including a provider that
 * refuses to construct - classified in one place, without importing the
 * builder.
 */

import { withTimeout } from "./with-timeout.ts";
import type { EmbeddingProvider, PingResult } from "./embeddings/contract.ts";

/**
 * What one pre-flight probe concluded. `notConfigured`, `timedOut` and
 * `skipped` are first-class arms rather than shades of failure: none of
 * them has found the provider broken, and rendering any of them as if it
 * had would be an invented fact.
 */
export const PROVIDER_PROBE = Object.freeze({
  notConfigured: "not-configured",
  reachable: "reachable",
  unreachable: "unreachable",
  timedOut: "timed-out",
  skipped: "skipped",
} as const);

export type ProviderProbeState = (typeof PROVIDER_PROBE)[keyof typeof PROVIDER_PROBE];

/** Membership list for {@link isProviderProbeState}. */
export const PROVIDER_PROBE_STATES: ReadonlyArray<ProviderProbeState> = Object.freeze([
  PROVIDER_PROBE.notConfigured,
  PROVIDER_PROBE.reachable,
  PROVIDER_PROBE.unreachable,
  PROVIDER_PROBE.timedOut,
  PROVIDER_PROBE.skipped,
]);

/**
 * Whether `value` is a probe state this build understands. Takes
 * `unknown` because the value arrives from a `--json` payload a caller
 * parsed, or from a report a different release wrote.
 */
export function isProviderProbeState(value: unknown): value is ProviderProbeState {
  return (
    typeof value === "string" && (PROVIDER_PROBE_STATES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * How long one probe may take before it is abandoned as incomplete. Five
 * seconds is the budget `indexCheck` has always spent; it is named here so
 * the value, the message that quotes it and the tests read the same
 * constant.
 */
export const PROVIDER_PROBE_BUDGET_MS = 5_000;

/** One probe's verdict, and the sentence behind it when there is one. */
export interface ProviderProbeOutcome {
  readonly state: ProviderProbeState;
  /** Why, in the provider's own words. `null` on the states with no reason to give. */
  readonly reason: string | null;
}

/** The `not-configured` arm: no provider was built, so no reason was heard. */
export const PROVIDER_PROBE_NOT_CONFIGURED: ProviderProbeOutcome = Object.freeze({
  state: PROVIDER_PROBE.notConfigured,
  reason: null,
});

/**
 * The `skipped` arm. The reason states what did NOT happen rather than a
 * verdict, so a reader cannot mistake it for one; the flag that produces
 * it is named by the CLI that owns the flag, not from here.
 */
export const PROVIDER_PROBE_SKIPPED: ProviderProbeOutcome = Object.freeze({
  state: PROVIDER_PROBE.skipped,
  reason: "the live provider probe was not requested, so nothing was asked of the provider",
});

/** The outer budget elapsing. Private, so no caller pattern-matches a message. */
class ProbeBudgetElapsed extends Error {
  constructor(readonly budgetMs: number) {
    super(`no answer within the ${budgetMs} ms pre-flight probe budget`);
    this.name = "ProbeBudgetElapsed";
  }
}

/**
 * What one completed `ping` means. Pure, and separate from the call that
 * produced it, so the mapping is assertable without a socket.
 */
export function classifyPing(result: PingResult): ProviderProbeOutcome {
  if (result.ok) return Object.freeze({ state: PROVIDER_PROBE.reachable, reason: null });
  // A provider that answered with a refusal is a fault; a provider whose
  // own request budget elapsed answered nothing at all.
  return Object.freeze({
    state: result.timedOut === true ? PROVIDER_PROBE.timedOut : PROVIDER_PROBE.unreachable,
    reason: result.reason,
  });
}

/**
 * Ask the configured provider for one vector, under a bounded budget.
 *
 * Never throws: a provider that cannot even be constructed is a
 * configuration this build cannot reach, which is reported as `unreachable`
 * with the construction error as its reason - the operator gets the
 * sentence either way, and the caller gets a verdict either way.
 */
export async function probeProvider(
  buildProvider: () => EmbeddingProvider,
  opts?: { readonly budgetMs?: number },
): Promise<ProviderProbeOutcome> {
  const budgetMs = opts?.budgetMs ?? PROVIDER_PROBE_BUDGET_MS;
  try {
    const provider = buildProvider();
    const result = await withTimeout(provider.ping(), budgetMs, (ms) => new ProbeBudgetElapsed(ms));
    return classifyPing(result);
  } catch (e) {
    if (e instanceof ProbeBudgetElapsed) {
      return Object.freeze({ state: PROVIDER_PROBE.timedOut, reason: e.message });
    }
    return Object.freeze({
      state: PROVIDER_PROBE.unreachable,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

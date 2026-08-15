/**
 * The four ways agent memory fails, scored against shipped code
 * (t_72d6eb23).
 *
 * The existing bench measures whether a query finds the right note. That
 * is one failure mode out of several, and not the one operators complain
 * about. This module adds the scorers for the rest, and it is deliberately
 * narrow: it decides what a decision MEANS, and the phase pipeline decides
 * when to make one. Everything here is pure.
 *
 * ## 1. Proactive know-to-ask, with a false-fire term
 *
 * Measured by driving `decideRecallInject`
 * (`src/core/brain/recall-inject.ts`) - an explicitly I/O-free
 * function with an injectable retriever - over a controlled vault. Two
 * things must be said plainly about what this measures.
 *
 * First, WHAT SHIPS IS NOT WHAT IS MEASURED. `decideRecallInject` sits
 * behind `recall_inject_enabled`, which defaults OFF (`src/core/config.ts`).
 * Calling the function directly is what makes the metric possible at all,
 * but the number it produces describes a CAPABILITY the code has, not
 * behaviour a default install delivers. The always-on injection path
 * (`hooks/active-inject.ts`) makes no relevance decision whatsoever - it
 * injects `Brain/active.md` wholesale every session - so there is nothing
 * there to score.
 *
 * Second, THE PRESSURE IS ON THE FLOOR, NOT THE GATE.
 * `evaluateSurfacingGate` (`src/core/search/surfacing-gate.ts`) fails open
 * by design: every non-empty, non-duplicate, non-slash, non-shell prompt
 * retrieves, so its false-fire rate is ~1 by construction and scoring it
 * would be theatre. The only
 * discriminating bound in the decision core is
 * `RECALL_INJECT_CONFIDENCE_FLOOR`, so that is where the anti-gaming term
 * bites: {@link scoreProactiveRecall} counts a false fire exactly as
 * heavily as a silent miss, which is what makes a strategy that always
 * injects score strictly worse than one that abstains correctly.
 *
 * A measured caveat that belongs with the number: through the shipped
 * keyword lane the top-ranked result's score is pinned at the configured
 * keyword weight (0.65 by default), because `rankResults` min-max
 * normalizes the lane. `below_floor` is therefore unreachable via the
 * default retriever today, and the abstain that actually fires on an
 * off-topic prompt is `no_matches`. The floor is still the term under
 * pressure - it is simply not, today, the term that fires.
 *
 * ## 2. Write-back fidelity
 *
 * Graded on the shipped write path with no model call, because there is no
 * other kind: the server never calls a model on any write path by stated
 * architectural contract (`src/mcp/brain/context-tools.ts`, "The calling
 * agent generates; the Brain never does"). So there is no extractor seam
 * to inject - the question a fidelity fixture actually answers is what
 * structured intake stands in for a real agent's distillation, and whether
 * the PROVENANCE survives segmentation, insertion and dedup intact.
 *
 * ## 3. Cross-source isolation
 *
 * Asserted on delivered pack CONTENTS, never on `hiddenByOwnerScope`: that
 * counter is surfaced only under `warn`, where it counts items that WERE
 * delivered, and under `fail` it is deliberately unreported. And it is run
 * under a fixture that sets `integrity.owner_scope_delivery: fail`,
 * because the shipped default is `off` - with no scope evaluated, nothing
 * can be violated and a zero-gate would be vacuous.
 *
 * ## 4. Injected tokens
 *
 * Not a failure mode but a cost, so it stays in the report's cost family
 * rather than here - see `context_cost.avg_injected_tokens`, which the
 * pipeline computes with {@link estimateTokens} and nothing else.
 */

import { estimateTokens } from "../brain/text/tokenizer.ts";
import type { RecallInjectDecision, RecallResultSet } from "../brain/recall-inject.ts";
import { resolveSearchConfig, search } from "../search/index.ts";

/**
 * How one proactive-recall decision failed, or nothing when it was right.
 *
 * Three members because three different repairs apply. A silent miss means
 * the retrieval or the floor is too strict; a false fire means the
 * opposite; a fault means the retriever itself broke, which is neither and
 * must never be folded into either - a harness counting its own breakage
 * as a memory failure reports a number about itself.
 */
export const RECALL_FAILURE = Object.freeze({
  /** Memory held the answer and stayed silent. */
  knowToAsk: "know_to_ask",
  /** Memory spoke up when it had nothing worth saying. */
  falseFire: "false_fire",
  /** The decision core reported an error rather than a decision. */
  faulted: "faulted",
} as const);

/** Closed union over {@link RECALL_FAILURE}. */
export type RecallFailure = (typeof RECALL_FAILURE)[keyof typeof RECALL_FAILURE];

/** Membership list; every surface renders its vocabulary from this array. */
export const RECALL_FAILURES: ReadonlyArray<RecallFailure> = Object.freeze([
  RECALL_FAILURE.knowToAsk,
  RECALL_FAILURE.falseFire,
  RECALL_FAILURE.faulted,
]);

/** Narrow a value read back off disk or across a tool boundary. */
export function isRecallFailure(value: unknown): value is RecallFailure {
  return typeof value === "string" && (RECALL_FAILURES as ReadonlyArray<string>).includes(value);
}

/**
 * The retriever the bench hands to `decideRecallInject`: the shipped
 * search pipeline over the disposable fixture vault.
 *
 * Mirrors `defaultRecallRetriever`, which adapts `searchAcrossVaults` the
 * same way; the difference is only which search entry point is wrapped,
 * because a bench vault has no registered recall sources to cross.
 */
export function benchRecallRetriever(
  config: ReturnType<typeof resolveSearchConfig>,
  limit: number,
): (query: string) => Promise<RecallResultSet> {
  return async (query) => {
    const outcome = await search(config, { query, limit });
    return Object.freeze({
      candidates: Object.freeze(
        outcome.results.map((result) =>
          Object.freeze({
            path: result.path,
            title: result.title,
            score: result.score,
            searchType: result.searchType,
            startLine: result.startLine,
            endLine: result.endLine,
          }),
        ),
      ),
      total: outcome.total,
    });
  };
}

/**
 * What one decision costs the score, given what the fixture expected.
 *
 * `null` is a pass. An `error` decision is never charged to either rate:
 * it is the harness failing, and attributing it to memory would make a
 * broken retriever look like a cautious one.
 */
export function classifyRecallDecision(
  expectInject: boolean,
  decision: RecallInjectDecision,
): RecallFailure | null {
  if (decision.kind === "error") return RECALL_FAILURE.faulted;
  if (decision.kind === "inject") return expectInject ? null : RECALL_FAILURE.falseFire;
  return expectInject ? RECALL_FAILURE.knowToAsk : null;
}

/** The two proactive-recall rates over a set of classified decisions. */
export interface ProactiveRecallScore {
  readonly decisions: number;
  readonly know_to_ask_failure_rate: number;
  readonly false_fire_rate: number;
  readonly faults: number;
}

/**
 * Score a run of classified decisions.
 *
 * Both rates are denominated in DECISIONS, not in their own expectation
 * class, and that is the anti-gaming term. Per-class denominators would
 * let a strategy that always injects post a know-to-ask rate of 0 and hide
 * its false fires in a rate nobody reads; sharing one denominator means
 * every false fire displaces a pass, so the always-inject strategy is
 * strictly worse than one that abstains correctly whenever the fixture
 * contains a single prompt memory should stay quiet about.
 */
export function scoreProactiveRecall(
  failures: ReadonlyArray<RecallFailure | null>,
): ProactiveRecallScore {
  const decisions = failures.length;
  const count = (kind: RecallFailure): number =>
    failures.filter((failure) => failure === kind).length;
  return Object.freeze({
    decisions,
    know_to_ask_failure_rate: rate(count(RECALL_FAILURE.knowToAsk), decisions),
    false_fire_rate: rate(count(RECALL_FAILURE.falseFire), decisions),
    faults: count(RECALL_FAILURE.faulted),
  });
}

/**
 * The forbidden ids a pack actually delivered.
 *
 * Deliberately reads the delivered CONTENTS rather than a counter: the one
 * counter that exists (`hiddenByOwnerScope`) is reported only under `warn`,
 * where its meaning is inverted, and is withheld under `fail` on purpose.
 * A zero-gate has to look at what came back.
 */
export function isolationViolations(
  deliveredIds: ReadonlyArray<string>,
  forbiddenIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return Object.freeze(forbiddenIds.filter((id) => deliveredIds.includes(id)));
}

/**
 * The single token estimator this suite is allowed to use.
 *
 * Re-exported by name so the bench has exactly one import site to point at
 * and `tests/core/bench/token-estimator.test.ts` has exactly one thing to
 * assert. Five mutually disagreeing estimators exist in this repo
 * (`ceil(utf8_bytes/4)`, `ceil(utf16_len/4)`, a word count, an inline
 * `ceil(chars/4)` the bench used to carry, and a ledger over integers a
 * caller supplied); the bench converges on {@link estimateTokens} because
 * it is the one the Brain-side accounting already uses everywhere and the
 * only one that documents its own heuristic.
 */
export function injectedTokens(injected: string): number {
  return estimateTokens(injected);
}

function rate(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 1000) / 1000 : 0;
}

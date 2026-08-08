/**
 * The explain envelope (what-the-index-already-knew, task F).
 *
 * Every gated search builds two compact-reference receipts - the
 * retrieval decision trace and the memory trust assessment - and until
 * this unit no surface serialized either: they were reachable only from a
 * test. This module is the single definition of how those receipts reach
 * a caller, so the CLI `--json` payload and the MCP response name the
 * same keys with the same bodies.
 *
 * Two rules the surfaces inherit by using it:
 *
 *   - Off means absent. With the explain flag unset the envelope is
 *     empty, so the response bytes are identical to the pre-change ones -
 *     never a null placeholder.
 *   - A check that could not run says so, and says which check. The
 *     receipts exist only when the retrieval trust gate is engaged and a
 *     cross-vault union never merges them, so asking for them without
 *     them returns `retrieval_trace_unavailable` carrying whichever of
 *     those two situations actually applies - never an unexplained
 *     silence, and never the wrong explanation.
 *
 * The receipt bodies are already snake_cased by their builders
 * (src/core/brain/trust/retrieval-receipts.ts), so this is a key
 * projection and not a re-serialization.
 */

import type { SearchOutcome } from "./types.ts";

/** Config key that engages the retrieval trust gate. */
export const TRUST_GATE_CONFIG_KEY = "search_trust_gate_enabled";

/** Environment variable equivalent of {@link TRUST_GATE_CONFIG_KEY}. */
export const TRUST_GATE_ENV_KEY = "OPEN_SECOND_BRAIN_SEARCH_TRUST_GATE";

/**
 * Why an explain request carries no trace, and the exit that produces
 * one. The receipts are a by-product of the retrieval trust gate: with
 * the gate off there is no evaluated / excluded set to report.
 */
export const RETRIEVAL_TRACE_UNAVAILABLE =
  `no retrieval decision trace: the retrieval trust gate is off. ` +
  `Enable it with ${TRUST_GATE_CONFIG_KEY}: true in the config, or ${TRUST_GATE_ENV_KEY}=1.`;

/**
 * The cross-vault union's own reason. A union outcome is merged from one
 * search per origin and the receipts are per-origin: they reference
 * document and chunk ids that are only meaningful inside the store that
 * issued them, so merging them would produce ambiguous references. The
 * gate state is therefore NOT what is being reported here, and saying it
 * was would be a false diagnosis.
 */
export const RETRIEVAL_TRACE_NOT_MERGED =
  `no retrieval decision trace: a cross-vault union merges one search per origin and the ` +
  `per-origin receipts reference ids that are local to their own store. ` +
  `Run the query against a single vault to see its trace.`;

/**
 * Both situations at once. The gate is named first because it is the one
 * that has to change either way, and the union is named because changing
 * it alone still yields nothing - reporting only one of the two would
 * send the operator to an exit that does not produce a trace.
 */
export const RETRIEVAL_TRACE_UNAVAILABLE_AND_NOT_MERGED =
  `no retrieval decision trace: the retrieval trust gate is off, and a cross-vault union ` +
  `would not merge the per-origin receipts even with it on. ` +
  `Enable ${TRUST_GATE_CONFIG_KEY}: true (or ${TRUST_GATE_ENV_KEY}=1) and query a single vault.`;

/** Response key carrying the retrieval decision trace. */
export const RETRIEVAL_DECISION_TRACE_KEY = "retrieval_decision_trace";

/** Response key carrying the memory trust assessment. */
export const MEMORY_TRUST_ASSESSMENT_KEY = "memory_trust_assessment";

/** Response key carrying the reason there is no trace to show. */
export const RETRIEVAL_TRACE_UNAVAILABLE_KEY = "retrieval_trace_unavailable";

/**
 * What a surface asks the envelope for. `crossVault` is not derivable
 * from the outcome - a union and a single-vault search with the gate off
 * are both receipt-less - and the two cases have different exits, so the
 * caller that knows states it.
 */
export interface ExplainRequest {
  readonly explain: boolean;
  /** True when this outcome came from a cross-vault union. */
  readonly crossVault: boolean;
  /**
   * The resolved `recall.retrievalTrustGateEnabled`. Neither this nor
   * `crossVault` is derivable from a receipt-less outcome, and naming the
   * wrong one of the two sends the operator to an exit that produces
   * nothing - so the caller, which knows both, states both.
   */
  readonly trustGateEnabled: boolean;
}

/** The default for every surface: opt-in, single vault. */
export const EXPLAIN_OFF: ExplainRequest = Object.freeze({
  explain: false,
  crossVault: false,
  trustGateEnabled: false,
});

/**
 * Why this outcome carries no receipts, as the caller's own situation
 * explains it.
 */
export function retrievalTraceUnavailableReason(
  crossVault: boolean,
  trustGateEnabled: boolean,
): string {
  if (crossVault && !trustGateEnabled) return RETRIEVAL_TRACE_UNAVAILABLE_AND_NOT_MERGED;
  if (crossVault) return RETRIEVAL_TRACE_NOT_MERGED;
  return RETRIEVAL_TRACE_UNAVAILABLE;
}

/**
 * The explain keys for one outcome, ready to spread into a response
 * object. `explain: false` yields an empty object - the caller's payload
 * is then byte-identical to the pre-change one.
 */
export function explainEnvelope(
  outcome: SearchOutcome,
  request: ExplainRequest,
): Record<string, unknown> {
  if (!request.explain) return {};
  const trace = outcome.retrievalDecisionTrace;
  const assessment = outcome.memoryTrustAssessment;
  if (trace === undefined || assessment === undefined) {
    return {
      [RETRIEVAL_TRACE_UNAVAILABLE_KEY]: retrievalTraceUnavailableReason(
        request.crossVault,
        request.trustGateEnabled,
      ),
    };
  }
  return {
    [RETRIEVAL_DECISION_TRACE_KEY]: trace,
    [MEMORY_TRUST_ASSESSMENT_KEY]: assessment,
  };
}

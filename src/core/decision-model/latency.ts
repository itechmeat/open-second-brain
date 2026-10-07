/**
 * Per-route decision latency, for the optional `decision_ms` component of
 * `mcp_route_latency` records.
 *
 * The store lives in `src/core/route-scope.ts`, which also carries the
 * write-stage timings; this module keeps the decision-only surface that
 * `runDecision` and its tests use.
 */

import { createRouteScope } from "../route-scope.ts";

export { noteDecisionLatency } from "../route-scope.ts";

export interface DecisionLatencyScope {
  /** Run `fn` with this scope open. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Total decision time, or undefined when no decision request ran. */
  decisionMs(): number | undefined;
}

export function createDecisionLatencyScope(): DecisionLatencyScope {
  const scope = createRouteScope();
  return { run: (fn) => scope.run(fn), decisionMs: () => scope.decisionMs() };
}

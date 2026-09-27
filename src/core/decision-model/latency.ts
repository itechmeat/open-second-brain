/**
 * Per-route decision latency, for the optional `decision_ms` component of
 * `mcp_route_latency` records.
 *
 * The MCP server opens a scope around a tool call only while route
 * metrics are enabled; `runDecision` adds each request's wall time to the
 * open scope, if any. With no scope open this is a no-op, so the feature
 * adds nothing to a call that is not being measured.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface LatencyScope {
  totalMs: number;
  calls: number;
}

const storage = new AsyncLocalStorage<LatencyScope>();

/** Add one decision request's duration to the open scope, if any. */
export function noteDecisionLatency(ms: number): void {
  const scope = storage.getStore();
  if (scope === undefined || !Number.isFinite(ms)) return;
  scope.totalMs += Math.max(0, ms);
  scope.calls += 1;
}

export interface DecisionLatencyScope {
  /** Run `fn` with this scope open. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Total decision time, or undefined when no decision request ran. */
  decisionMs(): number | undefined;
}

export function createDecisionLatencyScope(): DecisionLatencyScope {
  const scope: LatencyScope = { totalMs: 0, calls: 0 };
  return {
    run: (fn) => storage.run(scope, fn),
    decisionMs: () => (scope.calls > 0 ? Math.round(scope.totalMs) : undefined),
  };
}

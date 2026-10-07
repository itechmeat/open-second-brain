/**
 * One per-call route scope for the optional `decision_ms` and `stages`
 * components of `mcp_route_latency` records.
 *
 * The MCP server opens a scope around a tool call only while route metrics
 * are enabled. `runDecision` adds each request's wall time to the open
 * scope, and the write tools wrap their stages in `timeStageSync` or
 * `timeStage`. With no scope open every helper is one `getStore()` that
 * returns `undefined`, so the feature adds nothing to a call that is not
 * being measured. Stage names are a closed allowlist: free text never
 * reaches a continuity record.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export const ROUTE_STAGE = Object.freeze({
  validate: "validate",
  idempotencyLookup: "idempotency_lookup",
  nearDuplicateLookup: "near_duplicate_lookup",
  documentWrite: "document_write",
  idempotencyRemember: "idempotency_remember",
  logAppend: "log_append",
  preferenceWrite: "preference_write",
  writeReceipt: "write_receipt",
  lint: "lint",
} as const);

export type RouteStageName = (typeof ROUTE_STAGE)[keyof typeof ROUTE_STAGE];

export const ROUTE_STAGE_NAMES: ReadonlySet<RouteStageName> = new Set(Object.values(ROUTE_STAGE));

export function isRouteStageName(value: unknown): value is RouteStageName {
  return typeof value === "string" && ROUTE_STAGE_NAMES.has(value as RouteStageName);
}

export interface RouteStageTiming {
  readonly name: RouteStageName;
  readonly ms: number;
}

interface RouteScopeState {
  decisionTotalMs: number;
  decisionCalls: number;
  readonly stageMs: Map<RouteStageName, number>;
}

const storage = new AsyncLocalStorage<RouteScopeState>();

function noteStage(scope: RouteScopeState, name: RouteStageName, startedAt: number): void {
  const elapsed = Math.max(0, performance.now() - startedAt);
  scope.stageMs.set(name, (scope.stageMs.get(name) ?? 0) + elapsed);
}

/** Time a synchronous stage in the open scope; rethrows whatever `fn` throws. */
export function timeStageSync<T>(name: RouteStageName, fn: () => T): T {
  const scope = storage.getStore();
  if (scope === undefined) return fn();
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    noteStage(scope, name, startedAt);
  }
}

/** Time an asynchronous stage in the open scope; rethrows whatever `fn` rejects with. */
export async function timeStage<T>(name: RouteStageName, fn: () => Promise<T>): Promise<T> {
  const scope = storage.getStore();
  if (scope === undefined) return fn();
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    noteStage(scope, name, startedAt);
  }
}

/** Add one decision request's duration to the open scope, if any. */
export function noteDecisionLatency(ms: number): void {
  const scope = storage.getStore();
  if (scope === undefined || !Number.isFinite(ms)) return;
  scope.decisionTotalMs += Math.max(0, ms);
  scope.decisionCalls += 1;
}

export interface RouteScope {
  /** Run `fn` with this scope open. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Total decision time in whole ms, or undefined when no decision request ran. */
  decisionMs(): number | undefined;
  /** Stage times summed per name in first-seen order at 0.1 ms, or undefined when none ran. */
  stages(): ReadonlyArray<RouteStageTiming> | undefined;
}

export function createRouteScope(): RouteScope {
  const scope: RouteScopeState = { decisionTotalMs: 0, decisionCalls: 0, stageMs: new Map() };
  return {
    run: (fn) => storage.run(scope, fn),
    decisionMs: () => (scope.decisionCalls > 0 ? Math.round(scope.decisionTotalMs) : undefined),
    stages: () =>
      scope.stageMs.size === 0
        ? undefined
        : [...scope.stageMs].map(([name, ms]) => ({ name, ms: Math.round(ms * 10) / 10 })),
  };
}

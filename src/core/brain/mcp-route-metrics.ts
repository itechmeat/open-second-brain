/**
 * Route-level latency metrics for MCP tools (context-pack-economics-
 * observability suite).
 *
 * Open Second Brain already records recall latency (`recall_telemetry`)
 * and inbound generation latency (`generation_report`), but neither
 * captures the operational latency of an individual MCP tool as an
 * operator experiences it - "which endpoint is blocking the agent
 * turn?". This surface records one `mcp_route_latency` continuity record
 * per `tools/call` (and per CLI bridge `callTool`) so slow surfaces can
 * be identified by route rather than only by aggregate benchmark or
 * generation-report numbers.
 *
 * Gated + fail-open by construction: the emit routes through
 * `emitGatedTelemetry`, so with the gate off (config key
 * `mcp_route_metrics_enabled` unset/false) no payload is built and no
 * write happens, and a throwing write never fails the tool call it is
 * measuring.
 *
 * Payload-safe by construction: only the tool name, MCP scope, status,
 * duration, and the SORTED SET OF ARGUMENT KEY NAMES land on disk.
 * Argument key names are the tool's own JSON-Schema property names
 * (`query`, `max_tokens`, ...), never operator-supplied values - so no
 * prompt, note body, or preference id is ever recorded. Optional
 * `decision_ms` and `stages` carry timings only; stage names come from the
 * closed `ROUTE_STAGE_NAMES` allowlist. The whole payload still passes
 * `safeContinuityPayload` redaction.
 */

import { emitGatedTelemetry } from "./continuity/emit.ts";
import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import {
  isRouteStageName,
  ROUTE_STAGE_NAMES,
  type RouteStageName,
  type RouteStageTiming,
} from "../route-scope.ts";

export type McpRouteStatus = "ok" | "error";

export interface McpRouteLatencyInput {
  readonly createdAt?: string;
  /** MCP tool name, e.g. `brain_search`. */
  readonly tool: string;
  /** Advertised tool scope of the process that served the call (`full`/`writer`/`catalog`). */
  readonly scope?: string;
  readonly status: McpRouteStatus;
  readonly durationMs: number;
  /**
   * Argument KEY NAMES supplied on the call (schema property names only).
   * Recorded as a sorted, de-duplicated set to identify call variants
   * without ever persisting argument values.
   */
  readonly argKeys?: ReadonlyArray<string>;
  /**
   * Wall time spent in decision-model requests inside this call (issue
   * #213). Absent when the call made none, so a record from an install
   * without the feature is unchanged.
   */
  readonly decisionMs?: number;
  /**
   * Write-stage timings noted inside this call. Only names in
   * `ROUTE_STAGE_NAMES` with a finite, non-negative value are persisted;
   * absent or empty leaves the record unchanged.
   */
  readonly stages?: ReadonlyArray<RouteStageTiming>;
}

export interface McpRouteLatencyFilter {
  readonly tool?: string;
  readonly status?: McpRouteStatus;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

/** Per-route latency roll-up (nearest-rank percentiles over the route's durations). */
export interface McpRouteStats {
  readonly tool: string;
  readonly count: number;
  readonly error_count: number;
  readonly min_ms: number;
  readonly max_ms: number;
  readonly avg_ms: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  /** Per-stage roll-up in `ROUTE_STAGE` order; absent when no record of the route carried stages. */
  readonly stages?: ReadonlyArray<McpRouteStageStats>;
}

/** One write stage's roll-up within a route (nearest-rank p95). */
export interface McpRouteStageStats {
  readonly name: RouteStageName;
  readonly count: number;
  readonly avg_ms: number;
  readonly p95_ms: number;
}

export interface McpRouteLatencySummary {
  readonly total: number;
  readonly error_count: number;
  readonly by_status: Partial<Record<McpRouteStatus, number>>;
  /** One entry per tool, slowest-first by p95 latency. */
  readonly routes: ReadonlyArray<McpRouteStats>;
}

export function isMcpRouteStatus(value: unknown): value is McpRouteStatus {
  return value === "ok" || value === "error";
}

/**
 * Emit one `mcp_route_latency` continuity record, gated and fail-open.
 *
 * `gate` doubles as the opt-in switch: with `false | null | undefined`
 * the build thunk never runs (no payload, no write) and the function
 * returns `null`. A throwing build is swallowed and reported as `null`
 * so route metrics can never fail the tool call being measured.
 */
export function emitMcpRouteLatency<G>(
  vault: string,
  input: McpRouteLatencyInput,
  gate: G | false | null | undefined,
): ContinuityRecord | null {
  return emitGatedTelemetry(gate, () => {
    const tool = input.tool;
    if (typeof tool !== "string" || tool.length === 0) {
      throw new TypeError("mcp route latency: tool must be a non-empty string");
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const argKeys = normalizeArgKeys(input.argKeys);
    // Guard against non-finite durations: Math.round/Math.max pass NaN/Infinity
    // through, and JSON.stringify silently turns them into null, corrupting the
    // persisted record. Not reachable from the server seam today (always a
    // performance.now() diff) but hardened for future misuse.
    const safeDurationMs = Number.isFinite(input.durationMs) ? input.durationMs : 0;
    const payload: Record<string, unknown> = {
      tool,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      status: input.status,
      duration_ms: Math.max(0, Math.round(safeDurationMs)),
      ...(argKeys.length > 0 ? { arg_keys: argKeys } : {}),
      ...(input.decisionMs !== undefined && Number.isFinite(input.decisionMs)
        ? { decision_ms: Math.max(0, Math.round(input.decisionMs)) }
        : {}),
    };
    const stages = normalizeStages(input.stages);
    if (stages.length > 0) payload["stages"] = stages;
    return appendContinuityRecord(vault, {
      kind: "mcp_route_latency",
      createdAt,
      sourceRefs: [],
      payload,
    });
  });
}

function normalizeArgKeys(raw: ReadonlyArray<string> | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const key of raw) {
    if (typeof key === "string" && key.length > 0) seen.add(key);
  }
  return [...seen].toSorted();
}

/**
 * Keep allowlisted stage names with finite, non-negative values, sum
 * repeated names in first-seen order and round to 0.1 ms. A name outside
 * `ROUTE_STAGE_NAMES` is dropped here, at the only write site, so free
 * text never reaches the continuity record.
 */
function normalizeStages(
  raw: ReadonlyArray<RouteStageTiming> | undefined,
): Array<{ name: RouteStageName; ms: number }> {
  if (!Array.isArray(raw)) return [];
  const summed = new Map<RouteStageName, number>();
  for (const stage of raw as ReadonlyArray<unknown>) {
    if (typeof stage !== "object" || stage === null) continue;
    const { name, ms } = stage as { name?: unknown; ms?: unknown };
    if (!isRouteStageName(name) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      continue;
    }
    summed.set(name, (summed.get(name) ?? 0) + ms);
  }
  return [...summed].map(([name, ms]) => ({ name, ms: Math.round(ms * 10) / 10 }));
}

/** List `mcp_route_latency` records newest-first, after applying filters. */
export function listMcpRouteLatency(
  vault: string,
  filter: McpRouteLatencyFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "mcp_route_latency",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => matchesFilter(record, filter));
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

/** Aggregate route latency into per-tool percentile stats, slowest-first. */
export function summarizeMcpRouteLatency(
  vault: string,
  filter: McpRouteLatencyFilter = {},
): McpRouteLatencySummary {
  // Summary always spans the full filtered window - `limit` bounds the
  // list operation only, never the roll-up.
  const { limit: _limit, ...summaryFilter } = filter;
  const records = listMcpRouteLatency(vault, summaryFilter);
  const byStatus: Partial<Record<McpRouteStatus, number>> = {};
  const durationsByTool = new Map<string, number[]>();
  const errorsByTool = new Map<string, number>();
  const stagesByTool = new Map<string, Map<RouteStageName, number[]>>();
  let errorCount = 0;

  for (const record of records) {
    const payload = record.payload;
    const tool = typeof payload["tool"] === "string" ? payload["tool"] : "unknown";
    const status = payload["status"];
    if (isMcpRouteStatus(status)) {
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (status === "error") {
        errorCount += 1;
        errorsByTool.set(tool, (errorsByTool.get(tool) ?? 0) + 1);
      }
    }
    const duration = payload["duration_ms"];
    if (typeof duration === "number" && Number.isFinite(duration)) {
      const bucket = durationsByTool.get(tool);
      if (bucket) bucket.push(duration);
      else durationsByTool.set(tool, [duration]);
    }
    collectStageTimes(payload["stages"], tool, stagesByTool);
  }

  const routes: McpRouteStats[] = [];
  for (const [tool, durations] of durationsByTool) {
    const sorted = durations.toSorted((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    const stages = summarizeStages(stagesByTool.get(tool));
    routes.push({
      tool,
      count: sorted.length,
      error_count: errorsByTool.get(tool) ?? 0,
      min_ms: sorted[0] ?? 0,
      max_ms: sorted[sorted.length - 1] ?? 0,
      avg_ms: sorted.length > 0 ? Math.round((sum / sorted.length) * 10) / 10 : 0,
      p50_ms: percentile(sorted, 50),
      p95_ms: percentile(sorted, 95),
      p99_ms: percentile(sorted, 99),
      ...(stages.length > 0 ? { stages } : {}),
    });
  }
  // Slowest surface first, tie-broken by name for a stable order.
  routes.sort((a, b) => b.p95_ms - a.p95_ms || a.tool.localeCompare(b.tool));

  return Object.freeze({
    total: records.length,
    error_count: errorCount,
    by_status: Object.freeze(byStatus),
    routes: Object.freeze(routes),
  });
}

/**
 * Gather one persisted record's stage times under its tool. Re-checks the
 * allowlist and the value guard on read, so a hand-edited record never
 * puts a free-text name into the summary.
 */
function collectStageTimes(
  raw: unknown,
  tool: string,
  stagesByTool: Map<string, Map<RouteStageName, number[]>>,
): void {
  if (!Array.isArray(raw)) return;
  for (const stage of raw as ReadonlyArray<unknown>) {
    if (typeof stage !== "object" || stage === null) continue;
    const { name, ms } = stage as { name?: unknown; ms?: unknown };
    if (!isRouteStageName(name) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      continue;
    }
    let byStage = stagesByTool.get(tool);
    if (byStage === undefined) {
      byStage = new Map();
      stagesByTool.set(tool, byStage);
    }
    const bucket = byStage.get(name);
    if (bucket) bucket.push(ms);
    else byStage.set(name, [ms]);
  }
}

function summarizeStages(
  byStage: ReadonlyMap<RouteStageName, ReadonlyArray<number>> | undefined,
): McpRouteStageStats[] {
  if (byStage === undefined) return [];
  const stats: McpRouteStageStats[] = [];
  for (const name of ROUTE_STAGE_NAMES) {
    const times = byStage.get(name);
    if (times === undefined || times.length === 0) continue;
    const sorted = times.toSorted((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    stats.push({
      name,
      count: sorted.length,
      avg_ms: Math.round((sum / sorted.length) * 10) / 10,
      p95_ms: percentile(sorted, 95),
    });
  }
  return stats;
}

/** Nearest-rank percentile over an ascending-sorted array; 0 for empty input. */
function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? 0;
}

function matchesFilter(record: ContinuityRecord, filter: McpRouteLatencyFilter): boolean {
  const payload = record.payload;
  if (filter.tool !== undefined && payload["tool"] !== filter.tool) return false;
  if (filter.status !== undefined && payload["status"] !== filter.status) return false;
  return true;
}

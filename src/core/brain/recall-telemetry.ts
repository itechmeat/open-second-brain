import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";

export type RecallTelemetryMode = "search" | "context_pack" | "pre_compress";
export type RecallTelemetryStatus = "ok" | "empty" | "error" | "timeout";

export interface RecallTelemetryArtifactInput {
  readonly id: string;
  readonly path?: string;
  readonly score?: number;
}

export interface RecallTelemetryInput {
  readonly createdAt?: string;
  readonly host: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly mode: RecallTelemetryMode;
  readonly status: RecallTelemetryStatus;
  readonly durationMs: number;
  readonly resultCount: number;
  readonly topArtifacts?: ReadonlyArray<RecallTelemetryArtifactInput>;
  readonly gaps?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RecallTelemetryOptions {
  readonly host: string;
  readonly createdAt?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RecallTelemetryFilter {
  readonly mode?: RecallTelemetryMode;
  readonly status?: RecallTelemetryStatus;
  readonly host?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface RecallTelemetrySummary {
  readonly total: number;
  readonly by_mode: Partial<Record<RecallTelemetryMode, number>>;
  readonly by_status: Partial<Record<RecallTelemetryStatus, number>>;
  readonly total_results: number;
  readonly empty_runs: number;
  readonly gap_counts: Record<string, number>;
}

export function emitRecallTelemetry(vault: string, input: RecallTelemetryInput): ContinuityRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const topArtifacts = [...(input.topArtifacts ?? [])];
  const gaps = [...new Set((input.gaps ?? []).map((gap) => gap.trim()).filter(Boolean))];
  return appendContinuityRecord(vault, {
    kind: "recall_telemetry",
    createdAt,
    sourceRefs: topArtifacts.map((artifact) => ({
      id: artifact.id,
      ...(artifact.path ? { path: artifact.path } : {}),
    })),
    payload: {
      host: input.host,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      mode: input.mode,
      status: input.status,
      duration_ms: Math.max(0, Math.floor(input.durationMs)),
      result_count: Math.max(0, Math.floor(input.resultCount)),
      top_artifacts: topArtifacts.map((artifact) => ({
        id: artifact.id,
        ...(artifact.path ? { path: artifact.path } : {}),
        ...(artifact.score !== undefined ? { score: artifact.score } : {}),
      })),
      gaps,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
}

export function listRecallTelemetry(
  vault: string,
  filter: RecallTelemetryFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "recall_telemetry",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => matchesTelemetryFilter(record, filter));
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

export function summarizeRecallTelemetry(
  vault: string,
  filter: RecallTelemetryFilter = {},
): RecallTelemetrySummary {
  const records = listRecallTelemetry(vault, filter);
  const byMode: Partial<Record<RecallTelemetryMode, number>> = {};
  const byStatus: Partial<Record<RecallTelemetryStatus, number>> = {};
  const gapCounts: Record<string, number> = {};
  let totalResults = 0;
  let emptyRuns = 0;

  for (const record of records) {
    const mode = record.payload["mode"];
    if (isRecallTelemetryMode(mode)) byMode[mode] = (byMode[mode] ?? 0) + 1;
    const status = record.payload["status"];
    if (isRecallTelemetryStatus(status)) {
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (status === "empty") emptyRuns += 1;
    }
    const resultCount = record.payload["result_count"];
    if (typeof resultCount === "number") totalResults += resultCount;
    const gaps = record.payload["gaps"];
    if (Array.isArray(gaps)) {
      for (const gap of gaps) {
        if (typeof gap !== "string" || gap.length === 0) continue;
        gapCounts[gap] = (gapCounts[gap] ?? 0) + 1;
      }
    }
  }

  return Object.freeze({
    total: records.length,
    by_mode: Object.freeze(byMode),
    by_status: Object.freeze(byStatus),
    total_results: totalResults,
    empty_runs: emptyRuns,
    gap_counts: Object.freeze(gapCounts),
  });
}

export function isRecallTelemetryMode(value: unknown): value is RecallTelemetryMode {
  return value === "search" || value === "context_pack" || value === "pre_compress";
}

export function isRecallTelemetryStatus(value: unknown): value is RecallTelemetryStatus {
  return value === "ok" || value === "empty" || value === "error" || value === "timeout";
}

function matchesTelemetryFilter(record: ContinuityRecord, filter: RecallTelemetryFilter): boolean {
  const payload = record.payload;
  if (filter.mode !== undefined && payload["mode"] !== filter.mode) return false;
  if (filter.status !== undefined && payload["status"] !== filter.status) return false;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  return true;
}

/**
 * Recall-gate telemetry (Workspace Insight Suite, t_65036e02).
 *
 * Records every automatic-recall gate decision as a `gate_telemetry`
 * continuity record so the skip/retrieve behaviour becomes observable
 * and tunable. Privacy invariant: the RAW PROMPT is never stored -
 * continuity records sync with the vault, so only a SHA-256 prefix
 * (enough for duplicate analysis) and the prompt length land on disk.
 *
 * Default OFF: the `brain_recall_gate` handler emits only when the
 * `recall_gate_telemetry` config key is on, keeping the gate's
 * pure-diagnostic contract byte-identical otherwise. Reuses the
 * continuity-record kernel rather than inventing a new sink.
 */

import { createHash } from "node:crypto";

import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";

export interface GateTelemetryInput {
  readonly host: string;
  readonly prompt: string;
  readonly retrieve: boolean;
  readonly reason: string;
  readonly sessionId?: string;
  readonly createdAt?: string;
}

export interface GateTelemetryFilter {
  readonly host?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface GateTelemetrySummary {
  readonly total: number;
  readonly retrieved: number;
  readonly skipped: number;
  readonly by_reason: Record<string, number>;
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

/** Record one gate decision. Never stores the raw prompt. */
export function emitGateTelemetry(vault: string, input: GateTelemetryInput): ContinuityRecord {
  return appendContinuityRecord(vault, {
    kind: "gate_telemetry",
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceRefs: [],
    payload: {
      host: input.host,
      ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
      decision: input.retrieve ? "retrieve" : "skip",
      reason: input.reason,
      prompt_hash: hashPrompt(input.prompt),
      prompt_chars: input.prompt.length,
    },
  });
}

/** Gate decisions, newest first. */
export function listGateTelemetry(
  vault: string,
  filter: GateTelemetryFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "gate_telemetry",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => filter.host === undefined || record.payload["host"] === filter.host);
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

/** Aggregate decisions by outcome and reason. */
export function summarizeGateTelemetry(
  vault: string,
  filter: GateTelemetryFilter = {},
): GateTelemetrySummary {
  const records = listGateTelemetry(vault, filter);
  let retrieved = 0;
  const byReason: Record<string, number> = {};
  for (const record of records) {
    if (record.payload["decision"] === "retrieve") retrieved += 1;
    const reason = record.payload["reason"];
    if (typeof reason === "string" && reason !== "") {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
  }
  return Object.freeze({
    total: records.length,
    retrieved,
    skipped: records.length - retrieved,
    by_reason: Object.freeze(byReason),
  });
}

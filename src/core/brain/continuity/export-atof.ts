/**
 * ATOF renderer (Memory Observability Suite, t_51959aeb).
 *
 * Renders normalized continuity records as an ATOF (Agent Trajectory
 * Observability Format) JSONL event stream. Mapping decisions and the
 * spec revision matched are documented in
 * docs/brainstorm/memory-observability-suite/atof-atif-mapping.md:
 *
 *   - `recall_telemetry` is the one duration-bearing kind and becomes a
 *     `retriever` scope pair; the start timestamp is SYNTHESIZED as
 *     `createdAt - duration_ms` and flagged `o2b.synthetic_start`;
 *   - `gate_telemetry` maps to a `guardrail` mark, `context_receipt`
 *     to a `retriever` mark, every other kind to a `custom` mark with
 *     `category_profile.subtype: "o2b.<kind>"`;
 *   - `parent_uuid` stays null - the memory layer does not know the
 *     host agent's call tree; correlation rides the namespaced `o2b`
 *     object (session_id / turn_id / record id);
 *   - uuids derive deterministically from the record id so re-exports
 *     are reproducible and diffable.
 *
 * Read-only over the read-model; `private` records never reach this
 * module (the read-model drops them by default).
 */

import { createHash } from "node:crypto";

import type { NormalizedContinuityRecord } from "./read-model.ts";

export const ATOF_VERSION = "0.1";

interface AtofEvent {
  readonly kind: "scope" | "mark";
  readonly atof_version: string;
  readonly uuid: string;
  readonly timestamp: string;
  readonly name: string;
  readonly category?: string;
  readonly scope_category?: "start" | "end";
  readonly attributes?: ReadonlyArray<string>;
  readonly category_profile?: Readonly<Record<string, unknown>>;
  readonly parent_uuid?: null;
  readonly o2b?: Readonly<Record<string, unknown>>;
}

/** Render records as ATOF JSONL lines (one JSON object per line). */
export function renderAtofEvents(
  records: ReadonlyArray<NormalizedContinuityRecord>,
): ReadonlyArray<string> {
  const events: AtofEvent[] = [];
  for (const record of records) {
    if (record.kind === "recall_telemetry") {
      events.push(...recallScopePair(record));
    } else {
      events.push(markEvent(record));
    }
  }
  return Object.freeze(events.map((event) => JSON.stringify(event)));
}

function recallScopePair(record: NormalizedContinuityRecord): AtofEvent[] {
  const uuid = deterministicUuid(record.id);
  const endMs = Date.parse(record.createdAt);
  const duration = readNonNegativeNumber(record.payload["duration_ms"]) ?? 0;
  const start = Number.isFinite(endMs)
    ? new Date(endMs - duration).toISOString()
    : record.createdAt;
  const end = Number.isFinite(endMs) ? new Date(endMs).toISOString() : record.createdAt;
  const name = `recall:${typeof record.payload["mode"] === "string" ? record.payload["mode"] : "unknown"}`;
  const base = {
    atof_version: ATOF_VERSION,
    uuid,
    name,
    category: "retriever",
    attributes: Object.freeze(["o2b.synthetic_start"]),
    parent_uuid: null,
    o2b: correlation(record),
  } as const;
  return [
    { kind: "scope", scope_category: "start", timestamp: start, ...base },
    { kind: "scope", scope_category: "end", timestamp: end, ...base },
  ];
}

function markEvent(record: NormalizedContinuityRecord): AtofEvent {
  const category = markCategory(record.kind);
  return {
    kind: "mark",
    atof_version: ATOF_VERSION,
    uuid: deterministicUuid(record.id),
    timestamp: record.createdAt,
    name: `o2b:${record.kind}`,
    category,
    ...(category === "custom"
      ? { category_profile: Object.freeze({ subtype: `o2b.${record.kind}` }) }
      : {}),
    parent_uuid: null,
    o2b: correlation(record),
  };
}

function markCategory(kind: string): string {
  if (kind === "gate_telemetry") return "guardrail";
  if (kind === "context_receipt") return "retriever";
  return "custom";
}

function correlation(record: NormalizedContinuityRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    record_id: record.id,
    schema: record.schema,
    ...(record.sessionId !== undefined ? { session_id: record.sessionId } : {}),
    ...(record.turnId !== undefined ? { turn_id: record.turnId } : {}),
    payload: record.payload,
  });
}

/** Deterministic uuid-shaped id derived from the record id (reproducible re-exports). */
function deterministicUuid(recordId: string): string {
  const hex = createHash("sha256").update(`o2b-atof:${recordId}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * ATIF renderer (Memory Observability Suite, t_51959aeb).
 *
 * Renders normalized continuity records as ATIF v1.7 trajectories
 * (harbor-framework RFC 0001) - one trajectory document per session.
 * Mapping decisions live in
 * docs/brainstorm/memory-observability-suite/atof-atif-mapping.md:
 *
 *   - `session_turn` records become steps; `role: "user"` maps to
 *     `source: "user"`, everything else to `source: "agent"`;
 *   - memory-layer events (gate decisions, recall telemetry, receipts)
 *     become `source: "system"` steps with `llm_call_count: 0` - the
 *     spec's explicit deterministic-dispatch marker - and the full
 *     payload under `extra.o2b`;
 *   - records without a session id cannot be ordered into a trajectory
 *     and are skipped (the CLI surfaces the skipped count);
 *   - the memory layer itself is the recording agent.
 *
 * Read-only over the read-model; `private` records never reach this
 * module (the read-model drops them by default).
 */

import type { NormalizedContinuityRecord } from "./read-model.ts";

export const ATIF_SCHEMA_VERSION = "ATIF-v1.7";

export interface AtifStep {
  readonly step_id: number;
  readonly source: "system" | "user" | "agent";
  readonly message: string;
  readonly timestamp?: string;
  readonly llm_call_count?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface AtifTrajectory {
  readonly schema_version: string;
  readonly session_id: string;
  readonly agent: { readonly name: string; readonly version: string };
  readonly steps: ReadonlyArray<AtifStep>;
}

export interface AtifRenderOptions {
  readonly agentVersion: string;
}

/** Render one ATIF trajectory per session, ordered by record time. */
export function renderAtifTrajectories(
  records: ReadonlyArray<NormalizedContinuityRecord>,
  opts: AtifRenderOptions,
): ReadonlyArray<AtifTrajectory> {
  const bySession = new Map<string, NormalizedContinuityRecord[]>();
  for (const record of records) {
    if (record.sessionId === undefined) continue;
    const bucket = bySession.get(record.sessionId) ?? [];
    bucket.push(record);
    bySession.set(record.sessionId, bucket);
  }
  const trajectories: AtifTrajectory[] = [];
  for (const sessionId of [...bySession.keys()].toSorted()) {
    const sessionRecords = bySession
      .get(sessionId)!
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    trajectories.push(
      Object.freeze({
        schema_version: ATIF_SCHEMA_VERSION,
        session_id: sessionId,
        agent: Object.freeze({ name: "open-second-brain", version: opts.agentVersion }),
        steps: Object.freeze(sessionRecords.map((record, index) => step(record, index + 1))),
      }),
    );
  }
  return Object.freeze(trajectories);
}

/** Count of records a render would skip (no session id to order by). */
export function countSessionlessRecords(
  records: ReadonlyArray<NormalizedContinuityRecord>,
): number {
  return records.filter((record) => record.sessionId === undefined).length;
}

function step(record: NormalizedContinuityRecord, stepId: number): AtifStep {
  if (record.kind === "session_turn") {
    const role = record.payload["role"];
    const text = record.payload["text"];
    return Object.freeze({
      step_id: stepId,
      source: role === "user" ? ("user" as const) : ("agent" as const),
      message: typeof text === "string" ? text : "",
      timestamp: record.createdAt,
    });
  }
  return Object.freeze({
    step_id: stepId,
    source: "system" as const,
    message: `o2b:${record.kind}`,
    timestamp: record.createdAt,
    // Deterministic dispatch: the memory layer made no LLM call.
    llm_call_count: 0,
    extra: Object.freeze({
      o2b: Object.freeze({
        record_id: record.id,
        schema: record.schema,
        kind: record.kind,
        payload: record.payload,
      }),
    }),
  });
}

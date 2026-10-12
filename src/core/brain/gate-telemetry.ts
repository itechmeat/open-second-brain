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
 *
 * The same handler's second observation lives here too: the typed
 * negative-recall verdict (silence-is-not-an-answer, U2), written as a
 * `negative_recall` record under the SAME opt-in. It is the same
 * surface's telemetry and shares the prompt-hashing invariant, so a
 * separate module would have duplicated both.
 */

import { createHash } from "node:crypto";

import { isSurfacingTier, type SurfacingTier } from "../search/surfacing-key.ts";
import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import { CONTINUITY_TURN_ID_KEY, type ContinuityRecord } from "./continuity/types.ts";
import type { NegativeRecallVerdict } from "./negative-recall.ts";
import type { RecallChannel } from "./recall-telemetry.ts";

export interface GateTelemetryInput {
  readonly host: string;
  readonly prompt: string;
  readonly retrieve: boolean;
  readonly reason: string;
  readonly sessionId?: string;
  /** The caller's turn correlation id, recorded under {@link CONTINUITY_TURN_ID_KEY}. */
  readonly turnId?: string;
  readonly createdAt?: string;
  /**
   * The graded surfacing key (t_107a3249), recorded only when the call
   * carried a measured quality - an unmeasured structural verdict is
   * already described by `decision` and `reason`. Numbers and closed
   * values only; `key` is null exactly where the graded admission key is
   * null: where nothing was measurable, or where a structural outcome
   * (`suppressed`, `explicit`) decided the call without grading the
   * carried measurement.
   */
  readonly surfacing?: {
    readonly key: number | null;
    readonly tier: SurfacingTier;
  };
  /**
   * The transport the decision arrived over, recorded only on MEASURED
   * decisions: the channel calibrates the measured admission, and an
   * unmeasured structural verdict is already described by `decision` and
   * `reason`.
   */
  readonly channel?: RecallChannel;
  /**
   * The adequacy verdict and the caller's advisory decision-model
   * probability, recorded only when the call carried `decision_answerable`
   * and the `answerable` use is not off (issue #213, Part 8). Numbers and
   * closed values only.
   */
  readonly decisionAnswerable?: {
    readonly level: string;
    readonly probability: number;
    readonly disagrees: boolean;
  };
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
  /** Counts by graded admission tier (t_107a3249); measured calls only. */
  readonly by_tier: Record<string, number>;
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
      ...(input.turnId !== undefined ? { [CONTINUITY_TURN_ID_KEY]: input.turnId } : {}),
      decision: input.retrieve ? "retrieve" : "skip",
      reason: input.reason,
      prompt_hash: hashPrompt(input.prompt),
      prompt_chars: input.prompt.length,
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.surfacing !== undefined
        ? { key: input.surfacing.key, tier: input.surfacing.tier }
        : {}),
      ...(input.decisionAnswerable !== undefined
        ? {
            adequacy_level: input.decisionAnswerable.level,
            decision_answerable: {
              probability: input.decisionAnswerable.probability,
              disagrees: input.decisionAnswerable.disagrees,
            },
          }
        : {}),
    },
  });
}

/** One typed negative-recall verdict, as the gate observed it. */
export interface NegativeRecallTelemetryInput {
  readonly prompt: string;
  readonly verdict: NegativeRecallVerdict;
  readonly sessionId?: string;
  readonly createdAt?: string;
}

/**
 * Record one negative-recall verdict (silence-is-not-an-answer, U2).
 *
 * Same sink, same privacy invariant and the same `recall_gate_telemetry`
 * opt-in as {@link emitGateTelemetry} - one config decision governs the
 * whole feature rather than one per surface.
 *
 * The coverage receipt rides along in the reduced form that is safe to
 * replicate: the digest, the counts, the searched roots and the gap.
 * `index_path` is deliberately dropped. It is a host filesystem path,
 * not vault content, and continuity records sync between devices; the
 * digest already binds it, so nothing is lost that an audit needs.
 */
export function emitNegativeRecallTelemetry(
  vault: string,
  input: NegativeRecallTelemetryInput,
): ContinuityRecord {
  const { verdict } = input;
  const coverage = verdict.coverage;
  return appendContinuityRecord(vault, {
    kind: "negative_recall",
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceRefs: [],
    payload: {
      ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
      state: verdict.state,
      complete: verdict.complete,
      ...(verdict.unknown_reason !== undefined ? { unknown_reason: verdict.unknown_reason } : {}),
      reason: verdict.reason,
      ...(coverage !== undefined
        ? {
            coverage_digest: coverage.digest,
            documents: coverage.documents,
            chunks: coverage.chunks,
            schema_version: coverage.schema_version,
            embedding_signature: coverage.embedding_signature,
            last_indexed_at: coverage.last_indexed_at,
            scope: coverage.scope,
            unindexed_roots: coverage.unindexed_roots,
          }
        : {}),
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

/** Aggregate decisions by outcome, reason and graded tier. */
export function summarizeGateTelemetry(
  vault: string,
  filter: GateTelemetryFilter = {},
): GateTelemetrySummary {
  const records = listGateTelemetry(vault, filter);
  let retrieved = 0;
  const byReason: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  for (const record of records) {
    if (record.payload["decision"] === "retrieve") retrieved += 1;
    const reason = record.payload["reason"];
    if (typeof reason === "string" && reason !== "") {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    const tier = record.payload["tier"];
    if (isSurfacingTier(tier)) {
      byTier[tier] = (byTier[tier] ?? 0) + 1;
    }
  }
  return Object.freeze({
    total: records.length,
    retrieved,
    skipped: records.length - retrieved,
    by_reason: Object.freeze(byReason),
    by_tier: Object.freeze(byTier),
  });
}

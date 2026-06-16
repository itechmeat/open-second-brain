/**
 * Per-handoff LLM generation tracing (Hindsight brain-loop ops,
 * t_281c3edc).
 *
 * Open Second Brain's kernel never calls an LLM - the calling agent
 * owns all generation. So tracing cannot wrap an outbound request the
 * kernel makes; instead it is an opt-in INBOUND path: after the agent
 * fulfils a generation handoff (a write-session step, a context-pack
 * consume, or a dream-stage proposal) it optionally reports back the
 * real usage. Open Second Brain stores that as an additive
 * `generation_report` continuity record correlated to the paths and ids
 * it already owns, so memory <-> trace linkage is a `sourceRefs` join
 * the read-model already performs.
 *
 * Honest asymmetry: the local token estimate is always present (derived
 * from the prompt the kernel handed the agent); the agent-reported
 * `usage` block is present only when the inbound report carries it. A
 * missing usage block is normal, not a failure.
 *
 * Payload-safe by construction: the raw prompt is hashed and counted but
 * never stored - only `prompt_hash` (full sha-256 hex) and `prompt_chars`
 * land on disk, and the whole payload still passes `safeContinuityPayload`
 * redaction. The surface is gated by `emitGatedTelemetry` (opt-in,
 * fail-open): with the gate off no payload is built, and a throwing build
 * never fails the primary operation.
 */

import { createHash } from "node:crypto";

import { emitGatedTelemetry } from "./continuity/emit.ts";
import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord, ContinuitySourceRef } from "./continuity/types.ts";
import { estimateTokens } from "./text/tokenizer.ts";

export const GENERATION_HANDOFF_KINDS = ["write_session", "context_pack", "dream_stage"] as const;

export type GenerationHandoffKind = (typeof GENERATION_HANDOFF_KINDS)[number];

export function isGenerationHandoffKind(value: unknown): value is GenerationHandoffKind {
  return (
    typeof value === "string" && (GENERATION_HANDOFF_KINDS as ReadonlyArray<string>).includes(value)
  );
}

/** Agent-reported token usage; every field optional and reported as absent when missing. */
export interface GenerationUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly totalTokens?: number;
}

export interface GenerationReportInput {
  readonly handoff: { readonly kind: GenerationHandoffKind; readonly ref: string };
  readonly agent: string;
  readonly scope?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly finishReason?: string;
  readonly latencyMs?: number;
  /**
   * The exact prompt the kernel handed the agent for this handoff. Used
   * ONLY to derive `prompt_hash`, `prompt_chars`, and the local token
   * estimate - never persisted as raw text.
   */
  readonly prompt: string;
  readonly usage?: GenerationUsage;
  /** Artifact join refs (memory paths, ids) beyond the handoff ref itself. */
  readonly sourceRefs?: ReadonlyArray<ContinuitySourceRef>;
  readonly createdAt?: string;
}

/**
 * Emit a `generation_report` continuity record, gated and fail-open.
 *
 * `gate` doubles as the opt-in switch: with `false | null | undefined`
 * the build thunk never runs (no payload, no hash, no write) and the
 * function returns `null`. A throwing build (e.g. a non-string prompt)
 * is swallowed and reported as `null` so tracing can never fail the
 * primary brain operation.
 */
export function emitGenerationReport<G>(
  vault: string,
  input: GenerationReportInput,
  gate: G | false | null | undefined,
): ContinuityRecord | null {
  return emitGatedTelemetry(gate, () => {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const prompt = input.prompt;
    if (typeof prompt !== "string") {
      throw new TypeError("generation report prompt must be a string");
    }
    const payload: Record<string, unknown> = {
      handoff: { kind: input.handoff.kind, ref: input.handoff.ref },
      agent: input.agent,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.finishReason !== undefined ? { finish_reason: input.finishReason } : {}),
      ...(input.latencyMs !== undefined ? { latency_ms: input.latencyMs } : {}),
      prompt_hash: sha256(prompt),
      prompt_chars: [...prompt].length,
      local_estimate: { input_tokens: estimateTokens(prompt) },
      ...(usagePayload(input.usage) !== undefined ? { usage: usagePayload(input.usage) } : {}),
    };
    return appendContinuityRecord(vault, {
      kind: "generation_report",
      createdAt,
      sourceRefs: buildSourceRefs(input),
      payload,
    });
  });
}

function buildSourceRefs(input: GenerationReportInput): ReadonlyArray<ContinuitySourceRef> {
  const refs: ContinuitySourceRef[] = [{ id: input.handoff.ref, kind: input.handoff.kind }];
  for (const ref of input.sourceRefs ?? []) {
    if (ref.id === input.handoff.ref) continue;
    refs.push(ref);
  }
  return Object.freeze(refs);
}

function usagePayload(usage: GenerationUsage | undefined): Record<string, number> | undefined {
  if (usage === undefined) return undefined;
  const out: Record<string, number> = {};
  if (typeof usage.inputTokens === "number") out["input_tokens"] = usage.inputTokens;
  if (typeof usage.outputTokens === "number") out["output_tokens"] = usage.outputTokens;
  if (typeof usage.cachedTokens === "number") out["cached_tokens"] = usage.cachedTokens;
  if (typeof usage.totalTokens === "number") out["total_tokens"] = usage.totalTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface GenerationReportFilter {
  readonly handoffKind?: GenerationHandoffKind;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

/** List `generation_report` records newest-first, after applying filters. */
export function listGenerationReports(
  vault: string,
  filter: GenerationReportFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "generation_report",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => matchesFilter(record, filter));
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

function matchesFilter(record: ContinuityRecord, filter: GenerationReportFilter): boolean {
  const payload = record.payload;
  const handoff = isPlainObject(payload["handoff"]) ? payload["handoff"] : {};
  if (filter.handoffKind !== undefined && handoff["kind"] !== filter.handoffKind) return false;
  if (filter.agent !== undefined && payload["agent"] !== filter.agent) return false;
  return true;
}

export interface GenerationReportSummary {
  readonly total: number;
  readonly by_handoff_kind: Readonly<Record<string, number>>;
  /** Sum of the always-present local token estimates. */
  readonly local_estimate_tokens: number;
  /** Sum of agent-reported usage where present (absent reports contribute nothing). */
  readonly reported_tokens: {
    readonly input: number;
    readonly output: number;
    readonly cached: number;
    readonly total: number;
  };
  /** How many records carried an agent-reported usage block. */
  readonly reported_count: number;
  /** Memory-path linkage: each source path maps back to the report ids that touched it. */
  readonly by_path: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** Aggregate generation reports: counts, token rollups, and per-path linkage. */
export function summarizeGenerationReports(
  vault: string,
  filter: GenerationReportFilter = {},
): GenerationReportSummary {
  const records = listGenerationReports(vault, filter);
  const byKind: Record<string, number> = {};
  const reported = { input: 0, output: 0, cached: 0, total: 0 };
  const byPath: Record<string, string[]> = {};
  let localEstimate = 0;
  let reportedCount = 0;

  for (const record of records) {
    const payload = record.payload;
    const handoff = isPlainObject(payload["handoff"]) ? payload["handoff"] : {};
    const kind = typeof handoff["kind"] === "string" ? handoff["kind"] : "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;

    const estimate = isPlainObject(payload["local_estimate"]) ? payload["local_estimate"] : {};
    if (typeof estimate["input_tokens"] === "number") localEstimate += estimate["input_tokens"];

    if (isPlainObject(payload["usage"])) {
      reportedCount += 1;
      const usage = payload["usage"];
      reported.input += numberOr0(usage["input_tokens"]);
      reported.output += numberOr0(usage["output_tokens"]);
      reported.cached += numberOr0(usage["cached_tokens"]);
      reported.total += numberOr0(usage["total_tokens"]);
    }

    const seenPaths = new Set<string>();
    for (const ref of record.sourceRefs) {
      if (typeof ref.path !== "string" || ref.path.length === 0) continue;
      if (seenPaths.has(ref.path)) continue; // one record contributes its id once per path
      seenPaths.add(ref.path);
      (byPath[ref.path] ??= []).push(record.id);
    }
  }

  return Object.freeze({
    total: records.length,
    by_handoff_kind: Object.freeze(byKind),
    local_estimate_tokens: localEstimate,
    reported_tokens: Object.freeze(reported),
    reported_count: reportedCount,
    by_path: Object.freeze(byPath),
  });
}

export function getGenerationReport(vault: string, id: string): ContinuityRecord | null {
  return (
    listContinuityRecords(vault, { kind: "generation_report" }).find(
      (record) => record.id === id,
    ) ?? null
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

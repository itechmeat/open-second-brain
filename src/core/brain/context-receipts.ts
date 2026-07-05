import { createHash } from "node:crypto";

import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import type { RecallAdequacyVerdict } from "./recall-adequacy.ts";

export type ContextReceiptTrigger = "context_pack" | "pre_compress";

export interface ContextReceiptOptions {
  readonly host: string;
  readonly trigger: ContextReceiptTrigger;
  readonly createdAt?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface ContextReceiptItemInput {
  readonly id: string;
  readonly path?: string;
  readonly text?: string;
  readonly tokens?: number;
  readonly tier?: string;
  readonly trimmed?: boolean;
  readonly safetyFiltered?: boolean;
  /** Epistemic grounding of the item (ACM): observed | derived | ... */
  readonly epistemic?: string;
  /** `evidenced_by` wikilinks grounding the item. */
  readonly evidenceRefs?: ReadonlyArray<string>;
}

export interface EmitContextReceiptInput {
  readonly options: ContextReceiptOptions;
  readonly items: ReadonlyArray<ContextReceiptItemInput>;
  readonly finalText: string;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
  /**
   * Recall adequacy verdict (t_b8f66fec) for the recall that produced
   * this context. When present it is persisted so the audit trail records
   * whether the surfaced grounding was judged sufficient / weak /
   * insufficient and what action the caller was told to take.
   */
  readonly adequacy?: RecallAdequacyVerdict;
}

/** Flatten a verdict into the snake_cased receipt payload shape. */
export function serializeAdequacy(verdict: RecallAdequacyVerdict): Record<string, unknown> {
  return {
    level: verdict.level,
    action: verdict.action,
    escalate: verdict.escalate,
    result_count: verdict.resultCount,
    top_score: verdict.topScore,
    mean_score: verdict.meanScore,
    reason: verdict.reason,
  };
}

export interface ContextReceiptFilter {
  readonly trigger?: ContextReceiptTrigger;
  readonly host?: string;
  readonly sessionId?: string;
  readonly limit?: number;
}

export interface ContextReceiptSummary {
  readonly id: string;
  readonly created_at: string;
  readonly trigger: ContextReceiptTrigger | null;
  readonly host: string | null;
  readonly session_id?: string;
  readonly turn_id?: string;
  readonly item_count: number | null;
  readonly source_count: number;
  readonly private: boolean;
  readonly redacted: boolean;
  /** Recall adequacy verdict summary, when the receipt recorded one. */
  readonly adequacy?: {
    readonly level: string;
    readonly action: string;
    readonly escalate: boolean;
  };
}

export function emitContextReceipt(
  vault: string,
  input: EmitContextReceiptInput,
): ContinuityRecord {
  const createdAt = input.options.createdAt ?? new Date().toISOString();
  const itemPayloads = input.items.map((item, index) => ({
    id: item.id,
    original_rank: index + 1,
    ...(item.path ? { path: item.path } : {}),
    ...(item.tokens !== undefined ? { tokens: item.tokens } : {}),
    ...(item.tier ? { tier: item.tier } : {}),
    ...(item.trimmed !== undefined ? { trimmed: item.trimmed } : {}),
    ...(item.safetyFiltered !== undefined ? { safety_filtered: item.safetyFiltered } : {}),
    ...(item.epistemic !== undefined ? { epistemic: item.epistemic } : {}),
    ...(item.evidenceRefs && item.evidenceRefs.length > 0
      ? { evidence_refs: [...item.evidenceRefs] }
      : {}),
    ...(item.text ? { text_hash: sha256(item.text) } : {}),
  }));
  const payload: Record<string, unknown> = {
    host: input.options.host,
    trigger: input.options.trigger,
    ...(input.options.sessionId ? { session_id: input.options.sessionId } : {}),
    ...(input.options.turnId ? { turn_id: input.options.turnId } : {}),
    item_count: input.items.length,
    final_text_hash: sha256(input.finalText),
    final_text_chars: [...input.finalText].length,
    items: itemPayloads,
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.adequacy ? { adequacy: serializeAdequacy(input.adequacy) } : {}),
  };
  mergeReceiptExtra(payload, input.extra);
  return appendContinuityRecord(vault, {
    kind: "context_receipt",
    createdAt,
    sourceRefs: input.items.map((item) => ({
      id: item.id,
      ...(item.path ? { path: item.path } : {}),
      ...(item.text ? { hash: sha256(item.text) } : {}),
    })),
    payload,
  });
}

function mergeReceiptExtra(
  payload: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> | undefined,
): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(payload, key)) {
      throw new Error(`context receipt extra key collides with payload field: ${key}`);
    }
    payload[key] = value;
  }
}

export function listContextReceipts(
  vault: string,
  filter: ContextReceiptFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let receipts = listContinuityRecords(vault, {
    kind: "context_receipt",
  }).filter((record) => matchesReceiptFilter(record, filter));
  receipts = receipts.toReversed();
  if (filter.limit !== undefined)
    receipts = receipts.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(receipts);
}

export function getContextReceipt(vault: string, id: string): ContinuityRecord | null {
  return (
    listContinuityRecords(vault, { kind: "context_receipt" }).find((record) => record.id === id) ??
    null
  );
}

export function summarizeContextReceipt(record: ContinuityRecord): ContextReceiptSummary {
  const payload = record.payload;
  return {
    id: record.id,
    created_at: record.createdAt,
    trigger: isContextReceiptTrigger(payload["trigger"]) ? payload["trigger"] : null,
    host: typeof payload["host"] === "string" ? payload["host"] : null,
    ...(typeof payload["session_id"] === "string" ? { session_id: payload["session_id"] } : {}),
    ...(typeof payload["turn_id"] === "string" ? { turn_id: payload["turn_id"] } : {}),
    item_count: typeof payload["item_count"] === "number" ? payload["item_count"] : null,
    source_count: record.sourceRefs.length,
    private: record.private,
    redacted: record.redacted,
    ...adequacySummary(payload["adequacy"]),
  };
}

function adequacySummary(
  raw: unknown,
): { adequacy: { level: string; action: string; escalate: boolean } } | Record<string, never> {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const level = record["level"];
  const action = record["action"];
  if (typeof level !== "string" || typeof action !== "string") return {};
  return { adequacy: { level, action, escalate: record["escalate"] === true } };
}

export function isContextReceiptTrigger(value: unknown): value is ContextReceiptTrigger {
  return value === "context_pack" || value === "pre_compress";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function matchesReceiptFilter(record: ContinuityRecord, filter: ContextReceiptFilter): boolean {
  const payload = record.payload;
  if (filter.trigger !== undefined && payload["trigger"] !== filter.trigger) return false;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  if (filter.sessionId !== undefined && payload["session_id"] !== filter.sessionId) return false;
  return true;
}

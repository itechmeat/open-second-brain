import { sha256Hex } from "../integrity/digest.ts";

import {
  appendContinuityRecord,
  isCanonicalUtcTimestamp,
  listContinuityRecords,
} from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import type { RecallAdequacyVerdict } from "./recall-adequacy.ts";

/**
 * What produced the injected context a receipt accounts for.
 *
 * `context_pack` and `pre_compress` are the two pack builders. Unit H of
 * the context-integrity-gates wave adds `session_inject`: the SessionStart
 * eager layer, which until now emitted context that nothing measured. The
 * vocabulary is closed - a reader switching over it can enumerate every
 * injection surface that exists.
 */
export type ContextReceiptTrigger = "context_pack" | "pre_compress" | "session_inject";

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
  /**
   * UTF-8 byte size of the item. Tokens are an estimate derived from
   * bytes; recording both keeps the estimate auditable against the exact
   * measurement it came from. Optional, so a caller that has no byte
   * figure records exactly what it knows.
   */
  readonly bytes?: number;
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
    ...(item.bytes !== undefined ? { bytes: item.bytes } : {}),
    ...(item.tier ? { tier: item.tier } : {}),
    ...(item.trimmed !== undefined ? { trimmed: item.trimmed } : {}),
    ...(item.safetyFiltered !== undefined ? { safety_filtered: item.safetyFiltered } : {}),
    ...(item.epistemic !== undefined ? { epistemic: item.epistemic } : {}),
    ...(item.evidenceRefs && item.evidenceRefs.length > 0
      ? { evidence_refs: [...item.evidenceRefs] }
      : {}),
    ...(item.text ? { text_hash: sha256Hex(item.text) } : {}),
  }));
  const payload: Record<string, unknown> = {
    host: input.options.host,
    trigger: input.options.trigger,
    ...(input.options.sessionId ? { session_id: input.options.sessionId } : {}),
    ...(input.options.turnId ? { turn_id: input.options.turnId } : {}),
    item_count: input.items.length,
    final_text_hash: sha256Hex(input.finalText),
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
      ...(item.text ? { hash: sha256Hex(item.text) } : {}),
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

// ----- session-scoped fold (context-integrity-gates, Unit I) --------------

/**
 * Default ceiling on how many receipts one fold AGGREGATES.
 *
 * It is a fold bound, not a scan bound, and the docblock said otherwise
 * for exactly as long as nobody measured it. Every receipt matching the
 * window is read into memory first and the bound is applied afterwards,
 * so the read cost is set by `since` / `until` (which do skip whole
 * month shards) and by nothing else. Two consequences worth stating:
 * lowering `maxReceipts` makes the REPORT smaller, never the read; and
 * the observed-use join the MCP surface performs alongside this fold
 * walks the same window again through `observedReuseRates`.
 *
 * A real scan bound was considered and rejected. It would mean reading
 * shards newest-first with an early exit, which changes
 * `listContinuityRecords` for every caller and changes what `truncated`
 * asserts - from "more receipts matched than were folded" to "the read
 * stopped early", which cannot report a total at all. The bound that
 * exists is honest about what it does: exceeding it is REPORTED
 * (`truncated`) rather than silently returning a prefix as if it were
 * the complete answer.
 */
export const CONTEXT_RECEIPT_FOLD_MAX_RECEIPTS = 500;

export interface ContextReceiptFoldFilter {
  readonly trigger?: ContextReceiptTrigger;
  readonly host?: string;
  readonly sessionId?: string;
  /** Inclusive lower bound on `createdAt` (canonical UTC ISO-8601). */
  readonly since?: string;
  /** Inclusive upper bound on `createdAt` (canonical UTC ISO-8601). */
  readonly until?: string;
  /** Fold bound; defaults to {@link CONTEXT_RECEIPT_FOLD_MAX_RECEIPTS}. */
  readonly maxReceipts?: number;
}

/**
 * A window bound was not a canonical UTC timestamp.
 *
 * `since` and `until` are compared LEXICALLY against stored `createdAt`
 * strings, which is correct for the canonical form and meaningless for
 * anything else: `"yesterday"` sorts after every `2026-…` timestamp, so
 * it filters the window down to nothing and the fold reports "no
 * receipts recorded for this filter". Reporting "nothing happened" for
 * malformed input is precisely the failure this wave exists to remove,
 * so a bound that cannot mean what it says is refused instead.
 */
export class ContextReceiptWindowError extends Error {
  /** `since` or `until`. */
  readonly field: string;

  constructor(field: string, value: string) {
    super(
      `context receipt window: ${field} must be a canonical UTC ISO-8601 timestamp ` +
        `(YYYY-MM-DDTHH:MM:SS[.sss]Z with a real calendar date), got ${JSON.stringify(value)}`,
    );
    this.name = "ContextReceiptWindowError";
    this.field = field;
  }
}

/** Throw {@link ContextReceiptWindowError} unless `value` can be compared. */
export function assertContextReceiptWindowBound(field: string, value: string | undefined): void {
  if (value === undefined) return;
  if (!isCanonicalUtcTimestamp(value)) throw new ContextReceiptWindowError(field, value);
}

/** One artifact's injection history across the folded receipts. */
export interface ContextReceiptItemUsage {
  readonly id: string;
  /** Vault-relative path, when the receipts recorded one. */
  readonly path?: string;
  /** How many of the folded receipts injected this artifact. */
  readonly injections: number;
  /** Summed recorded token cost across those injections. */
  readonly tokens: number;
}

/**
 * The filtered window held no receipts at all.
 *
 * This is a DIFFERENT statement from "every counter is zero", and the
 * difference is the point: receipt emission is opt-in, so a vault where
 * nobody asked for receipts has recorded nothing, and reporting counts
 * of zero would present the absence of a mechanism as a finding about
 * retrieval. The shape carries no counters, so a consumer cannot read
 * one without first branching on `recorded`.
 */
export interface ContextReceiptFoldEmpty {
  readonly recorded: false;
  readonly max_receipts: number;
}

/** The fold over a non-empty window. */
export interface ContextReceiptFoldResult {
  readonly recorded: true;
  /** Receipts folded, including any withheld from item aggregation. */
  readonly receipt_count: number;
  /** Total item occurrences across the aggregated receipts. */
  readonly item_total: number;
  /** Distinct artifacts behind those occurrences. */
  readonly distinct_items: number;
  /** Per-artifact frequency and token cost, most-injected first. */
  readonly items: ReadonlyArray<ContextReceiptItemUsage>;
  /**
   * Receipts the redactor flagged private or redacted. They are counted
   * but never unfolded, so redacted content cannot re-enter the vault
   * through an aggregate. The three item figures above describe the
   * remaining receipts only.
   */
  readonly withheld_receipts: number;
  /**
   * Folded receipts that recorded an EMPTY item array.
   *
   * A real and expected shape, not a defect: the SessionStart meter
   * writes `items: []` whenever the injection loader degraded to its
   * last-good cache, because the sub-bodies it would have attributed
   * were never emitted. They inflate `receipt_count` while contributing
   * nothing to the item figures, so they are counted here rather than
   * disappearing into the difference between two other numbers.
   */
  readonly empty_receipts: number;
  /**
   * Folded receipts whose `items` field is absent or not an array. A
   * receipt that cannot be unfolded at all - distinct from one that
   * deliberately carried nothing.
   */
  readonly malformed_receipts: number;
  /** True when the fold bound cut the input; the figures are a prefix. */
  readonly truncated: boolean;
  readonly max_receipts: number;
}

export type ContextReceiptFold = ContextReceiptFoldEmpty | ContextReceiptFoldResult;

/**
 * Join `context_receipt` records across a window into one retrieval
 * picture: how many injections happened, how many distinct artifacts
 * they carried, and how often and how expensively each one was injected.
 *
 * Read-only. Every field folded here was already durable on the record;
 * what did not exist was the join - `listContextReceipts` has only ever
 * mapped one summary per record, so nothing could answer "what did this
 * session actually keep re-injecting?".
 */
export function summarizeContextReceiptSession(
  vault: string,
  filter: ContextReceiptFoldFilter = {},
): ContextReceiptFold {
  assertContextReceiptWindowBound("since", filter.since);
  assertContextReceiptWindowBound("until", filter.until);
  const maxReceipts = Math.max(
    1,
    Math.floor(filter.maxReceipts ?? CONTEXT_RECEIPT_FOLD_MAX_RECEIPTS),
  );
  const matched = listContinuityRecords(vault, {
    kind: "context_receipt",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  })
    .filter((record) =>
      matchesReceiptFilter(record, {
        ...(filter.trigger !== undefined ? { trigger: filter.trigger } : {}),
        ...(filter.host !== undefined ? { host: filter.host } : {}),
        ...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
      }),
    )
    .toReversed();

  if (matched.length === 0) {
    return Object.freeze({ recorded: false as const, max_receipts: maxReceipts });
  }

  const folded = matched.slice(0, maxReceipts);
  const usage = new Map<string, { path?: string; injections: number; tokens: number }>();
  let itemTotal = 0;
  let withheld = 0;
  let emptyReceipts = 0;
  let malformedReceipts = 0;

  for (const record of folded) {
    if (record.private || record.redacted) {
      withheld += 1;
      continue;
    }
    const items = record.payload["items"];
    if (!Array.isArray(items)) {
      malformedReceipts += 1;
      continue;
    }
    if (items.length === 0) emptyReceipts += 1;
    for (const raw of items) {
      if (raw === null || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const id = item["id"];
      if (typeof id !== "string" || id.length === 0) continue;
      itemTotal += 1;
      const path = typeof item["path"] === "string" ? item["path"] : undefined;
      const tokens = typeof item["tokens"] === "number" ? item["tokens"] : 0;
      const current = usage.get(id) ?? { injections: 0, tokens: 0 };
      current.injections += 1;
      current.tokens += tokens;
      if (current.path === undefined && path !== undefined) current.path = path;
      usage.set(id, current);
    }
  }

  const items = [...usage.entries()]
    .map(([id, entry]) =>
      Object.freeze({
        id,
        ...(entry.path !== undefined ? { path: entry.path } : {}),
        injections: entry.injections,
        tokens: entry.tokens,
      }),
    )
    // Codepoint order for the id tiebreak, not `localeCompare`: the
    // comparison must be reproducible across hosts, and ICU collation
    // varies with the runtime locale, so the same receipts could fold to a
    // different item order on two machines. Matches `stamp.ts` and
    // `link-ratchet.ts`, which take the same decision for the same reason.
    .toSorted(
      (a, b) =>
        b.injections - a.injections ||
        b.tokens - a.tokens ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  return Object.freeze({
    recorded: true as const,
    receipt_count: folded.length,
    item_total: itemTotal,
    distinct_items: usage.size,
    items: Object.freeze(items),
    withheld_receipts: withheld,
    empty_receipts: emptyReceipts,
    malformed_receipts: malformedReceipts,
    truncated: matched.length > folded.length,
    max_receipts: maxReceipts,
  });
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
  return value === "context_pack" || value === "pre_compress" || value === "session_inject";
}

/** Every trigger, in declaration order, for schemas and error messages. */
export const CONTEXT_RECEIPT_TRIGGERS: ReadonlyArray<ContextReceiptTrigger> = Object.freeze([
  "context_pack",
  "pre_compress",
  "session_inject",
]);

function matchesReceiptFilter(record: ContinuityRecord, filter: ContextReceiptFilter): boolean {
  const payload = record.payload;
  if (filter.trigger !== undefined && payload["trigger"] !== filter.trigger) return false;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  if (filter.sessionId !== undefined && payload["session_id"] !== filter.sessionId) return false;
  return true;
}

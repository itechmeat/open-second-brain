/**
 * The context receipt tools of the pack family (task 3.19):
 * `brain_context_receipts` with its verify operation, the reach rules
 * the receipts answer under, the aggregation, and `brain_event_trace`.
 * Split from `pack-tools.ts`; registration happens through that
 * module's registry, which preserves the public PACK_TOOLS surface.
 */

import {
  assertContextReceiptWindowBound,
  CONTEXT_RECEIPT_TRIGGERS,
  getContextReceipt,
  isContextReceiptTrigger,
  listContextReceipts,
  lookupReceiptReplyPresence,
  RECEIPT_ITEM_ACTIVE_BODY,
  RECEIPT_ITEM_LESSONS_BODY,
  RECEIPT_ITEM_SCOPED_RULES,
  RECEIPT_ITEM_STANDING_RULES,
  summarizeContextReceipt,
  summarizeContextReceiptSession,
} from "../../core/brain/context-receipts.ts";
import { verifyContextReceipt } from "../../core/brain/context-receipts-verify.ts";
import type { ContinuityRecord } from "../../core/brain/continuity/types.ts";
import { observedReuseRates } from "../../core/brain/observed-use.ts";
import { EventTraceSelectorError, resolveLogEventTraces } from "../../core/brain/event-trace.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { pageSlice } from "../../core/brain/offset-cursor.ts";
import { cursorOffsetArg } from "./pagination.ts";
import { BRAIN_LOG_EVENT_KIND_SET, type BrainLogEventKind } from "../../core/brain/types.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tool-contract.ts";
import { contextReach } from "../tool-contract.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { coerceBool, unknownOperationError } from "../coerce.ts";
import { coercePositiveInteger, optionalStringArg } from "./shared.ts";

// ----- brain_context_receipts ---------------------------------------------

export async function toolBrainContextReceipts(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_context_receipts", args, "operation");
  if (operation === "list") {
    const trigger = optionalStringArg("brain_context_receipts", args, "trigger");
    if (trigger !== undefined && !isContextReceiptTrigger(trigger)) {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_context_receipts: trigger must be one of ${CONTEXT_RECEIPT_TRIGGERS.join(", ")}`,
      );
    }
    const host = optionalStringArg("brain_context_receipts", args, "host");
    const sessionId = optionalStringArg("brain_context_receipts", args, "session_id");
    const limit = coercePositiveInteger("brain_context_receipts", "limit", args["limit"]);
    const offset = cursorOffsetArg("brain_context_receipts", args);
    const local = contextReach(ctx) === TRANSPORT_REACH.local;
    // The full filtered set is read and one page is cut here, so `total`
    // stays the exact count matching the filter across all pages and the
    // walk continues through `next_cursor` (null when exhausted).
    const receipts = listContextReceipts(ctx.vault, {
      ...(trigger !== undefined ? { trigger } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(local ? {} : { exclude: isRuleOnlyInjection }),
    });
    // The join is show-only: summarizeContextReceipt's second parameter
    // is the presence join, so the summaries are mapped through an arrow
    // - a point-free `.map(summarizeContextReceipt)` would hand every
    // row's ARRAY INDEX to that parameter.
    const summaries = receipts
      .map((receipt) => receiptAtReach(receipt, local))
      .map((receipt) => summarizeContextReceipt(receipt));
    const page = pageSlice(summaries, offset, limit ?? Math.max(summaries.length, 1));
    return {
      vault_path: vaultPathField(ctx),
      total: page.total,
      receipts: page.items,
      next_cursor: page.next_cursor,
    };
  }

  if (operation === "show") {
    const id = optionalStringArg("brain_context_receipts", args, "id");
    if (id === undefined) {
      throw new MCPError(INVALID_PARAMS, "brain_context_receipts: id is required for show");
    }
    const local = contextReach(ctx) === TRANSPORT_REACH.local;
    const stored = getContextReceipt(ctx.vault, id);
    // Below local reach a receipt that recorded only the operator rules
    // is answered as an unknown id: showing it would say rules applied.
    if (stored === null || (!local && isRuleOnlyInjection(stored))) {
      throw new MCPError(INVALID_PARAMS, `brain_context_receipts: receipt not found: ${id}`);
    }
    const receipt = receiptAtReach(stored, local);
    return {
      id: receipt.id,
      kind: receipt.kind,
      createdAt: receipt.createdAt,
      sourceRefs: receipt.sourceRefs,
      payload: receipt.payload,
      private: receipt.private,
      redacted: receipt.redacted,
      // The receipt's session reply-presence join (t_f8510c55): the
      // per-note verdicts of the session's latest reply_presence record,
      // or the named unjoined outcome - a receipt whose session checked
      // no turn, or that names no session at all, says so instead of
      // reading as silently absent. The lookup runs on the reach-adjusted
      // record, so a payload redacted below local reach joins only on
      // what it still carries - and through the caller's reach view, so
      // a note row naming a page reserved below local reach drops from
      // `per_note` (counted in `withheld`) instead of disclosing its
      // path, range and verdict to a caller the page withheld itself from.
      reply_presence: lookupReceiptReplyPresence(
        ctx.vault,
        receipt,
        reachView(ctx.vault, contextReach(ctx)),
      ),
    };
  }

  if (operation === "summary") return summarizeReceipts(ctx, args);

  if (operation === "verify") return verifyReceipt(ctx, args);

  throw unknownOperationError(
    "brain_context_receipts: operation must be list, show, summary, or verify",
  );
}

// ----- brain_context_receipts verify (t_4300e5fd) ---------------------------

/** The `operation` value a verify refusal names. */
export const RECEIPT_VERIFY_OPERATION = "verify" as const;

/** The refusal reason when the caller is below local reach. */
export const RECEIPT_VERIFY_REACH_REASON = "reach" as const;

/** The refusal reason when the receipt is flagged private or redacted. */
export const RECEIPT_VERIFY_WITHHELD_REASON = "receipt_withheld" as const;

export type ReceiptVerifyRefusalReason =
  | typeof RECEIPT_VERIFY_REACH_REASON
  | typeof RECEIPT_VERIFY_WITHHELD_REASON;

/**
 * A verify call that was not answered, in the shape the receipts
 * surfaces already use for a refused half (`ReceiptCompactRefusal`):
 * the operation names itself, `measured: false` says no item was
 * re-hashed, and the reason names which guard refused - never a partial
 * verification.
 */
export interface ReceiptVerifyRefusal {
  readonly operation: typeof RECEIPT_VERIFY_OPERATION;
  readonly measured: false;
  readonly reason: ReceiptVerifyRefusalReason;
  readonly detail: string;
}

/**
 * Re-hash verification of one stored receipt (t_4300e5fd).
 *
 * Read-only, and local-reach only: the kernel re-reads the vault pages
 * the receipt names, and page content is host-local, so a caller below
 * local reach gets the typed refusal instead of a partial answer - the
 * same posture the `brain_receipts` compact half takes. A receipt the
 * session fold withholds (`private` or `redacted`) is refused
 * symmetrically: the fold never unfolds it, and verify never re-hashes
 * it.
 */
export async function verifyReceipt(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = optionalStringArg("brain_context_receipts", args, "id");
  if (id === undefined) {
    throw new MCPError(INVALID_PARAMS, "brain_context_receipts: id is required for verify");
  }
  if (contextReach(ctx) !== TRANSPORT_REACH.local) {
    // Returned as the literal, `satisfies`-checked against the refusal
    // interface, mirroring the compact refusal's construction: the
    // handler's wire type is Record<string, unknown>, and a value held
    // in the interface's name would not carry the index signature.
    return {
      operation: RECEIPT_VERIFY_OPERATION,
      measured: false,
      reason: RECEIPT_VERIFY_REACH_REASON satisfies ReceiptVerifyRefusalReason,
      detail:
        "context receipt verification re-reads the vault pages the receipt names; " +
        "page content is host-local, so it answers at local reach only",
    } satisfies ReceiptVerifyRefusal;
  }
  const stored = getContextReceipt(ctx.vault, id);
  if (stored === null) {
    throw new MCPError(INVALID_PARAMS, `brain_context_receipts: receipt not found: ${id}`);
  }
  if (stored.private || stored.redacted) {
    return {
      operation: RECEIPT_VERIFY_OPERATION,
      measured: false,
      reason: RECEIPT_VERIFY_WITHHELD_REASON satisfies ReceiptVerifyRefusalReason,
      detail:
        "the receipt is flagged private or redacted and is refused symmetrically " +
        "with the session fold, which withholds it whole",
    } satisfies ReceiptVerifyRefusal;
  }
  // Spread, not returned in its own name: the kernel's frozen interface
  // carries no index signature, and the handler's wire type is
  // Record<string, unknown> (the members are unchanged by the spread).
  return { ...verifyContextReceipt(ctx.vault, stored) };
}

/** Predicate: a receipt item whose `id` is one of `ids`. */
export const itemIdIn =
  (ids: ReadonlySet<string>) =>
  (item: unknown): boolean => {
    const id = (item as { id?: unknown } | null)?.id;
    return typeof id === "string" && ids.has(id);
  };

/** Receipt items naming the operator-rule blocks the SessionStart hook injected. */
export const OPERATOR_RULE_ITEM_IDS: ReadonlySet<string> = new Set([
  RECEIPT_ITEM_STANDING_RULES,
  RECEIPT_ITEM_SCOPED_RULES,
]);

/**
 * One operator-rule receipt item. Exported beside
 * {@link isRuleOnlyInjection} for the brain_truth provenance join, which
 * strips these items from a mixed receipt below local reach - the same
 * shaping `receiptAtReach` applies to the receipts this tool serves.
 */
export const isOperatorRuleItem = itemIdIn(OPERATOR_RULE_ITEM_IDS);

/**
 * A measured injection receipt whose every item was an operator-rule
 * block: the hook recorded it only because rules applied (a session with
 * no `active.md` body to inject). Below local reach it
 * is withheld whole - left out of list and summary, refused by show -
 * since even its empty remainder would say that rules applied.
 *
 * Exported for the surfaces that must answer the same question the
 * receipts surface answers: the brain_truth provenance join excludes
 * these receipts below local reach, so a claim's provenance confirms no
 * more about the operator's rules than this tool does.
 */
export function isRuleOnlyInjection(record: ContinuityRecord): boolean {
  if (record.payload["trigger"] !== "session_inject") return false;
  // A degraded injection that served a cached body beside the rules is
  // recorded whether or not rules applied: it stays, emptied of them. One
  // with no cached body (`loader_source: "empty"`) exists only because the
  // rules were injected, so it is rule-only like a measured one.
  const injection = record.payload["injection"] as
    | { sources_measured?: unknown; loader_source?: unknown }
    | undefined;
  if (injection?.sources_measured === false && injection.loader_source !== "empty") return false;
  const items = record.payload["items"];
  return Array.isArray(items) && items.length > 0 && items.every(isOperatorRuleItem);
}

/** Receipt items charged against the injection budget besides the scoped rules. */
export const BUDGETED_BODY_ITEM_IDS: ReadonlySet<string> = new Set([
  RECEIPT_ITEM_ACTIVE_BODY,
  RECEIPT_ITEM_LESSONS_BODY,
]);

export const isBudgetedBodyItem = itemIdIn(BUDGETED_BODY_ITEM_IDS);

/** Payload fields of an injection receipt whose figures include the operator-rule blocks. */
export const INJECTION_TOTAL_FIELDS = ["final_text_hash", "final_text_chars"] as const;
export const INJECTION_EXTRA_TOTAL_FIELDS = ["total_bytes", "total_tokens"] as const;
export const BUDGET_RULE_FIELDS = ["scoped_rules_chars", "budgeted_source_count"] as const;

/**
 * A stored receipt as the caller may see it at its reach.
 *
 * At local reach the record is returned unchanged. Below it, an injection
 * receipt says nothing about the operator's standing and scoped rules:
 * their items and source references are dropped (the remaining items
 * re-ranked), and every figure that counts or measures them - the item
 * count, the whole-text hash and lengths, the scoped characters and the
 * budgeted source count - is removed, so a session that injected rules
 * answers like one that did not.
 */
export function receiptAtReach(record: ContinuityRecord, local: boolean): ContinuityRecord {
  if (local || record.payload["trigger"] !== "session_inject") return record;
  const payload: Record<string, unknown> = { ...record.payload };
  if (Array.isArray(payload["items"])) {
    const items = (payload["items"] as ReadonlyArray<unknown>).filter(
      (item) => !isOperatorRuleItem(item),
    );
    payload["items"] = items.map((item, index) =>
      typeof item === "object" && item !== null ? { ...item, original_rank: index + 1 } : item,
    );
    payload["item_count"] = items.length;
  }
  for (const field of INJECTION_TOTAL_FIELDS) delete payload[field];
  const injection = payload["injection"];
  if (typeof injection === "object" && injection !== null) {
    const kept: Record<string, unknown> = { ...(injection as Record<string, unknown>) };
    for (const field of INJECTION_EXTRA_TOTAL_FIELDS) delete kept[field];
    payload["injection"] = kept;
  }
  const budget = payload["budget"];
  const remaining = Array.isArray(payload["items"]) ? (payload["items"] as unknown[]) : [];
  if (!remaining.some(isBudgetedBodyItem)) {
    // The block exists only because the scoped rules were charged: with
    // no budgeted body left, a receipt without the rules carries none.
    delete payload["budget"];
  } else if (typeof budget === "object" && budget !== null) {
    const kept: Record<string, unknown> = { ...(budget as Record<string, unknown>) };
    for (const field of BUDGET_RULE_FIELDS) delete kept[field];
    payload["budget"] = kept;
  }
  return {
    ...record,
    sourceRefs: record.sourceRefs.filter((ref) => !isOperatorRuleItem(ref)),
    payload,
  };
}

/**
 * Session-scoped retrieval report (context-integrity-gates, Unit I): a
 * read-only fold over receipts that already exist, joined to the
 * observed-use verdicts for the same window.
 *
 * A window with no receipts reports exactly that. Receipt emission is
 * opt-in, so counters of zero would describe a mechanism nobody enabled
 * rather than a retrieval finding.
 */
export async function summarizeReceipts(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const trigger = optionalStringArg("brain_context_receipts", args, "trigger");
  if (trigger !== undefined && !isContextReceiptTrigger(trigger)) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_context_receipts: trigger must be one of ${CONTEXT_RECEIPT_TRIGGERS.join(", ")}`,
    );
  }
  const host = optionalStringArg("brain_context_receipts", args, "host");
  const sessionId = optionalStringArg("brain_context_receipts", args, "session_id");
  const since = optionalStringArg("brain_context_receipts", args, "since");
  const until = optionalStringArg("brain_context_receipts", args, "until");
  // Both bounds are compared LEXICALLY against stored `createdAt`
  // strings. An uncomparable value (`"yesterday"`, a local-time stamp,
  // `2026-13-01`) silently filters the window to empty and the fold
  // reports "no receipts recorded for this filter" - "nothing happened"
  // for what is really malformed input. Refuse it instead.
  for (const [field, value] of [
    ["since", since],
    ["until", until],
  ] as const) {
    try {
      assertContextReceiptWindowBound(field, value);
    } catch (err) {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_context_receipts: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const maxReceipts = coercePositiveInteger(
    "brain_context_receipts",
    "max_receipts",
    args["max_receipts"],
  );
  const limit = coercePositiveInteger("brain_context_receipts", "limit", args["limit"]);

  const window = {
    ...(trigger !== undefined ? { trigger } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  };
  const local = contextReach(ctx) === TRANSPORT_REACH.local;
  const fold = summarizeContextReceiptSession(ctx.vault, {
    ...window,
    ...(maxReceipts !== undefined ? { maxReceipts } : {}),
    // Below local reach the operator-rule items leave the item figures,
    // and a receipt that recorded nothing else is not folded at all.
    ...(local ? {} : { exclude: isRuleOnlyInjection, excludeItem: isOperatorRuleItem }),
  });
  if (!fold.recorded) {
    return {
      vault_path: vaultPathField(ctx),
      recorded: false,
      max_receipts: fold.max_receipts,
      note: "no receipts recorded for this filter; receipt emission is opt-in per call",
    };
  }

  // Observed use is folded over the SAME window, so a per-item verdict
  // describes this session rather than the artifact's lifetime rate.
  const reuse = observedReuseRates(ctx.vault, {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  });
  const items = limit === undefined ? fold.items : fold.items.slice(0, limit);

  return {
    vault_path: vaultPathField(ctx),
    recorded: true,
    receipt_count: fold.receipt_count,
    item_total: fold.item_total,
    distinct_items: fold.distinct_items,
    withheld_receipts: fold.withheld_receipts,
    // Receipts that inflate `receipt_count` and contribute no items: an
    // injection that degraded to cache records `items: []` by design,
    // and a receipt with no item array at all cannot be unfolded. Both
    // used to vanish into the gap between `receipt_count` and
    // `item_total`.
    empty_receipts: fold.empty_receipts,
    malformed_receipts: fold.malformed_receipts,
    truncated: fold.truncated,
    max_receipts: fold.max_receipts,
    items: items.map((item) => {
      const observed = reuse.get(item.path ?? item.id);
      return {
        id: item.id,
        ...(item.path !== undefined ? { path: item.path } : {}),
        injections: item.injections,
        tokens: item.tokens,
        ...(observed !== undefined
          ? {
              observed: {
                used: observed.used,
                ignored: observed.ignored,
                contradicted: observed.contradicted,
                total: observed.total,
                score: observed.score,
              },
            }
          : {}),
      };
    }),
  };
}

// ----- brain_event_trace ---------------------------------------------------

export async function toolBrainEventTrace(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const kind = optionalStringArg("brain_event_trace", args, "kind");
  if (kind !== undefined && !BRAIN_LOG_EVENT_KIND_SET.has(kind)) {
    throw new MCPError(INVALID_PARAMS, `brain_event_trace: unknown event kind '${kind}'`);
  }
  const date = optionalStringArg("brain_event_trace", args, "date");
  const at = optionalStringArg("brain_event_trace", args, "at");
  const sessionId = optionalStringArg("brain_event_trace", args, "session_id");
  const limit = coercePositiveInteger("brain_event_trace", "limit", args["limit"]);
  const offset = cursorOffsetArg("brain_event_trace", args);
  const keepPrivate = coerceBool(args, "keep_private");

  let events;
  try {
    // The scan early-exits one event past the page's reach
    // (`offset + limit + 1`, evaluated by the core before the
    // trace-attachment work): the lookahead proves whether a next page
    // exists, so `next_cursor` never lies and the full day's matching
    // set stays reachable by walking, while one page fetch never re-runs
    // the attachment scan past its own reach. (The cursor rollout
    // dropped the caller cap that bounded this scan, making every page
    // fetch attach traces for the whole day - a quadratic walk under
    // forged cursors; the bound restores the early exit without
    // reintroducing silent truncation.) `total`/`trace_total` are exact
    // once the walk exhausts; before that they report the bound the
    // page reached. A limit-less call still reads the day whole: its
    // page is the answer, not a step of a walk.
    const scanBound = limit !== undefined ? offset + limit + 1 : undefined;
    events = resolveLogEventTraces(ctx.vault, {
      ...(date !== undefined ? { date } : {}),
      ...(at !== undefined ? { at } : {}),
      ...(kind !== undefined ? { kind: kind as BrainLogEventKind } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(scanBound !== undefined ? { limit: scanBound } : {}),
      ...(keepPrivate === true ? { keepPrivate: true } : {}),
      // The event body is echoed verbatim and log payloads carry
      // artifact paths (a-label-is-not-a-boundary, U3).
      ownerScope: gatedOwnerScopeView(ctx.vault, ctx.agentName).scope,
      // A note-write body carries the page's whole-file digest and byte
      // size, so an event naming a page the caller may not read at its
      // reach is dropped exactly as an event about an absent page is.
      view: reachView(ctx.vault, contextReach(ctx)),
    });
  } catch (err) {
    // A selector-validation error (bad date/at/kind, checked before any IO) is
    // a caller error (INVALID_PARAMS). ANY OTHER throw is a runtime IO failure -
    // e.g. an existing-but-unreadable log dir (EACCES/EIO/ENOTDIR) - and must be
    // an internal error, not a parameter error.
    if (err instanceof EventTraceSelectorError) {
      throw new MCPError(INVALID_PARAMS, `brain_event_trace: ${err.message}`);
    }
    throw new MCPError(INTERNAL_ERROR, `brain_event_trace: ${(err as Error).message}`);
  }

  const page = pageSlice(events, offset, limit ?? Math.max(events.length, 1));
  return {
    vault_path: vaultPathField(ctx),
    total: page.total,
    trace_total: events.reduce((sum, e) => sum + e.traceCount, 0),
    events: page.items,
    next_cursor: page.next_cursor,
  };
}

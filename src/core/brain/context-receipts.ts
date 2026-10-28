import { sha256Hex } from "../integrity/digest.ts";

import {
  ANSWER_QUOTE_VERDICT,
  isAnswerQuoteVerdict,
  mergeAnswerQuoteVerdicts,
} from "./answer-quotes/check.ts";
import {
  appendContinuityRecord,
  isCanonicalUtcTimestamp,
  listContinuityRecords,
} from "./continuity/store.ts";
import { CONTINUITY_SESSION_ID_KEY, type ContinuityRecord } from "./continuity/types.ts";
import type { RecallAdequacyVerdict } from "./recall-adequacy.ts";
import type { ReachView } from "./reach-view.ts";

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
  /**
   * The advisory decision-model annotation of that verdict (issue #213,
   * Part 8), stored next to it as `decision_answerable`. Numbers only.
   */
  readonly decisionAnswerable?: { readonly probability: number; readonly disagrees: boolean };
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
  /**
   * Exact receipt id (answer-trust, task B3): the one-record lookup the
   * claim-provenance join uses to resolve a claim's `sample_id` to the
   * receipt it names. Matched BEFORE the limit, like every other filter
   * field, so a receipt lookup answers the store's answer for that id
   * and never whichever receipts happen to be newest.
   */
  readonly receiptId?: string;
  readonly limit?: number;
  /**
   * Receipts the caller may not see at all. They are left out before the
   * limit is applied, so the answer is the one a store without them gives.
   */
  readonly exclude?: (record: ContinuityRecord) => boolean;
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
  /**
   * The receipt's session reply-presence join (t_f8510c55), present ONLY
   * when the caller handed a {@link lookupReceiptReplyPresence} result in.
   * List summaries stay summaries and omit it; a show path passes the
   * lookup in, and the member then names either the joined per-note
   * verdicts or the unjoined outcome - never a silent absence.
   */
  readonly reply_presence?: ReceiptReplyPresenceJoin;
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
    ...(input.adequacy && input.decisionAnswerable
      ? {
          decision_answerable: {
            probability: input.decisionAnswerable.probability,
            disagrees: input.decisionAnswerable.disagrees,
          },
        }
      : {}),
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
  /**
   * Receipts the caller may not see at all. They are left out before the
   * fold bound is applied, so neither `receipt_count` nor `truncated`
   * counts them.
   */
  readonly exclude?: (record: ContinuityRecord) => boolean;
  /**
   * Receipt items the caller may not see. They leave the item figures,
   * and a receipt they leave with no item counts in `empty_receipts`, as
   * a receipt that never carried them would.
   */
  readonly excludeItem?: (item: unknown) => boolean;
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
        ...(filter.exclude !== undefined ? { exclude: filter.exclude } : {}),
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
    const stored = record.payload["items"];
    if (!Array.isArray(stored)) {
      malformedReceipts += 1;
      continue;
    }
    const excludeItem = filter.excludeItem;
    const items = excludeItem === undefined ? stored : stored.filter((item) => !excludeItem(item));
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

// ----- reply-presence join (t_f8510c55) ------------------------------------

/**
 * One injected note's presence verdict, as the answer-quote-check hook
 * wrote it. The verdict string is the quote-check vocabulary (`verified`,
 * `not-in-note`, `source-truncated`, `note-unavailable`, `not-text`,
 * plus the per-note-only `absent`); the reader passes it through
 * verbatim, so a verdict member a newer hook writes still reads here
 * without a reader release.
 */
export interface ReceiptReplyPresenceNote {
  readonly path: string;
  readonly start_line?: number;
  readonly end_line?: number;
  readonly verdict: string;
}

/**
 * The per-note presence verdicts one receipt's session produced, joined
 * from the session's `reply_presence` records. Identifiers and verdicts
 * only - the records never carried answer text, and none is invented
 * here.
 */
export interface ReceiptReplyPresence {
  /**
   * Continuity id of the NEWEST `reply_presence` record the join folded.
   * The verdicts are the fold's, not that record's alone: every readable
   * session record written at or after the receipt contributed.
   */
  readonly record_id: string;
  /** When that record was written - the last turn the fold drew from. */
  readonly created_at: string;
  /**
   * How many reply spans the folded records measured in sum; `null` when
   * none of them carried a readable count.
   */
  readonly checked: number | null;
  /**
   * One row per note THIS receipt injected, first-seen order across the
   * folded turns kept. The hook's record covers the session's whole
   * injection ledger; the join covers the receipt, so a row for a note
   * the receipt never injected is not this receipt's history to report.
   * A note the receipt injected that no folded record carried has no row:
   * the join reports what was measured, never an inferred verdict.
   */
  readonly per_note: ReadonlyArray<ReceiptReplyPresenceNote>;
  /**
   * How many folded note rows for THIS receipt's own notes were WITHHELD
   * below the caller's reach, by the same {@link isPathReadableAtReach}
   * verdict every surface resolves a path with - summed across the folded
   * records. Present only when rows were dropped, so a join that
   * withheld nothing stays byte-identical - and a truncated join can
   * never read as a session that checked fewer notes.
   */
  readonly withheld?: number;
  /**
   * Hash binding the verdicts to the exact answer text checked - carried
   * only when the fold drew from ONE record. A fold over several records
   * answers across several answers, and no single answer hash binds it.
   */
  readonly source_hash?: string;
}

/**
 * The outcome of joining a receipt to its session's `reply_presence`
 * record. `joined` carries the verdicts; `unjoined` is the HONEST
 * absence: the receipt names a session no presence record answers, or
 * names no session at all. A missing join is never rendered as an
 * inferred one - there is no time-window fallback - and the unjoined
 * outcome names the key that did not match so a reader can tell a
 * keyless receipt from an unchecked session.
 */
export type ReceiptReplyPresenceJoin =
  | { readonly joined: true; readonly presence: ReceiptReplyPresence }
  | { readonly joined: false; readonly reason: "unjoined"; readonly session_id?: string };

/**
 * Join a context receipt to its session's reply-presence records by exact
 * {@link CONTINUITY_SESSION_ID_KEY} match (t_f8510c55).
 *
 * The receipt's own creation draws the fold window: EVERY readable
 * `reply_presence` record of the session written at or after
 * `createdAt` folds into the join, chronologically, with `verified`
 * winning across turns. The window is the honesty guarantee on both
 * sides. The Stop hook writes a record on every checked turn - including
 * turns that quote nothing, where every note reads `absent` - so joining
 * only the session's newest record would answer a receipt whose note was
 * verified in the next turn with a later turn's absence; and a record
 * written before the receipt describes turns this receipt's injections
 * did not exist for, so no earlier record may answer it either. A
 * receipt with no readable record at or after its own creation reads
 * `unjoined` - the HONEST absence, never an inferred join - whether no
 * record exists, none matches the window, or every in-window record's
 * payload is unreadable. A record whose payload cannot be read is
 * skipped per record (never reported as the join, never a reason to
 * orphan readable records behind it); a record whose written time cannot
 * be read claims no place in the window. The join names itself
 * (`record_id`, `created_at` - the newest record folded), and earlier
 * turns remain in the ledger for the continuity reader.
 *
 * `per_note` is restricted to the receipt's own injected notes: the
 * hook's record covers the session's whole ledger, and a row for a note
 * the receipt never carried is not this receipt's history to report.
 *
 * A receipt without a session key is unjoined before the ledger is read:
 * there is nothing to match on, and inventing a window would answer a
 * question the receipt never asked.
 *
 * `view` is the caller's reach view ({@link reachView}); every folded
 * note row whose path it hides is DROPPED from `per_note` and counted in
 * `withheld`, so a caller below local reach reads neither the path, the
 * line range nor the verdict of a page reserved against it - the same
 * shaping the receipt record itself undergoes. Absent (the CLI, which
 * runs at local reach by construction) withholds nothing.
 */
export function lookupReceiptReplyPresence(
  vault: string,
  record: ContinuityRecord,
  view?: ReachView,
): ReceiptReplyPresenceJoin {
  const sessionId = record.payload[CONTINUITY_SESSION_ID_KEY];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return Object.freeze({ joined: false as const, reason: "unjoined" });
  }
  // A receipt whose creation cannot be read can establish no window at
  // all: no record can prove it was written at or after the receipt, so
  // nothing may claim to answer it.
  const createdAtMs = Date.parse(record.createdAt);
  if (Number.isNaN(createdAtMs)) {
    return Object.freeze({
      joined: false as const,
      reason: "unjoined" as const,
      session_id: sessionId,
    });
  }
  const injectedPaths = receiptInjectedPaths(record);
  // Exact session match, as before; then the window - at or after the
  // receipt, readable, chronological. Append order breaks same-instant
  // ties, matching the store's read order.
  const store = listContinuityRecords(vault, { kind: "reply_presence" });
  const turns: PresenceTurn[] = [];
  for (let i = 0; i < store.length; i++) {
    const sibling = store[i]!;
    if (sibling.payload[CONTINUITY_SESSION_ID_KEY] !== sessionId) continue;
    const writtenMs = Date.parse(sibling.createdAt);
    if (Number.isNaN(writtenMs) || writtenMs < createdAtMs) continue;
    const turn = readablePresenceTurn(sibling, writtenMs, i, injectedPaths, view);
    if (turn !== null) turns.push(turn);
  }
  if (turns.length === 0) {
    // No sibling at all, none at or after the receipt, or none in the
    // window whose payload reads: either way the honest answer is the
    // named absence, keyed on the session that did not produce a
    // readable record for this receipt.
    return Object.freeze({
      joined: false as const,
      reason: "unjoined" as const,
      session_id: sessionId,
    });
  }
  const folded = turns.toSorted(
    (a, b) => a.writtenMs - b.writtenMs || a.appendIndex - b.appendIndex,
  );
  const newest = folded[folded.length - 1]!;
  const rowsByPath = new Map<string, ReceiptReplyPresenceNote[]>();
  let withheld = 0;
  let checked: number | null = null;
  for (const turn of folded) {
    if (typeof turn.checked === "number") checked = (checked ?? 0) + turn.checked;
    withheld += turn.withheld;
    for (const row of turn.rows) {
      const rows = rowsByPath.get(row.path);
      if (rows === undefined) rowsByPath.set(row.path, [row]);
      else rows.push(row);
    }
  }
  const perNote = [...rowsByPath.values()].map((rows) => foldNoteRows(rows));
  return Object.freeze({
    joined: true as const,
    presence: Object.freeze({
      record_id: newest.record.id,
      created_at: newest.record.createdAt,
      checked,
      per_note: Object.freeze(perNote),
      ...(withheld > 0 ? { withheld } : {}),
      ...(folded.length === 1 && folded[0]!.sourceHash !== undefined
        ? { source_hash: folded[0]!.sourceHash }
        : {}),
    }),
  });
}

/**
 * The vault-relative note paths THIS receipt injected: the `path` members
 * of its recorded items. Items without a path (the operator-rule blocks,
 * the bodies keyed by id alone) offer nothing the presence rows could
 * match, and a receipt whose items cannot be read injects nothing this
 * join can report on.
 */
function receiptInjectedPaths(record: ContinuityRecord): ReadonlySet<string> {
  const paths = new Set<string>();
  const stored = record.payload["items"];
  if (!Array.isArray(stored)) return paths;
  for (const raw of stored) {
    if (raw === null || typeof raw !== "object") continue;
    const path = (raw as Record<string, unknown>)["path"];
    if (typeof path === "string" && path.length > 0) paths.add(path);
  }
  return paths;
}

/**
 * One readable in-window `reply_presence` record, shaped for the fold:
 * its rows restricted to the receipt's own injected notes, each visible
 * row kept and each reach-hidden row counted. `null` when the payload
 * cannot be read at all (no `per_note` array) - the per-record
 * unreadable skip the walk-back named, here meaning the record simply
 * contributes no turn.
 */
function readablePresenceTurn(
  record: ContinuityRecord,
  writtenMs: number,
  appendIndex: number,
  injectedPaths: ReadonlySet<string>,
  view?: ReachView,
): PresenceTurn | null {
  const stored = record.payload["per_note"];
  if (!Array.isArray(stored)) return null;
  const visible = view?.visible ?? (() => true);
  const rows: ReceiptReplyPresenceNote[] = [];
  let withheld = 0;
  for (const raw of stored) {
    if (raw === null || typeof raw !== "object") continue;
    const note = raw as Record<string, unknown>;
    const path = note["path"];
    const verdict = note["verdict"];
    if (typeof path !== "string" || path.length === 0) continue;
    if (typeof verdict !== "string" || verdict.length === 0) continue;
    // The receipt scopes the join: a row for a note this receipt never
    // injected is dropped before the reach verdict runs, so the join
    // resolves no visibility it will not use.
    if (!injectedPaths.has(path)) continue;
    // The reach verdict runs on the row's path BEFORE anything from it is
    // kept, and a hidden row counts: reporting the drop is what keeps a
    // filtered join honest instead of reading as a smaller check.
    if (!visible(path)) {
      withheld += 1;
      continue;
    }
    rows.push({
      path,
      verdict,
      ...(typeof note["start_line"] === "number" ? { start_line: note["start_line"] } : {}),
      ...(typeof note["end_line"] === "number" ? { end_line: note["end_line"] } : {}),
    });
  }
  const checked = record.payload["checked"];
  const sourceHash = record.payload["source_hash"];
  return {
    record,
    writtenMs,
    appendIndex,
    checked: typeof checked === "number" ? checked : null,
    rows,
    withheld,
    ...(typeof sourceHash === "string" && sourceHash.length > 0 ? { sourceHash } : {}),
  };
}

/** Sort and fold input: one readable in-window record's contribution. */
interface PresenceTurn {
  readonly record: ContinuityRecord;
  /** The record's written time, the fold's primary sort key. */
  readonly writtenMs: number;
  /** Store append position, the same-instant tiebreak. */
  readonly appendIndex: number;
  readonly checked: number | null;
  readonly rows: ReadonlyArray<ReceiptReplyPresenceNote>;
  readonly withheld: number;
  readonly sourceHash?: string;
}

/**
 * Fold one injected note's rows across the folded turns, oldest first. A
 * hit anywhere in the receipt's lifetime wins - a later turn's absence
 * never erases an earlier verification, and the newest verifying row
 * carries the line range the hit was found against. Otherwise the check
 * module's own merge ladder runs over the MEASURED misses: `absent` is
 * no turn's measurement, and it neither upgrades nor downgrades a miss
 * another turn recorded. A note whose every row is `absent` - or whose
 * verdicts a newer hook wrote and this reader cannot place - reads its
 * newest row verbatim: the join passes verdict strings through, it does
 * not interpret what it does not know.
 */
function foldNoteRows(rows: ReadonlyArray<ReceiptReplyPresenceNote>): ReceiptReplyPresenceNote {
  if (rows.length === 1) return rows[0]!;
  const verified = rows.filter((row) => row.verdict === ANSWER_QUOTE_VERDICT.verified);
  if (verified.length > 0) return verified[verified.length - 1]!;
  const measured = rows.flatMap((row) =>
    row.verdict !== ANSWER_QUOTE_VERDICT.absent && isAnswerQuoteVerdict(row.verdict)
      ? [row.verdict]
      : [],
  );
  if (measured.length > 0) {
    const merged = mergeAnswerQuoteVerdicts(measured);
    const carrier = [...rows].reverse().find((row) => row.verdict === merged);
    return carrier ?? rows[rows.length - 1]!;
  }
  return rows[rows.length - 1]!;
}

export function summarizeContextReceipt(
  record: ContinuityRecord,
  replyPresence?: ReceiptReplyPresenceJoin,
): ContextReceiptSummary {
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
    ...(replyPresence !== undefined ? { reply_presence: replyPresence } : {}),
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

/**
 * Receipt item ids of the operator-rule blocks the SessionStart hook
 * injects: the constitution and the scoped rules. Structural ids, never
 * derived from content; a reader below local reach withholds them.
 */
export const RECEIPT_ITEM_STANDING_RULES = "standing-rules";
export const RECEIPT_ITEM_SCOPED_RULES = "scoped-rules";

/**
 * Receipt item ids of the memory bodies the SessionStart hook charges
 * against `inject_budget_chars` besides the scoped rules: the active and
 * the lessons body. A receipt's budget block exists because one of them,
 * or the scoped rules, was measured.
 */
export const RECEIPT_ITEM_ACTIVE_BODY = "active-body";
export const RECEIPT_ITEM_LESSONS_BODY = "lessons-body";

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
  if (filter.receiptId !== undefined && record.id !== filter.receiptId) return false;
  if (filter.trigger !== undefined && payload["trigger"] !== filter.trigger) return false;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  if (filter.sessionId !== undefined && payload["session_id"] !== filter.sessionId) return false;
  if (filter.exclude !== undefined && filter.exclude(record)) return false;
  return true;
}

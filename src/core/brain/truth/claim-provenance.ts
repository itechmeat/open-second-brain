/**
 * Read-only claim-to-provenance join (answer-trust, tasks B3/B6).
 *
 * A claim's optional `sample_id` names the recall/context-pack
 * quality-sample the claim was stated against - usually a context
 * receipt id, sometimes an opaque request hash. This module resolves
 * that id at READ time by composing the existing readers:
 *
 *   - receipt items, by receipt id (`listContextReceipts`);
 *   - the outcome row posted against the sample (`listContextPackOutcomes`),
 *     with the evidence verdict recorded beside it
 *     (`listContextPackEvidence`).
 *
 * Omit-don't-invent governs every half. A sample id with a receipt but
 * no outcome row is "receipt known, outcome unknown": the outcome field
 * is null and no caller may fabricate a verdict for it. The same honesty
 * extends to "receipt unreadable": a receipt record whose `created_at`
 * fails the canonical-timestamp check (the continuity reader validates
 * that stamp on append only, so a hand-edited or foreign-synced shard
 * can carry one no append would accept) is skipped at index load, and a
 * claim naming it answers "receipt unknown" instead of failing the whole
 * read. A claim timestamped BEFORE its claimed receipt's `created_at`
 * carries an inversion flag instead of being silently joined - a receipt
 * the claim predates cannot have informed it.
 *
 * The module performs NO vault writes and imports no continuity append
 * path; the claim-attribution census pins that invariant
 * architecturally. It reads through the existing readers at their
 * existing visibility and widens nothing: a receipt whose record is
 * private or redacted is reported KNOWN but its items are never
 * unfolded (the receipts-fold rule), so redacted content cannot
 * re-enter the vault through a claim's provenance. What the caller may
 * not see at its reach arrives as the caller's own filters - the same
 * `exclude` / `excludeItem` hooks the receipts list and fold take - so
 * the join never needs transport vocabulary of its own.
 *
 * The sample id is OPAQUE throughout: echoed verbatim, never
 * normalized, never logged beside answer or source text.
 */

import { listContextPackEvidence } from "../context-pack-evidence.ts";
import { listContextPackOutcomes } from "../context-pack-outcome.ts";
import { isContextReceiptTrigger, listContextReceipts } from "../context-receipts.ts";
import { isCanonicalUtcTimestamp } from "../continuity/store.ts";
import type { ContinuityRecord } from "../continuity/types.ts";

/** One injected item a claimed receipt accounts for. */
export interface ClaimProvenanceReceiptItem {
  readonly id: string;
  /** Vault-relative path, when the receipt recorded one. */
  readonly path?: string;
  /** Whether the receipt recorded the item as trimmed, when recorded. */
  readonly trimmed?: boolean;
}

/**
 * The receipt half of the join: what the claimed sample injected.
 * `items` is empty exactly when `withheld` is true - a private or
 * redacted receipt is known but never unfolded.
 */
export interface ClaimProvenanceReceipt {
  readonly id: string;
  readonly created_at: string;
  readonly trigger: string | null;
  readonly items: ReadonlyArray<ClaimProvenanceReceiptItem>;
  readonly withheld: boolean;
}

/** The outcome half of the join: what the sample led to. */
export interface ClaimProvenanceOutcome {
  readonly id: string;
  readonly created_at: string;
  /**
   * The row's own first-pass verdict. Null when the row carries no
   * boolean - a hand-edited or forward-compat row renders unknown,
   * never a coerced "failed".
   */
  readonly first_pass_success: boolean | null;
  /** The evidence row's verdict for this sample, when that row exists. */
  readonly evidence_verdict?: string;
}

/** The resolved provenance for one claim's `sample_id`. */
export interface ClaimProvenance {
  /** The claim's sample id, verbatim (opaque). */
  readonly sample_id: string;
  /** Null when no receipt names this id: the receipt half is unknown. */
  readonly receipt: ClaimProvenanceReceipt | null;
  /**
   * Null when no outcome row was posted against this id - "receipt
   * known, outcome unknown" when the receipt half is present. Never a
   * fabricated verdict.
   */
  readonly outcome: ClaimProvenanceOutcome | null;
  /** True when the claim's assertion ts predates its claimed receipt. */
  readonly timestamp_inverted: boolean;
}

/**
 * What the caller may not see, as filters rather than as a reach level.
 * Both hooks take the shape the receipts list and receipts fold already
 * define, so a surface binds its transport's rules once and the join
 * stays reach-blind.
 */
export interface ClaimProvenanceOptions {
  /**
   * Receipts the caller may not see at all. An excluded receipt renders
   * as the unknown-id answer - `receipt` is null, exactly as a store
   * without that receipt answers - never a `withheld` marker that would
   * confirm the receipt exists.
   */
  readonly exclude?: (record: ContinuityRecord) => boolean;
  /**
   * Receipt items the caller may not see. They leave the unfolded items
   * before the answer is built, so a claim's provenance never discloses
   * an item the caller could not read at its reach.
   */
  readonly excludeItem?: (item: unknown) => boolean;
}

/**
 * The three ledgers the join composes, read once and indexed for many
 * resolutions. The maps keep, per key, the same record the filtered
 * list functions answer first - they list newest-first, so the index is
 * built newest-wins - making an indexed resolution row-for-row the
 * single-call answer. Hydrating a page of claims through one index
 * costs one read per ledger instead of three full-ledger reads per
 * claim.
 */
export interface ClaimProvenanceIndex {
  /** Receipts by their record id (the receiptId lookup's key). */
  readonly receiptsByReceiptId: ReadonlyMap<string, ContinuityRecord>;
  /** Outcome rows by the sample id their payload posts against. */
  readonly outcomesBySampleId: ReadonlyMap<string, ContinuityRecord>;
  /** Evidence rows by the sample id their payload posts against. */
  readonly evidenceBySampleId: ReadonlyMap<string, ContinuityRecord>;
}

/**
 * Read each provenance ledger once and index it. Newest-wins per key:
 * the list functions answer newest-first, so the FIRST record under a
 * key is the one a filtered lookup returns, and later (older) records
 * under the same key never displace it. A receipt record whose
 * `createdAt` is not canonical UTC is UNREADABLE, never merely
 * uninverting: the continuity reader validates that stamp on append
 * only, so a hand-edited or foreign-synced shard can carry one no
 * append would accept. Skipping it here degrades PER CLAIM - the claim
 * naming it answers "receipt unknown", exactly as an absent id would -
 * instead of failing the whole events read for every unrelated claim on
 * the page.
 */
export function loadClaimProvenanceIndex(vault: string): ClaimProvenanceIndex {
  const receiptsByReceiptId = newestWinsById(listContextReceipts(vault), (record) =>
    isCanonicalUtcTimestamp(record.createdAt) ? record.id : null,
  );
  const outcomesBySampleId = newestWinsById(listContextPackOutcomes(vault), (record) =>
    payloadSampleId(record),
  );
  const evidenceBySampleId = newestWinsById(listContextPackEvidence(vault), (record) =>
    payloadSampleId(record),
  );
  return { receiptsByReceiptId, outcomesBySampleId, evidenceBySampleId };
}

function payloadSampleId(record: ContinuityRecord): string | null {
  const sampleId = record.payload["sample_id"];
  return typeof sampleId === "string" ? sampleId : null;
}

/**
 * Index one newest-first record list by key, keeping the first record
 * under each key - the same record a filtered lookup answers first.
 */
function newestWinsById(
  records: ReadonlyArray<ContinuityRecord>,
  keyOf: (record: ContinuityRecord) => string | null,
): ReadonlyMap<string, ContinuityRecord> {
  const index = new Map<string, ContinuityRecord>();
  for (const record of records) {
    const key = keyOf(record);
    if (key === null || index.has(key)) continue;
    index.set(key, record);
  }
  return index;
}

function receiptItems(
  record: ContinuityRecord,
  excludeItem: ((item: unknown) => boolean) | undefined,
): ReadonlyArray<ClaimProvenanceReceiptItem> {
  const stored = record.payload["items"];
  if (!Array.isArray(stored)) return [];
  const visible = excludeItem === undefined ? stored : stored.filter((item) => !excludeItem(item));
  const items: ClaimProvenanceReceiptItem[] = [];
  for (const raw of visible) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = item["id"];
    if (typeof id !== "string" || id === "") continue;
    const path = item["path"];
    const trimmed = item["trimmed"];
    items.push(
      Object.freeze({
        id,
        ...(typeof path === "string" && path !== "" ? { path } : {}),
        ...(typeof trimmed === "boolean" ? { trimmed } : {}),
      }),
    );
  }
  return Object.freeze(items);
}

function joinReceipt(
  record: ContinuityRecord,
  excludeItem: ((item: unknown) => boolean) | undefined,
): ClaimProvenanceReceipt {
  const withheld = record.private || record.redacted;
  return Object.freeze({
    id: record.id,
    created_at: record.createdAt,
    trigger: isContextReceiptTrigger(record.payload["trigger"]) ? record.payload["trigger"] : null,
    // A withheld receipt stays known but is never unfolded, so its item
    // list cannot carry private content back to the reader.
    items: withheld ? Object.freeze([]) : receiptItems(record, excludeItem),
    withheld,
  });
}

function joinOutcome(
  record: ContinuityRecord,
  evidence: ContinuityRecord | undefined,
): ClaimProvenanceOutcome {
  // The evidence verdict is read off its own row, joined on the same
  // sample id; absent when no evidence row exists - never inferred from
  // the outcome row.
  const evidenceVerdict = evidence?.payload["verdict"];
  // Omit-don't-invent: a row without its own boolean renders unknown -
  // null - never a coerced "false" inventing a failed verdict for a row
  // that said nothing (review L2.3).
  const firstPassSuccess = record.payload["first_pass_success"];
  return Object.freeze({
    id: record.id,
    created_at: record.createdAt,
    first_pass_success: typeof firstPassSuccess === "boolean" ? firstPassSuccess : null,
    ...(typeof evidenceVerdict === "string" ? { evidence_verdict: evidenceVerdict } : {}),
  });
}

/**
 * Resolve one claim's `sample_id` from a prebuilt {@link ClaimProvenanceIndex}.
 *
 * The row-for-row equivalent of {@link resolveClaimProvenance} at a
 * fraction of the cost whenever more than a claim or two needs
 * resolving: one index build (one read per ledger) covers every
 * resolution taken from it.
 *
 * @throws when `sampleId` is blank - the same never-coerced discipline
 *   the write boundary applies, so silence can never read as an answer.
 *   The inversion compare runs on parsed instants, and both sides
 *   reaching it are validated canonical first: the claim store validates
 *   the claim ts on read, and this module's index admits only receipt
 *   records whose `createdAt` passes the canonical-timestamp check (the
 *   continuity reader validates that stamp on APPEND only, so a
 *   hand-edited shard could otherwise fail the whole read here). A
 *   receipt that fails the check is unreadable, and the claim naming it
 *   answers "receipt unknown" instead of throwing.
 */
export function resolveClaimProvenanceFromIndex(
  index: ClaimProvenanceIndex,
  sampleId: string,
  claimTs: string,
  options?: ClaimProvenanceOptions,
): ClaimProvenance {
  if (sampleId.trim() === "") {
    throw new Error("claim provenance: sample_id must be a non-empty string");
  }
  let receiptRecord = index.receiptsByReceiptId.get(sampleId) ?? null;
  if (receiptRecord !== null && options?.exclude !== undefined && options.exclude(receiptRecord)) {
    // The excluded receipt is not the caller's answer at all: a store
    // without it answers "no receipt names this id", so the receipt
    // half renders unknown - never a marker confirming it exists.
    receiptRecord = null;
  }
  const outcomeRecord = index.outcomesBySampleId.get(sampleId) ?? null;
  // The evidence row joins on the same sample id: the outcome record was
  // indexed under the id its payload posts against, so re-reading that
  // payload here could only ever return the id already in hand.
  const outcomeEvidence =
    outcomeRecord === null ? undefined : index.evidenceBySampleId.get(sampleId);
  return Object.freeze({
    sample_id: sampleId,
    ...(receiptRecord !== null
      ? { receipt: joinReceipt(receiptRecord, options?.excludeItem) }
      : { receipt: null }),
    ...(outcomeRecord !== null
      ? { outcome: joinOutcome(outcomeRecord, outcomeEvidence) }
      : { outcome: null }),
    timestamp_inverted:
      receiptRecord !== null &&
      stampInstant("claim", claimTs) < stampInstant("receipt", receiptRecord.createdAt),
  });
}

/**
 * Resolve one claim's `sample_id` to its receipt and outcome halves.
 *
 * `claimTs` is the claim's canonical UTC assertion timestamp, compared
 * against the receipt's `created_at` as PARSED INSTANTS. The lexical
 * compare this replaces mis-orders a sub-second claim stamp against a
 * second-precision receipt stamp - `...:00.500Z` sorts before `...:00Z`
 * because "." < "Z" - and flagged a claim written half a second after
 * its receipt as inverted. Strict: a claim AT its receipt's instant was
 * informed by it; only a claim written BEFORE the receipt existed is an
 * inversion.
 */
export function resolveClaimProvenance(
  vault: string,
  sampleId: string,
  claimTs: string,
  options?: ClaimProvenanceOptions,
): ClaimProvenance {
  return resolveClaimProvenanceFromIndex(
    loadClaimProvenanceIndex(vault),
    sampleId,
    claimTs,
    options,
  );
}

/**
 * Parse one side of the inversion compare into its instant, refusing a
 * stamp that has none. Both sides reaching here were validated canonical
 * before the compare - the claim ts by the claim store's read boundary,
 * the receipt's `created_at` by the index admission check - so a parse
 * failure names the side whose ledger is corrupt rather than answering
 * the compare with `NaN`'s silent "false".
 */
function stampInstant(side: string, ts: string): number {
  const instant = Date.parse(ts);
  if (Number.isNaN(instant)) {
    throw new Error(
      `claim provenance: ${side} timestamp is not a parseable UTC instant: ${JSON.stringify(ts)}`,
    );
  }
  return instant;
}

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
 * is null and no caller may fabricate a verdict for it. A claim
 * timestamped BEFORE its claimed receipt's `created_at` carries an
 * inversion flag instead of being silently joined - a receipt the claim
 * predates cannot have informed it.
 *
 * The module performs NO vault writes and imports no continuity append
 * path; the claim-attribution census pins that invariant
 * architecturally. It reads through the existing readers at their
 * existing visibility and widens nothing: a receipt whose record is
 * private or redacted is reported KNOWN but its items are never
 * unfolded (the receipts-fold rule), so redacted content cannot
 * re-enter the vault through a claim's provenance.
 *
 * The sample id is OPAQUE throughout: echoed verbatim, never
 * normalized, never logged beside answer or source text.
 */

import { listContextPackEvidence } from "../context-pack-evidence.ts";
import { listContextPackOutcomes } from "../context-pack-outcome.ts";
import { isContextReceiptTrigger, listContextReceipts } from "../context-receipts.ts";
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
  readonly first_pass_success: boolean;
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

function receiptItems(record: ContinuityRecord): ReadonlyArray<ClaimProvenanceReceiptItem> {
  const stored = record.payload["items"];
  if (!Array.isArray(stored)) return [];
  const items: ClaimProvenanceReceiptItem[] = [];
  for (const raw of stored) {
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

function joinReceipt(record: ContinuityRecord): ClaimProvenanceReceipt {
  const withheld = record.private || record.redacted;
  return Object.freeze({
    id: record.id,
    created_at: record.createdAt,
    trigger: isContextReceiptTrigger(record.payload["trigger"]) ? record.payload["trigger"] : null,
    // A withheld receipt stays known but is never unfolded, so its item
    // list cannot carry private content back to the reader.
    items: withheld ? Object.freeze([]) : receiptItems(record),
    withheld,
  });
}

function joinOutcome(vault: string, record: ContinuityRecord): ClaimProvenanceOutcome {
  const sampleId = record.payload["sample_id"];
  // The evidence verdict is read off its own row, joined on the same
  // sample id; absent when no evidence row exists - never inferred from
  // the outcome row.
  const evidence =
    typeof sampleId === "string" ? listContextPackEvidence(vault, { sampleId })[0] : undefined;
  const evidenceVerdict = evidence?.payload["verdict"];
  return Object.freeze({
    id: record.id,
    created_at: record.createdAt,
    first_pass_success: record.payload["first_pass_success"] === true,
    ...(typeof evidenceVerdict === "string" ? { evidence_verdict: evidenceVerdict } : {}),
  });
}

/**
 * Resolve one claim's `sample_id` to its receipt and outcome halves.
 *
 * `claimTs` is the claim's canonical UTC assertion timestamp, compared
 * LEXICALLY against the receipt's `created_at` - correct for the
 * canonical form on both sides (the store validates the claim ts; the
 * continuity store stamps the receipt), the same comparison the
 * receipts-fold window bounds use.
 *
 * @throws when `sampleId` is blank - the same never-coerced discipline
 *   the write boundary applies, so silence can never read as an answer.
 */
export function resolveClaimProvenance(
  vault: string,
  sampleId: string,
  claimTs: string,
): ClaimProvenance {
  if (sampleId.trim() === "") {
    throw new Error("claim provenance: sample_id must be a non-empty string");
  }
  const receiptRecord = listContextReceipts(vault, { receiptId: sampleId })[0] ?? null;
  const outcomeRecord = listContextPackOutcomes(vault, { sampleId })[0] ?? null;
  return Object.freeze({
    sample_id: sampleId,
    ...(receiptRecord !== null ? { receipt: joinReceipt(receiptRecord) } : { receipt: null }),
    ...(outcomeRecord !== null
      ? { outcome: joinOutcome(vault, outcomeRecord) }
      : { outcome: null }),
    // Strict: a claim AT its receipt's second was informed by it; only a
    // claim written BEFORE the receipt existed is an inversion.
    timestamp_inverted: receiptRecord !== null && claimTs < receiptRecord.createdAt,
  });
}

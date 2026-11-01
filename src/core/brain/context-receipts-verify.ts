/**
 * Re-hash verification for context receipts (t_4300e5fd).
 *
 * A context receipt records, per injected item, the sha256 of the text
 * the session was DELIVERED. This module answers the operator question
 * the receipt left open: is the vault content behind that receipt still
 * what the session saw? It re-reads each item's page, re-applies the
 * delivery-time transforms, re-hashes with the one digest encoding, and
 * reports per item MATCH / CHANGED / NOT AVAILABLE - read-only, no new
 * capture machinery, no persistence.
 *
 * ## What a verdict is a claim about
 *
 * Delivered bytes, never liveness and never inferred. A retired note
 * verifies against its retired body: MATCH says the bytes are the same,
 * not that the memory is still live. Only an item carrying BOTH a path
 * and a text hash is verifiable; every other item reads as an honest
 * `unavailable` with a named reason - a structural id, a hashless item
 * and a `pre_compress` principle line (whose recorded text is not
 * re-derivable from the vault) are never guessed into a verdict.
 *
 * ## The projection
 *
 * The recorded hash covers the delivered text, not the file: the body
 * after frontmatter strip, after the context guard, after the
 * `applyCharBudget` cut when the item was delivered trimmed. The receipt
 * records what the re-derivation needs - `trimmed: true` and
 * `budget.max_chars_per_memory` - so the kernel re-applies exactly that
 * cut; without it, every trimmed item would silently false-CHANGED. Two
 * limits are stated rather than hidden: a receipt emitted while the
 * `untrusted_source_delimiting` guardrail was enabled recorded wrapped
 * text the recorded payload cannot describe, so those items report
 * CHANGED (the honest reading of bytes the projection cannot reproduce);
 * and the guard's default blocklist mode is re-run over the page's
 * current frontmatter, which is the faithful reproduction for receipts
 * the pack builders write.
 *
 * ## One hash, one resolution rule, never a throw
 *
 * Re-hashing calls `sha256Hex` from src/core/integrity/digest.ts - the
 * exact function the writer used; there is no second hashing path (the
 * context-pack-evidence doctrine). Paths resolve against the vault
 * defensively: the absolute host paths today's `context_pack` emitter
 * records and vault-relative spellings are both accepted, because the
 * receipt is data, not a contract about path spelling. A path that
 * escapes the vault maps to `unavailable(file_missing)` with a note -
 * never a traversal error - and no code path below throws.
 *
 * `session_inject` receipts carry no text by construction (the
 * active-inject hook records id, bytes and tokens only), so every item
 * is `unavailable(no_hash)` and the result header says
 * `sessionInjected` - the manifest half exists, the re-hash half is out
 * of scope by construction, and the result says so instead of pretending.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { sha256Hex } from "../integrity/digest.ts";
import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { parseFrontmatterWithNotices } from "../vault.ts";
import { isContextReceiptTrigger, type ContextReceiptTrigger } from "./context-receipt-trigger.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import { applyCharBudget } from "./recall-budget.ts";
import { guardBrainContextSnippet } from "./safety/context-guard.ts";

/** The closed verdict vocabulary of a receipt item verification. */
export const RECEIPT_VERIFY_VERDICT = Object.freeze({
  match: "match",
  changed: "changed",
  unavailable: "unavailable",
} as const);

export type ReceiptVerifyVerdict =
  (typeof RECEIPT_VERIFY_VERDICT)[keyof typeof RECEIPT_VERIFY_VERDICT];

/**
 * Why an item could not be re-verified at all. `no_hash` covers every
 * item whose delivered text left nothing to re-check (no recorded hash,
 * a structural id, a session-inject item, a pathless principle line);
 * `no_path` is the pathless-but-hashed item outside `pre_compress`;
 * `file_missing` and `unreadable` are the two ways a recorded path stops
 * answering.
 */
export const RECEIPT_VERIFY_UNAVAILABLE_REASON = Object.freeze({
  no_path: "no_path",
  no_hash: "no_hash",
  file_missing: "file_missing",
  unreadable: "unreadable",
} as const);

export type ReceiptVerifyUnavailableReason =
  (typeof RECEIPT_VERIFY_UNAVAILABLE_REASON)[keyof typeof RECEIPT_VERIFY_UNAVAILABLE_REASON];

/** One receipt item's verification outcome. */
export interface ReceiptItemVerification {
  readonly id: string;
  /** The path as the receipt recorded it, when it recorded one. */
  readonly path: string | null;
  readonly verdict: ReceiptVerifyVerdict;
  /** The digest the receipt recorded, when it recorded one. */
  readonly expectedHash: string | null;
  /** The re-computed digest; null whenever the item is unavailable. */
  readonly observedHash: string | null;
  readonly unavailableReason: ReceiptVerifyUnavailableReason | null;
  /**
   * Why an item is unavailable, or why a verdict could not be derived
   * the plain way. Always null on `match` and on a plain `changed`.
   */
  readonly note: string | null;
}

/** The verification of one whole receipt. */
export interface ReceiptVerification {
  readonly receiptId: string;
  readonly createdAt: string;
  readonly trigger: ContextReceiptTrigger;
  readonly sessionInjected: boolean;
  readonly items: ReadonlyArray<ReceiptItemVerification>;
  readonly counts: { match: number; changed: number; unavailable: number };
}

/** The item fields the verification reads, read defensively off the payload. */
interface ReceiptItemData {
  readonly id: string;
  readonly path: string | null;
  readonly expectedHash: string | null;
  readonly trimmed: boolean;
}

/**
 * Verify one context receipt against the vault it was drawn from.
 *
 * `receipt` is the stored `context_receipt` continuity record (as
 * `getContextReceipt` returns it). The walk is read-only and never
 * throws: every per-item failure mode lands in the closed
 * `unavailable` class with a note, so a hostile or stale receipt
 * degrades to an honest report instead of an error.
 */
export function verifyContextReceipt(
  vault: string,
  receipt: ContinuityRecord,
): ReceiptVerification {
  const payload = receipt.payload;
  const rawTrigger = payload["trigger"];
  const trigger: ContextReceiptTrigger = isContextReceiptTrigger(rawTrigger)
    ? rawTrigger
    : "context_pack";
  // An unreadable trigger means the delivery-time projection cannot be
  // chosen, so nothing on the receipt is verifiable; the per-item notes
  // carry that, and the counts stay honest.
  const triggerUnreadable = !isContextReceiptTrigger(rawTrigger);
  const sessionInjected = trigger === "session_inject";
  const maxCharsPerMemory = budgetMaxCharsPerMemory(payload["budget"]);
  const items = readReceiptItems(payload).map((item) =>
    verifyItem(vault, item, { trigger, triggerUnreadable, sessionInjected, maxCharsPerMemory }),
  );
  const counts = { match: 0, changed: 0, unavailable: 0 };
  for (const item of items) counts[item.verdict] += 1;
  return Object.freeze({
    receiptId: receipt.id,
    createdAt: receipt.createdAt,
    trigger,
    sessionInjected,
    items: Object.freeze(items),
    counts: Object.freeze(counts),
  });
}

/** Read the receipt's item list; entries without a readable id are skipped, as the fold skips them. */
function readReceiptItems(
  payload: Readonly<Record<string, unknown>>,
): ReadonlyArray<ReceiptItemData> {
  const stored = payload["items"];
  if (!Array.isArray(stored)) return [];
  const items: ReceiptItemData[] = [];
  for (const raw of stored) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = item["id"];
    if (typeof id !== "string" || id.length === 0) continue;
    const path = item["path"];
    const hash = item["text_hash"];
    items.push({
      id,
      path: typeof path === "string" && path.length > 0 ? path : null,
      expectedHash: typeof hash === "string" && hash.length > 0 ? hash : null,
      trimmed: item["trimmed"] === true,
    });
  }
  return items;
}

/** Everything {@link verifyItem} needs beside the item itself. */
interface VerifyEnvironment {
  readonly trigger: ContextReceiptTrigger;
  readonly triggerUnreadable: boolean;
  readonly sessionInjected: boolean;
  readonly maxCharsPerMemory: number | null;
}

function verifyItem(
  vault: string,
  item: ReceiptItemData,
  env: VerifyEnvironment,
): ReceiptItemVerification {
  if (env.sessionInjected) {
    return unavailable(
      item,
      RECEIPT_VERIFY_UNAVAILABLE_REASON.no_hash,
      "session_inject receipts record id, bytes and tokens only, so there is no " +
        "delivered text to re-hash - not verifiable by construction",
    );
  }
  if (env.triggerUnreadable) {
    return unavailable(
      item,
      RECEIPT_VERIFY_UNAVAILABLE_REASON.no_hash,
      "the receipt's trigger is not a context-receipt trigger, so the " +
        "delivery-time projection cannot be chosen",
    );
  }
  if (item.expectedHash === null) {
    return unavailable(
      item,
      RECEIPT_VERIFY_UNAVAILABLE_REASON.no_hash,
      "the item records no text hash, so there is nothing to re-check",
    );
  }
  if (item.path === null) {
    if (env.trigger === "pre_compress") {
      return unavailable(
        item,
        RECEIPT_VERIFY_UNAVAILABLE_REASON.no_hash,
        "the recorded text is a principle line, not vault content - no " +
          "projection re-derives it from the vault",
      );
    }
    return unavailable(
      item,
      RECEIPT_VERIFY_UNAVAILABLE_REASON.no_path,
      "the item records no path to re-read",
    );
  }

  // The receipt is data, not a contract about path spelling: accept the
  // absolute host paths today's emitter records and vault-relative
  // spellings alike, and map an escape to an honest unavailable.
  let absolute: string;
  try {
    absolute = ensureInsideVault(isAbsolute(item.path) ? item.path : join(vault, item.path), vault);
  } catch {
    return unavailable(
      item,
      RECEIPT_VERIFY_UNAVAILABLE_REASON.file_missing,
      "the recorded path does not resolve inside the vault, so it is not read",
    );
  }
  if (!existsSync(absolute)) {
    return unavailable(
      item,
      RECEIPT_VERIFY_UNAVAILABLE_REASON.file_missing,
      "the recorded path no longer exists in the vault",
    );
  }

  const [meta, body, notices] = parseFrontmatterWithNotices(absolute);
  if (notices.some((notice) => notice.code === DEGRADATION_CODE.frontmatterUnreadable)) {
    return unavailable(
      item,
      RECEIPT_VERIFY_UNAVAILABLE_REASON.unreadable,
      "the page could not be read",
    );
  }

  const projected = projectDeliveredText(item, body, meta, env.maxCharsPerMemory);
  const observedHash = sha256Hex(projected);
  const changed = observedHash !== item.expectedHash;
  return Object.freeze({
    id: item.id,
    path: item.path,
    verdict: changed ? RECEIPT_VERIFY_VERDICT.changed : RECEIPT_VERIFY_VERDICT.match,
    expectedHash: item.expectedHash,
    observedHash,
    unavailableReason: null,
    // A trimmed item whose receipt lost its budget block cannot have the
    // cut re-applied; the comparison still runs over the uncut body, and
    // a CHANGED there says exactly that instead of pretending precision.
    note:
      changed && item.trimmed && env.maxCharsPerMemory === null
        ? "the item is marked trimmed but the receipt records no " +
          "max_chars_per_memory, so the recorded cut cannot be re-applied"
        : null,
  });
}

/**
 * Re-derive the delivered text: the body after frontmatter strip, after
 * the context guard (with the page's current frontmatter as the guard
 * source, matching the pack builders), after the recorded budget cut
 * when the item was delivered trimmed.
 */
function projectDeliveredText(
  item: ReceiptItemData,
  body: string,
  meta: Readonly<Record<string, unknown>>,
  maxCharsPerMemory: number | null,
): string {
  const guarded = guardBrainContextSnippet(body, {
    source: { id: item.id, metadata: meta },
    ...(meta["context_safety"] === "trusted-instruction"
      ? { trust: "trusted-instruction" as const }
      : {}),
  });
  let text = guarded.safeText;
  if (item.trimmed && maxCharsPerMemory !== null) {
    text = applyCharBudget([{ item: item.id, text }], {
      maxCharsPerEntry: maxCharsPerMemory,
    }).kept[0]!.text;
  }
  return text;
}

/** The recorded per-memory char budget, when the receipt carries a usable one. */
function budgetMaxCharsPerMemory(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>)["max_chars_per_memory"];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/** The one unavailable outcome, with the reason and note that name it. */
function unavailable(
  item: ReceiptItemData,
  reason: ReceiptVerifyUnavailableReason,
  note: string,
): ReceiptItemVerification {
  return Object.freeze({
    id: item.id,
    path: item.path,
    verdict: RECEIPT_VERIFY_VERDICT.unavailable,
    expectedHash: item.expectedHash,
    observedHash: null,
    unavailableReason: reason,
    note,
  });
}

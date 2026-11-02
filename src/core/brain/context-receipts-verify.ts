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
 * The recorded hash covers the delivered text, not the file: for a
 * `context_pack` item, the body after frontmatter strip, after the
 * context guard, after the `applyCharBudget` cut when the item was
 * delivered trimmed; for a `pre_compress` item, the raw file the
 * pre-compress writer guarded (no frontmatter strip, no metadata, no
 * trust). The receipt records what the re-derivation needs - `trimmed:
 * true` and `budget.max_chars_per_memory` - so the kernel re-applies
 * exactly that cut; without it, every trimmed item would silently
 * false-CHANGED. The projection facts the receipt does not record (the
 * cut mode, the delimit guardrail) are re-derived from the vault's
 * current config - the same sources the pack builders read at emit time
 * - and a changed item whose verdict rode on a config-derived fact names
 * that sourcing in its note instead of pretending precision: a config
 * change since emit reads as changed, and the note says why.
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

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { sha256Hex } from "../integrity/digest.ts";
import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import { canonicalNotePath, ensureInsideVault } from "../path-safety.ts";
import { parseFrontmatterWithNotices } from "../vault.ts";
import { isContextReceiptTrigger, type ContextReceiptTrigger } from "./context-receipt-trigger.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import { loadBrainConfig, loadGuardrailsConfigSafe } from "./policy.ts";
import { dedupReplacementText } from "./context-transforms.ts";
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

/**
 * The membership lists, exported so the verdict-vocabulary census trio is
 * complete (values + members + guard) and a refusal can name the
 * vocabulary instead of restating it - the same rule
 * `DELIVERY_TREATMENTS` follows.
 */
export const RECEIPT_VERIFY_VERDICTS: ReadonlyArray<ReceiptVerifyVerdict> = Object.freeze(
  Object.values(RECEIPT_VERIFY_VERDICT) as ReceiptVerifyVerdict[],
);

export const RECEIPT_VERIFY_UNAVAILABLE_REASONS: ReadonlyArray<ReceiptVerifyUnavailableReason> =
  Object.freeze(
    Object.values(RECEIPT_VERIFY_UNAVAILABLE_REASON) as ReceiptVerifyUnavailableReason[],
  );

/** Takes `unknown`: a verdict can arrive from a persisted or wire payload. */
export function isReceiptVerifyVerdict(value: unknown): value is ReceiptVerifyVerdict {
  return (
    typeof value === "string" && (RECEIPT_VERIFY_VERDICTS as ReadonlyArray<string>).includes(value)
  );
}

/** Takes `unknown`: an unavailable reason can arrive from a wire payload. */
export function isReceiptVerifyUnavailableReason(
  value: unknown,
): value is ReceiptVerifyUnavailableReason {
  return (
    typeof value === "string" &&
    (RECEIPT_VERIFY_UNAVAILABLE_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The header marker for a receipt whose trigger is not a member of the
 * closed `ContextReceiptTrigger` vocabulary. The header never asserts a
 * trigger the receipt did not carry: `trigger` names the gap and
 * `triggerRaw` carries the receipt's own string value beside it, instead
 * of the old fallback literal claiming `context_pack`.
 */
export const RECEIPT_TRIGGER_UNKNOWN = "unknown";

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
  /**
   * The closed-vocabulary trigger the projection ran under, or the
   * unknown marker when the receipt's own trigger is not a member - the
   * header never asserts a trigger the receipt did not carry.
   */
  readonly trigger: ContextReceiptTrigger | typeof RECEIPT_TRIGGER_UNKNOWN;
  /**
   * The receipt's own trigger value when it was not a vocabulary member
   * (string raws only; a non-string raw has no honest value to carry and
   * reads as null beside the marker).
   */
  readonly triggerRaw: string | null;
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
  /** The first copy's id when the writer replaced this item's body (additive). */
  readonly dedupedFrom: string | null;
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
  const triggerKnown = isContextReceiptTrigger(rawTrigger);
  const trigger: ContextReceiptTrigger | typeof RECEIPT_TRIGGER_UNKNOWN = triggerKnown
    ? rawTrigger
    : RECEIPT_TRIGGER_UNKNOWN;
  // An unreadable trigger means the delivery-time projection cannot be
  // chosen, so nothing on the receipt is verifiable; the per-item notes
  // carry that, and the counts stay honest. The header answers with the
  // unknown marker and the raw value, never a vocabulary member the
  // receipt did not carry.
  const triggerUnreadable = !triggerKnown;
  const sessionInjected = triggerKnown && rawTrigger === "session_inject";
  const maxCharsPerMemory = budgetMaxCharsPerMemory(payload["budget"]);
  // The delivery-time projection facts the receipt does not record are
  // re-derived from the vault's current config - the same sources the
  // pack builders read at emit time - and a changed item names that
  // sourcing instead of pretending precision (see verifyItem).
  const degradation = resolveDegradation(vault, payload["budget"]);
  const delimitUntrusted = resolveDelimitUntrusted(vault);
  const items = readReceiptItems(payload).map((item) =>
    verifyItem(vault, item, {
      trigger,
      triggerUnreadable,
      sessionInjected,
      maxCharsPerMemory,
      degradation: degradation.mode,
      degradationFromConfig: degradation.fromConfig,
      delimitUntrusted,
    }),
  );
  const counts = { match: 0, changed: 0, unavailable: 0 };
  for (const item of items) counts[item.verdict] += 1;
  return Object.freeze({
    receiptId: receipt.id,
    createdAt: receipt.createdAt,
    trigger,
    triggerRaw:
      !triggerKnown && typeof rawTrigger === "string" && rawTrigger.length > 0 ? rawTrigger : null,
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
    const dedupedFrom = item["deduped_from"];
    items.push({
      id,
      path: typeof path === "string" && path.length > 0 ? path : null,
      expectedHash: typeof hash === "string" && hash.length > 0 ? hash : null,
      trimmed: item["trimmed"] === true,
      dedupedFrom: typeof dedupedFrom === "string" && dedupedFrom.length > 0 ? dedupedFrom : null,
    });
  }
  return items;
}

/** Everything {@link verifyItem} needs beside the item itself. */
interface VerifyEnvironment {
  readonly trigger: ContextReceiptTrigger | typeof RECEIPT_TRIGGER_UNKNOWN;
  readonly triggerUnreadable: boolean;
  readonly sessionInjected: boolean;
  readonly maxCharsPerMemory: number | null;
  /** The cut mode the re-applied budget uses; undefined is the default hard cut. */
  readonly degradation: "staged" | undefined;
  /** True when the cut mode had to be re-derived from the vault's current config. */
  readonly degradationFromConfig: boolean;
  /** The writer's delimit guardrail, re-derived from the vault's current config. */
  readonly delimitUntrusted: boolean;
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
  if (item.dedupedFrom !== null && env.trigger === "context_pack") {
    // The dedup transform replaced this item's delivered body with the
    // shared omission sentence naming the first copy: the delivered
    // bytes are synthetic, deterministic from the recorded id, and NOT
    // a projection of the page - so the re-derivation is the sentence
    // itself, and the page behind the FIRST copy is what that item's
    // own verification covers.
    const observedHash = sha256Hex(dedupReplacementText(item.dedupedFrom));
    return Object.freeze({
      id: item.id,
      path: item.path,
      verdict:
        observedHash === item.expectedHash
          ? RECEIPT_VERIFY_VERDICT.match
          : RECEIPT_VERIFY_VERDICT.changed,
      expectedHash: item.expectedHash,
      observedHash,
      unavailableReason: null,
      note: null,
    });
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

  let raw: string;
  let meta: Readonly<Record<string, unknown>>;
  let body: string;
  try {
    raw = readFileSync(absolute, "utf8");
    const parsed = parseFrontmatterWithNotices(absolute);
    meta = parsed[0];
    body = parsed[1];
    if (parsed[2].some((notice) => notice.code === DEGRADATION_CODE.frontmatterUnreadable)) {
      return unavailable(
        item,
        RECEIPT_VERIFY_UNAVAILABLE_REASON.unreadable,
        "the page could not be read",
      );
    }
  } catch {
    return unavailable(
      item,
      RECEIPT_VERIFY_UNAVAILABLE_REASON.unreadable,
      "the page could not be read",
    );
  }

  const projected =
    env.trigger === "pre_compress"
      ? projectPreCompressText(item, absolute, raw.trim(), env)
      : projectContextPackText(vault, item, absolute, body, meta, env);
  const observedHash = sha256Hex(projected);
  const changed = observedHash !== item.expectedHash;
  return Object.freeze({
    id: item.id,
    path: item.path,
    verdict: changed ? RECEIPT_VERIFY_VERDICT.changed : RECEIPT_VERIFY_VERDICT.match,
    expectedHash: item.expectedHash,
    observedHash,
    unavailableReason: null,
    // A verdict that could not be derived the plain way says exactly what
    // stood in the way instead of pretending precision: a trimmed item
    // whose receipt lost its budget block, and the projection facts that
    // had to be re-derived from the vault's current config because the
    // receipt records none.
    note: changedProjectionNote(item, env),
  });
}

/**
 * The note a changed verdict carries when the projection could not be
 * derived from recorded data alone. Null on a plain changed: an edit is
 * an edit, and a note on every one would bury the projection gaps.
 */
function changedProjectionNote(item: ReceiptItemData, env: VerifyEnvironment): string | null {
  const gaps: string[] = [];
  if (item.trimmed && env.maxCharsPerMemory === null) {
    gaps.push(
      "the item is marked trimmed but the receipt records no " +
        "max_chars_per_memory, so the recorded cut cannot be re-applied",
    );
  } else if (item.trimmed && env.degradationFromConfig) {
    gaps.push(
      "the receipt's budget block records no cut mode, so the staged cut " +
        "was re-derived from the vault's current config",
    );
  }
  if (env.delimitUntrusted && env.trigger !== "pre_compress") {
    gaps.push(
      "the untrusted-source delimiting guardrail was re-derived from the " +
        "vault's current config",
    );
  }
  if (gaps.length === 0) return null;
  return `${gaps.join("; ")} - a delivery-config change since emit reads as changed`;
}

/**
 * Re-derive the delivered text of a `context_pack` item: the body after
 * frontmatter strip, after the context guard with the page's current
 * frontmatter as the guard source (metadata and trust), path included,
 * and the delimit guardrail the vault's current config names - the same
 * guard call the context-pack builders make - then the recorded budget
 * cut when the item was delivered trimmed.
 */
function projectContextPackText(
  vault: string,
  item: ReceiptItemData,
  absolute: string,
  body: string,
  meta: Readonly<Record<string, unknown>>,
  env: VerifyEnvironment,
): string {
  const guarded = guardBrainContextSnippet(body, {
    source: { id: item.id, path: absolute, metadata: meta },
    ...(meta["context_safety"] === "trusted-instruction"
      ? { trust: "trusted-instruction" as const }
      : {}),
    ...(env.delimitUntrusted
      ? {
          delimitUntrusted: true,
          provenancePath: canonicalNotePath(relative(vault, absolute)),
        }
      : {}),
  });
  return cutToBudget(item, guarded.safeText, env);
}

/**
 * Re-derive the delivered text of a `pre_compress` item: the pre-compress
 * writer guards the WHOLE file - the raw file bytes, no frontmatter
 * strip - with source `{id, path}` and no metadata or trust, and never
 * passes the delimit guardrail. The projection reproduces exactly that,
 * so a frontmatter value that moved the writer's bytes moves the verdict
 * the same way instead of reading as a phantom change.
 */
function projectPreCompressText(
  item: ReceiptItemData,
  absolute: string,
  rawFile: string,
  env: VerifyEnvironment,
): string {
  const guarded = guardBrainContextSnippet(rawFile, {
    source: { id: item.id, path: absolute },
  });
  return cutToBudget(item, guarded.safeText, env);
}

/** The recorded budget cut, in the cut mode the writer used. */
function cutToBudget(item: ReceiptItemData, text: string, env: VerifyEnvironment): string {
  if (item.trimmed && env.maxCharsPerMemory !== null) {
    return applyCharBudget([{ item: item.id, text }], {
      maxCharsPerEntry: env.maxCharsPerMemory,
      ...(env.degradation !== undefined ? { degradation: env.degradation } : {}),
    }).kept[0]!.text;
  }
  return text;
}

/**
 * The cut mode the re-applied budget uses. A receipt whose budget block
 * records the mode (additive, forward-compatible) is honored verbatim;
 * otherwise the vault's current `recall.degradation` config is the only
 * source - the same source the pack builders read at emit time - and the
 * sourcing is reported so a changed trimmed item can name the gap.
 */
function resolveDegradation(
  vault: string,
  budget: unknown,
): { mode: "staged" | undefined; fromConfig: boolean } {
  if (typeof budget === "object" && budget !== null) {
    const recorded = (budget as Record<string, unknown>)["degradation"];
    if (recorded === "staged") return { mode: "staged", fromConfig: false };
  }
  try {
    return {
      mode: loadBrainConfig(vault).recall?.degradation === "staged" ? "staged" : undefined,
      fromConfig: true,
    };
  } catch {
    return { mode: undefined, fromConfig: true };
  }
}

/** The writer's delimit guardrail, read the way the pack builders read it. */
function resolveDelimitUntrusted(vault: string): boolean {
  try {
    return loadGuardrailsConfigSafe(vault).untrusted_source_delimiting === true;
  } catch {
    return false;
  }
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

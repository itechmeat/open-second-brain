/**
 * Decision-change receipts (Belief lifecycle suite, B4, t_3547314d).
 *
 * A `decision_change.v1` receipt is an append-only accountability record
 * emitted at the moment a belief changes: what it was (`before`), what it
 * became (`after`), the evidence that triggered the change, the
 * confidence delta, the alternatives considered, the actor, a rationale,
 * and a machine reason code. Receipts are append-only accountability, NOT
 * rollback (typed revertible history is a separate ADR wave, out of scope
 * here).
 *
 * Storage mirrors the truth ledger's shard discipline (`truth/store.ts`):
 * device-sharded append-only JSONL alongside the truth ledger shards
 * (`Brain/truth/decision-change[.<deviceId>].jsonl`), Syncthing-safe and
 * fail-closed per line. The claim reader ignores these shards (its regex
 * only matches `claims*.jsonl`), and this reader ignores claim shards.
 *
 * Durability + idempotency: the key is a sha256 of `subject + before +
 * after`, so replaying the same change is a no-op - the second append
 * finds the key already present and returns the existing receipt. The
 * schema is CLOSED: any field outside the accountable set (e.g. a hidden
 * free-text reasoning field) is rejected with a typed error. History is
 * queryable with an opaque cursor and exact counts. Reads never write.
 */

import { mkdirSync, appendFileSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { resolveDeviceId } from "../../config.ts";
import { appendLogEvent } from "../log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";

/** Schema tag stamped on every receipt line. */
export const DECISION_CHANGE_SCHEMA_VERSION = "decision_change.v1";

/**
 * Sentinel `before`/`after` state for a receipt whose belief did not
 * exist on that side of the change (a creation has no prior state). The
 * closed schema requires a non-empty string, so an absent state is this
 * explicit marker rather than the empty string.
 */
export const RECEIPT_ABSENT_STATE = "(absent)";

/**
 * Closed reason-code vocabulary for decision-record change receipts. A
 * decision mutation stamps exactly one of these so the change trail is
 * machine-filterable alongside the lifecycle codes (supersede/tombstone).
 */
export const DECISION_CHANGE_REASON = Object.freeze({
  record: "decision-record",
  outcome: "decision-outcome",
  rating: "decision-rating",
} as const);

/** Same canonical UTC shape the truth ledger and log writer emit. */
const ISO_UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** `decision-change.jsonl` or `decision-change.<deviceId>.jsonl`. */
const RECEIPT_SHARD_RE = /^decision-change(?:\.([a-z0-9-]{1,32}))?\.jsonl$/;

/** Cap on the length of any single string field (mirrors note-text caps). */
const FIELD_MAX_LEN = 2000;

/** Default page size for {@link queryDecisionChangeHistory}. */
export const DECISION_HISTORY_DEFAULT_LIMIT = 50;

/** Every failure path in this module raises this typed error. */
export class ReceiptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReceiptError";
  }
}

// ----- Shapes ---------------------------------------------------------------

export interface DecisionChangeReceipt {
  readonly v: typeof DECISION_CHANGE_SCHEMA_VERSION;
  readonly ts: string;
  /** Id/wikilink of the belief that changed. */
  readonly subject: string;
  /** Canonical before-state string. */
  readonly before: string;
  /** Canonical after-state string. */
  readonly after: string;
  /** Wikilinks/ids of the evidence that triggered the change. */
  readonly evidence_triggers: ReadonlyArray<string>;
  /** Confidence movement (after - before), or `null` when not applicable. */
  readonly confidence_delta: number | null;
  /** Alternatives considered but not chosen. */
  readonly alternatives: ReadonlyArray<string>;
  /** Agent/human who made the change. */
  readonly actor: string;
  /** Accountable justification (a permitted free-text field). */
  readonly rationale: string;
  /** Machine reason code (e.g. `supersede`, `tombstone`, `confidence-refresh`). */
  readonly reason_code: string;
  /** sha256(subject + before + after); replays are no-ops. */
  readonly idempotency_key: string;
}

export interface AppendReceiptInput {
  readonly subject: string;
  readonly before: string;
  readonly after: string;
  readonly evidenceTriggers?: ReadonlyArray<string>;
  readonly confidenceDelta?: number | null;
  readonly alternatives?: ReadonlyArray<string>;
  readonly actor: string;
  readonly rationale?: string;
  readonly reasonCode: string;
  /** ISO-8601 UTC instant; defaults to now. */
  readonly ts?: string;
  readonly configPath?: string;
}

export interface AppendReceiptResult {
  readonly appended: boolean;
  readonly path: string;
  readonly receipt: DecisionChangeReceipt;
}

/**
 * The closed set of accepted input keys. Any key outside this set is a
 * schema violation - this is what rejects a hidden free-text reasoning
 * field smuggled onto the input.
 */
const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set([
  "subject",
  "before",
  "after",
  "evidenceTriggers",
  "confidenceDelta",
  "alternatives",
  "actor",
  "rationale",
  "reasonCode",
  "ts",
  "configPath",
]);

// ----- Paths ----------------------------------------------------------------

/** Receipt shards live alongside the truth ledger shards. */
export function receiptsDir(vault: string): string {
  return join(vault, "Brain", "truth");
}

/** The receipt shard this device appends to. */
export function receiptShardPath(vault: string, configPath?: string): string {
  const deviceId = resolveDeviceId(configPath);
  const name = deviceId === "" ? "decision-change.jsonl" : `decision-change.${deviceId}.jsonl`;
  return join(receiptsDir(vault), name);
}

// ----- Validation -----------------------------------------------------------

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReceiptError(`receipt: ${label} is required`);
  }
  if (value.length > FIELD_MAX_LEN) {
    throw new ReceiptError(`receipt: ${label} exceeds ${FIELD_MAX_LEN} chars`);
  }
  return value.trim();
}

function optionalStringList(value: unknown, label: string): ReadonlyArray<string> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ReceiptError(`receipt: ${label} must be a list of strings`);
  }
  return value.map((v) => (v as string).trim()).filter((v) => v.length > 0);
}

function computeIdempotencyKey(subject: string, before: string, after: string): string {
  return createHash("sha256").update(`${subject}\n${before}\n${after}`, "utf8").digest("hex");
}

// ----- Append ---------------------------------------------------------------

/**
 * Validate and append one decision-change receipt. Idempotent: if a
 * receipt with the same `subject + before + after` key already exists,
 * this is a no-op returning the existing receipt with `appended: false`.
 */
export function appendDecisionChangeReceipt(
  vault: string,
  input: AppendReceiptInput,
): AppendReceiptResult {
  // Closed-schema gate: reject any unexpected field before doing anything.
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new ReceiptError(`receipt: unexpected field ${JSON.stringify(key)} is not permitted`);
    }
  }

  const subject = requireString(input.subject, "subject");
  const before = requireString(input.before, "before");
  const after = requireString(input.after, "after");
  const actor = requireString(input.actor, "actor");
  const reasonCode = requireString(input.reasonCode, "reasonCode");
  const rationale =
    input.rationale === undefined || input.rationale === null
      ? ""
      : requireString(input.rationale, "rationale");
  const evidenceTriggers = optionalStringList(input.evidenceTriggers, "evidenceTriggers");
  const alternatives = optionalStringList(input.alternatives, "alternatives");
  let confidenceDelta: number | null = null;
  if (input.confidenceDelta !== undefined && input.confidenceDelta !== null) {
    if (typeof input.confidenceDelta !== "number" || !Number.isFinite(input.confidenceDelta)) {
      throw new ReceiptError("receipt: confidenceDelta must be a finite number or null");
    }
    confidenceDelta = input.confidenceDelta;
  }
  const ts = input.ts ?? new Date().toISOString();
  if (!ISO_UTC_TS_RE.test(ts)) {
    throw new ReceiptError(`receipt: ts must be canonical ISO-8601 UTC: ${JSON.stringify(ts)}`);
  }

  const idempotencyKey = computeIdempotencyKey(subject, before, after);

  // Idempotency: a matching key already on disk makes this a no-op.
  const existing = readDecisionChangeReceipts(vault).receipts.find(
    (r) => r.idempotency_key === idempotencyKey,
  );
  if (existing) {
    return Object.freeze({
      appended: false,
      path: receiptShardPath(vault, input.configPath),
      receipt: existing,
    });
  }

  const receipt: DecisionChangeReceipt = Object.freeze({
    v: DECISION_CHANGE_SCHEMA_VERSION,
    ts,
    subject,
    before,
    after,
    evidence_triggers: Object.freeze([...evidenceTriggers]),
    confidence_delta: confidenceDelta,
    alternatives: Object.freeze([...alternatives]),
    actor,
    rationale,
    reason_code: reasonCode,
    idempotency_key: idempotencyKey,
  });

  mkdirSync(receiptsDir(vault), { recursive: true });
  const path = receiptShardPath(vault, input.configPath);
  appendFileSync(path, JSON.stringify(receipt) + "\n");
  // Surface the change in the merged activity timeline. Emitted only on an
  // actual append, never on an idempotent replay, so the log never
  // double-counts a change. Fail-soft: a log hiccup must not lose the receipt.
  try {
    appendLogEvent(vault, {
      timestamp: ts,
      eventType: BRAIN_LOG_EVENT_KIND.decisionChangeReceipt,
      body: {
        subject,
        reason_code: reasonCode,
        idempotency_key: idempotencyKey,
        agent: actor,
      },
    });
  } catch {
    // The JSONL receipt is authoritative; the timeline mirror is best-effort.
  }
  return Object.freeze({ appended: true, path, receipt });
}

// ----- Read -----------------------------------------------------------------

export interface ReceiptParseWarning {
  readonly path: string;
  readonly lineNumber: number;
  readonly message: string;
}

export interface ReadReceiptsResult {
  readonly receipts: ReadonlyArray<DecisionChangeReceipt>;
  readonly warnings: ReadonlyArray<ReceiptParseWarning>;
}

/**
 * Read every receipt merged across device shards, sorted by
 * (ts, shardId, line). Fail-closed per line: a malformed or
 * unknown-version line surfaces as a warning, never throws. Never writes.
 */
export function readDecisionChangeReceipts(vault: string): ReadReceiptsResult {
  const dir = receiptsDir(vault);
  let names: string[];
  try {
    names = readdirSync(dir).toSorted();
  } catch {
    return { receipts: [], warnings: [] };
  }

  interface Tagged {
    readonly receipt: DecisionChangeReceipt;
    readonly shardId: string;
    readonly line: number;
  }
  const tagged: Tagged[] = [];
  const warnings: ReceiptParseWarning[] = [];

  for (const name of names) {
    const m = RECEIPT_SHARD_RE.exec(name);
    if (!m) continue;
    const shardId = m[1] ?? "";
    if (shardId.startsWith("sync-conflict")) continue;
    const path = join(dir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      warnings.push({
        path,
        lineNumber: 0,
        message: `failed to read shard: ${(err as NodeJS.ErrnoException).message ?? String(err)}`,
      });
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        warnings.push({ path, lineNumber: i + 1, message: `malformed JSONL line` });
        continue;
      }
      const receipt = coerceReceipt(parsed, path, i + 1, warnings);
      if (receipt !== null) tagged.push({ receipt, shardId, line: i });
    }
  }

  tagged.sort((a, b) => {
    if (a.receipt.ts !== b.receipt.ts) return a.receipt.ts < b.receipt.ts ? -1 : 1;
    if (a.shardId !== b.shardId) return a.shardId < b.shardId ? -1 : 1;
    return a.line - b.line;
  });

  return { receipts: tagged.map((t) => t.receipt), warnings };
}

function coerceReceipt(
  parsed: unknown,
  path: string,
  lineNumber: number,
  warnings: ReceiptParseWarning[],
): DecisionChangeReceipt | null {
  if (typeof parsed !== "object" || parsed === null) {
    warnings.push({ path, lineNumber, message: "not an object" });
    return null;
  }
  const r = parsed as Record<string, unknown>;
  if (r["v"] !== DECISION_CHANGE_SCHEMA_VERSION) {
    warnings.push({ path, lineNumber, message: `unknown schema version ${String(r["v"])}` });
    return null;
  }
  if (
    typeof r["subject"] !== "string" ||
    typeof r["before"] !== "string" ||
    typeof r["after"] !== "string" ||
    typeof r["idempotency_key"] !== "string"
  ) {
    warnings.push({ path, lineNumber, message: "missing required field" });
    return null;
  }
  return Object.freeze({
    v: DECISION_CHANGE_SCHEMA_VERSION,
    ts: typeof r["ts"] === "string" ? r["ts"] : "",
    subject: r["subject"] as string,
    before: r["before"] as string,
    after: r["after"] as string,
    evidence_triggers: Array.isArray(r["evidence_triggers"])
      ? (r["evidence_triggers"] as string[]).filter((v) => typeof v === "string")
      : [],
    confidence_delta:
      typeof r["confidence_delta"] === "number" ? (r["confidence_delta"] as number) : null,
    alternatives: Array.isArray(r["alternatives"])
      ? (r["alternatives"] as string[]).filter((v) => typeof v === "string")
      : [],
    actor: typeof r["actor"] === "string" ? (r["actor"] as string) : "",
    rationale: typeof r["rationale"] === "string" ? (r["rationale"] as string) : "",
    reason_code: typeof r["reason_code"] === "string" ? (r["reason_code"] as string) : "",
    idempotency_key: r["idempotency_key"] as string,
  });
}

// ----- History query --------------------------------------------------------

export interface DecisionHistoryQuery {
  /** Filter to a single subject id/wikilink. */
  readonly subject?: string;
  /** Opaque cursor from a prior page's `nextCursor`. */
  readonly cursor?: string;
  /** Page size; defaults to {@link DECISION_HISTORY_DEFAULT_LIMIT}. */
  readonly limit?: number;
}

export interface DecisionHistoryPage {
  readonly receipts: ReadonlyArray<DecisionChangeReceipt>;
  /** Exact count of receipts matching the filter (across all pages). */
  readonly total: number;
  /** Opaque cursor for the next page, or `null` when exhausted. */
  readonly nextCursor: string | null;
}

/** Encode a numeric offset as an opaque cursor. */
function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

/** Decode an opaque cursor to its offset; rejects a malformed cursor. */
function decodeCursor(cursor: string): number {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ReceiptError("receipt: malformed cursor");
  }
  const m = /^o:(\d+)$/.exec(decoded);
  if (!m) throw new ReceiptError("receipt: malformed cursor");
  return Number.parseInt(m[1]!, 10);
}

/**
 * Paginated, subject-filterable history over the receipt log. Returns the
 * page, an opaque `nextCursor` (null when exhausted), and the exact total
 * matching the filter. Read-only: never appends.
 */
export function queryDecisionChangeHistory(
  vault: string,
  query: DecisionHistoryQuery,
): DecisionHistoryPage {
  const limit = query.limit ?? DECISION_HISTORY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ReceiptError("receipt: limit must be a positive integer");
  }
  const offset = query.cursor !== undefined ? decodeCursor(query.cursor) : 0;
  if (offset < 0) throw new ReceiptError("receipt: malformed cursor");

  const all = readDecisionChangeReceipts(vault).receipts;
  const matching =
    query.subject !== undefined ? all.filter((r) => r.subject === query.subject) : all;
  const total = matching.length;
  const page = matching.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : null;
  return Object.freeze({ receipts: page, total, nextCursor });
}

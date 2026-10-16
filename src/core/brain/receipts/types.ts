/**
 * Receipt-ledger vocabulary (storage-lifecycle, Lane 3).
 *
 * "Receipt compaction" is the operator-applied fold of the two
 * append-only receipt ledgers - the continuity log
 * (`Brain/log/continuity/`) and the metrics sink (`Brain/metrics/`) -
 * into per-kind-month aggregate lines. Every identifier here belongs to
 * THAT vocabulary and is deliberately disjoint from the Hermes
 * context-compaction one (`pre_compact_extract`, `post_compact_audit`,
 * `brain_pre_compact_extract`): a tool name, a continuity kind or a
 * doctor code that could be read as either would misdescribe a
 * destructive storage operation as a context operation, so the two never
 * share a surface name.
 *
 * The ledgers compaction targets are the record ledgers only. The
 * decision-change receipts (`Brain/truth/decision-change*.jsonl`) are
 * append-only accountability by their own contract and are not
 * inventoried, folded or rewritten by anything in this lane; the source
 * archive (`Brain/.archives/`) keeps its no-TTL evidence contract for
 * the same reason.
 */

import type { ContinuityRecordKind } from "../continuity/types.ts";

/** The two receipt-ledger families the scan inventories and the fold rewrites. */
export const RECEIPT_LEDGER_FAMILY = Object.freeze({
  continuity: "continuity",
  metrics: "metrics",
} as const);

/** Closed union over {@link RECEIPT_LEDGER_FAMILY}. */
export type ReceiptLedgerFamily =
  (typeof RECEIPT_LEDGER_FAMILY)[keyof typeof RECEIPT_LEDGER_FAMILY];

/** Every family, in report order. */
export const RECEIPT_LEDGER_FAMILIES: ReadonlyArray<ReceiptLedgerFamily> = Object.freeze([
  RECEIPT_LEDGER_FAMILY.continuity,
  RECEIPT_LEDGER_FAMILY.metrics,
]);

/** Narrow an unvalidated family id from a caller or the wire. */
export function isReceiptLedgerFamily(value: unknown): value is ReceiptLedgerFamily {
  return (
    typeof value === "string" && (RECEIPT_LEDGER_FAMILIES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The operation label every receipt-compaction surface reports. One
 * spelling, shared by the CLI verb, the MCP tool and the continuity
 * audit payload, so the storage operation names itself identically
 * everywhere and never under a context-compaction name.
 */
export const RECEIPT_COMPACTION_OPERATION = "receipt compaction";

/**
 * The two surface modes, shared by the CLI verb and the MCP tool so the
 * tool's input schema and the verb's usage line cannot disagree. `scan`
 * is the default and writes nothing; `compact` previews unless the
 * caller applies it, and never runs without explicit shard ids.
 */
export const RECEIPT_MODE = Object.freeze({
  scan: "scan",
  compact: "compact",
} as const);

/** Closed union over {@link RECEIPT_MODE}. */
export type ReceiptMode = (typeof RECEIPT_MODE)[keyof typeof RECEIPT_MODE];

/** Every mode, in surface order. */
export const RECEIPT_MODES: ReadonlyArray<ReceiptMode> = Object.freeze([
  RECEIPT_MODE.scan,
  RECEIPT_MODE.compact,
]);

/** Narrow an unvalidated mode from a CLI flag or a tool argument. */
export function isReceiptMode(value: unknown): value is ReceiptMode {
  return typeof value === "string" && (RECEIPT_MODES as ReadonlyArray<string>).includes(value);
}

/**
 * Parse one `family:name` shard reference as the surfaces spell it. The
 * same parser the shard-name grammar enforces, so a flag that names no
 * real shard is a usage error on both surfaces, before anything runs.
 */
export function parseReceiptShardRef(value: string): ReceiptShardRef {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`'${value}' is not a family:name shard reference`);
  }
  const family = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (!isReceiptLedgerFamily(family)) {
    throw new Error(
      `'${value}' names unknown ledger family '${family}'; expected one of: ` +
        RECEIPT_LEDGER_FAMILIES.join(", "),
    );
  }
  return Object.freeze({ family, name });
}

/**
 * The schema stamp on a fold aggregate line. A line carrying this stamp
 * is not a record: it is the per-(kind, month) summary the fold engine
 * replaced a run of expired records with. Both ledger readers tolerate
 * it by construction - the continuity read model drops a row without
 * `id`/`kind`/`createdAt` and the metrics reader skips a row without a
 * string `run_at` - so aggregates are inert bytes to every consumer.
 */
export const RECEIPT_FOLD_SCHEMA = "o2b.receipt-fold.v1";

/**
 * How old a record must be before it is foldable, when the caller names
 * no threshold. Thirty days: long enough that every live correlation
 * window has closed, short enough that a year of telemetry does not
 * accumulate first.
 */
export const RECEIPT_FOLD_DEFAULT_AGE_DAYS = 30;

/**
 * The continuity kinds a fold may aggregate once they are past the age
 * threshold: the PURE TELEMETRY kinds, whose readers derive aggregate
 * statistics read-side (summarize/list/roll-up surfaces) and keep no
 * per-record identity past the correlation window. The list is CLOSED on
 * purpose - folding is opt-in per kind, and a kind that is not listed
 * here fails closed to keep, including every kind a future build adds
 * before it makes its fold decision. The census test
 * (`tests/core/brain/receipts-scan.test.ts`) fails when a new continuity
 * kind lands in the vocabulary without joining one of the two lists
 * below.
 */
export const FOLDABLE_CONTINUITY_KINDS: ReadonlyArray<ContinuityRecordKind> = Object.freeze([
  "recall_telemetry",
  "gate_telemetry",
  "ingest_dedup",
  "mcp_route_latency",
  "token_impact",
  "token_impact_outcome",
  "context_pack_outcome",
  "context_pack_evidence",
  "skill_invoked",
  "decision_model_call",
  "decision_model_extract_commit",
]);

/**
 * The continuity kinds the fold must NEVER touch, whatever their age -
 * every kind whose records are read back as data rather than aggregated
 * as telemetry, each named beside the reader that would lose it:
 *
 *   - `source_invalidation` - the deleteBySource audit trail;
 *   - `pre_compact_extract` / `post_compact_audit` - the Hermes
 *     context-compaction receipts, which a storage fold must not rewrite
 *     under a colliding name;
 *   - `context_receipt` - looked up by id (`getContextReceipt`) and read
 *     by the stale-dependency check;
 *   - `session_turn` / `recent_turn` / `session_summary_node` /
 *     `session_summary_digest` - the session read models; the
 *     `recent_turn` sequence derives from the row count itself, so a
 *     fold would restart it;
 *   - `generation_report` - listed, filtered and joined as a read model;
 *   - `host_memory_write` - the durable record of a host memory write;
 *   - `session_entity_mention` - the cross-session entity index the
 *     session-recall seed, the hallways pass and the mining dedupe seed
 *     read back (its payload carries `session_ref`, so the clip-key rule
 *     never protected it);
 *   - `recall_observed_use` - read back as data, never aggregated: the
 *     lifetime observed-reuse rate the search ranking consumes unfiltered
 *     (`observedReuseRates`, folded per artifact by the candidate-signals
 *     collector into every ranking that runs) and the dead-weight
 *     report's per-source roll-up both read the rows; a fold past the
 *     cutoff would replace old verdicts with an aggregate line every
 *     reader drops, silently decaying a live ranking input;
 *   - `negative_recall` - the answer-audit trail its own vocabulary entry
 *     declares: the record exists so the corpus statement a "no" rested
 *     on stays auditable after the answer has been given, which is
 *     per-record identity past any correlation window; a fold would
 *     destroy exactly that auditability;
 *   - `receipt_compaction` - the compaction audit trail itself; a fold
 *     that removed the record of the run before it would erase the only
 *     account of what the fold has already destroyed.
 */
export const KEPT_CONTINUITY_KINDS: ReadonlyArray<ContinuityRecordKind> = Object.freeze([
  "source_invalidation",
  "pre_compact_extract",
  "post_compact_audit",
  "context_receipt",
  "session_turn",
  "recent_turn",
  "session_summary_node",
  "session_summary_digest",
  "generation_report",
  "host_memory_write",
  "session_entity_mention",
  "recall_observed_use",
  "negative_recall",
  "receipt_compaction",
]);

/** One shard selected for compaction, as a scan reported it. */
export interface ReceiptShardRef {
  readonly family: ReceiptLedgerFamily;
  /** Shard file name within its ledger directory, as the scan spelled it. */
  readonly name: string;
}

/** The `family:name` spelling used in match lists, error rows and CLI flags. */
export function receiptShardRefId(ref: ReceiptShardRef): string {
  return `${ref.family}:${ref.name}`;
}

/** Per-shard inventory row of a receipt scan. */
export interface ReceiptShardScan {
  readonly family: ReceiptLedgerFamily;
  /** Shard file name within its ledger directory. */
  readonly name: string;
  /** Vault-relative POSIX path of the shard file. */
  readonly path: string;
  /** Ledger base: the UTC month for continuity, the surface for metrics. */
  readonly base: string;
  /** Empty string for the legacy un-sharded file. */
  readonly shardId: string;
  /** Shard file size in bytes. */
  readonly bytes: number;
  /** Parsed record lines: foldable + protected + young. */
  readonly records: number;
  /** Records older than the threshold and in no protected class. */
  readonly foldable: number;
  /** Records the fold must keep whatever their age (see the module header). */
  readonly protectedRecords: number;
  /** Aggregate lines already present from an earlier fold. */
  readonly aggregates: number;
  /** Lines that parsed as neither a record nor an aggregate. */
  readonly unparseable: number;
}

/** Roll-up of a scan over every shard it inventoried. */
export interface ReceiptScanTotals {
  readonly shards: number;
  readonly records: number;
  readonly bytes: number;
  readonly foldable: number;
  readonly protectedRecords: number;
  readonly aggregates: number;
  readonly unparseable: number;
}

/** One shard the scan could not read, collected instead of thrown. */
export interface ReceiptScanError {
  /** The `family:name` spelling of the shard. */
  readonly shard: string;
  /** Vault-relative POSIX path of the shard file. */
  readonly path: string;
  readonly message: string;
}

/** The scan result: the fold engine's preview and the doctor's input. */
export interface ReceiptScanReport {
  /** Canonical UTC instant the scan stamped, second precision. */
  readonly generated_at: string;
  /** The age threshold the scan applied. */
  readonly olderThanDays: number;
  /** Records at or after this instant are kept; before it, foldable. */
  readonly cutoff: string;
  readonly shards: ReadonlyArray<ReceiptShardScan>;
  readonly totals: ReceiptScanTotals;
  readonly errors: ReadonlyArray<ReceiptScanError>;
}

/**
 * Receipt-ledger scan (storage-lifecycle, Lane 3 task 3.1).
 *
 * The preview half of receipt compaction: inventory every shard of the
 * two append-only receipt ledgers - the continuity log and the metrics
 * sink - and count, per shard, the records old enough to fold, the
 * records in a protected class the fold must never touch, and the lines
 * that are neither. The scan is a PURE READ: it writes nothing, so a
 * scan can be handed to an operator (and to the count guard) as the
 * exact statement of what a confirmed fold would touch.
 *
 * Protected classes, never foldable whatever their age:
 *
 *   - `source_invalidation` - the deleteBySource audit trail;
 *   - `pre_compact_extract` / `post_compact_audit` - the Hermes
 *     context-compaction receipts, which a storage fold must not
 *     rewrite under a colliding name;
 *   - any record whose payload carries one of
 *     {@link CLIP_PROTECTED_PAYLOAD_KEYS} - folding would destroy the
 *     session/agent correlation the clip rule guarantees survives;
 *   - any continuity kind this build does not know - a newer build's
 *     records are not this build's to fold (fail closed to keep);
 *   - any record whose timestamp cannot be compared (fail closed).
 *
 * Ledger rewrites happen only in `compact.ts`; this module never binds a
 * write primitive.
 */

import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { continuityLogDir, isCanonicalUtcTimestamp } from "../continuity/store.ts";
import { CLIP_PROTECTED_PAYLOAD_KEYS, isContinuityRecordKind } from "../continuity/types.ts";
import {
  JSONL_LEDGER_EXT,
  listShardedFiles,
  parseShardedName,
  type LedgerShardGrammar,
} from "../ledger-shards.ts";
import { metricsDir } from "../metrics.ts";
import { toPosix } from "../../path-safety.ts";
import {
  PROTECTED_CONTINUITY_KINDS,
  RECEIPT_FOLD_DEFAULT_AGE_DAYS,
  RECEIPT_FOLD_SCHEMA,
  RECEIPT_LEDGER_FAMILIES,
  RECEIPT_LEDGER_FAMILY,
  receiptShardRefId,
  type ReceiptLedgerFamily,
  type ReceiptScanError,
  type ReceiptScanReport,
  type ReceiptShardRef,
  type ReceiptShardScan,
} from "./types.ts";

/** File-name layout of the continuity ledger: one month per shard. */
const CONTINUITY_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: "\\d{4}-\\d{2}",
  extensions: Object.freeze([JSONL_LEDGER_EXT]),
});

/**
 * File-name layout of the metrics ledger: one surface per shard family.
 * The base shape is the documented metric-surface contract
 * (`[a-z][a-z0-9_]{0,63}`), spelled here because the metrics module
 * keeps its own grammars private.
 */
const METRICS_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: "[a-z][a-z0-9_]{0,63}",
  extensions: Object.freeze([JSONL_LEDGER_EXT]),
});

const MS_PER_DAY = 86_400_000;

/**
 * The message a shard read failure carries to every surface, whatever
 * `errno` the read failed with. The raw Node error text names absolute
 * host paths and distinguishes a missing shard from a denied one - a
 * map home and an absent/withheld oracle no caller should hold - so the
 * boundary reports the one class an operator can act on: the shard is
 * unreadable, and its identity travels beside the verdict, never the
 * filesystem's account of why.
 */
export const RECEIPT_SHARD_UNREADABLE = "unreadable";

/** ISO-8601 UTC timestamp shape, the one the metrics ledger writes. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** How a ledger line classifies against the fold age and the protected classes. */
export type ReceiptLineClass = "foldable" | "protected" | "young";

/** True when `payload` carries any clip-protected correlation key. */
export function payloadCarriesProtectedKey(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  return CLIP_PROTECTED_PAYLOAD_KEYS.some((key) => Object.hasOwn(payload, key));
}

/**
 * Classify one continuity record against the cutoff. Unknown kinds,
 * protected kinds, protected-key carriers and uncompared timestamps are
 * protected (fail closed); canonical timestamps at or after the cutoff
 * are young; everything else is foldable. Every field is optional: a
 * line missing one classifies through the same guards and fails closed.
 */
export function classifyContinuityRecord(
  record: { readonly kind?: unknown; readonly createdAt?: unknown; readonly payload?: unknown },
  cutoffMs: number,
): ReceiptLineClass {
  if (!isContinuityRecordKind(record.kind)) return "protected";
  if ((PROTECTED_CONTINUITY_KINDS as ReadonlyArray<string>).includes(record.kind)) {
    return "protected";
  }
  if (payloadCarriesProtectedKey(record.payload)) return "protected";
  if (typeof record.createdAt !== "string" || !isCanonicalUtcTimestamp(record.createdAt)) {
    return "protected";
  }
  return Date.parse(record.createdAt) >= cutoffMs ? "young" : "foldable";
}

/**
 * The record shape the metrics classification folds: the schema and
 * surface stamps as strings, a `run_at` string to derive the aggregate's
 * month from, and a payload that is a plain object. One predicate serves
 * both classifiers - the scan counts a parsed line outside this shape as
 * unparseable, and {@link classifyMetricRecord} fails closed to keep on
 * it - so the preview and the fold engine can never disagree about which
 * lines a confirmed fold would touch.
 */
export function metricRecordShaped(record: {
  readonly schema?: unknown;
  readonly surface?: unknown;
  readonly run_at?: unknown;
  readonly payload?: unknown;
}): record is {
  readonly schema: string;
  readonly surface: string;
  readonly run_at: string;
  readonly payload: Record<string, unknown>;
} {
  return (
    typeof record.schema === "string" &&
    typeof record.surface === "string" &&
    typeof record.run_at === "string" &&
    record.payload !== null &&
    typeof record.payload === "object" &&
    !Array.isArray(record.payload)
  );
}

/**
 * Classify one metrics record against the cutoff. A line outside the
 * {@link metricRecordShaped} record shape never folds - its aggregate
 * would carry no surface - and fails closed to keep, the same verdict the
 * scan reports it under. The same protected-key rule applies - a metrics
 * payload can correlate to a session too - and a `run_at` that is not an
 * ISO-8601 UTC stamp never folds: its month cannot be derived for the
 * aggregate, so it fails closed to keep.
 */
export function classifyMetricRecord(
  record: {
    readonly schema?: unknown;
    readonly surface?: unknown;
    readonly run_at?: unknown;
    readonly payload?: unknown;
  },
  cutoffMs: number,
): ReceiptLineClass {
  if (!metricRecordShaped(record)) return "protected";
  if (payloadCarriesProtectedKey(record.payload)) return "protected";
  if (!ISO_UTC_RE.test(record.run_at)) return "protected";
  return Date.parse(record.run_at) >= cutoffMs ? "young" : "foldable";
}

/** True when a parsed line is a fold aggregate stamped by this schema. */
export function isFoldAggregateLine(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return (
    record["schema"] === RECEIPT_FOLD_SCHEMA &&
    typeof record["fold"] === "object" &&
    record["fold"] !== null
  );
}

/** The ledger directory a family's shards live in. */
export function receiptLedgerDir(vault: string, family: ReceiptLedgerFamily): string {
  return family === RECEIPT_LEDGER_FAMILY.continuity ? continuityLogDir(vault) : metricsDir(vault);
}

/** The name grammar a family's shards follow. */
function familyGrammar(family: ReceiptLedgerFamily): LedgerShardGrammar {
  return family === RECEIPT_LEDGER_FAMILY.continuity ? CONTINUITY_GRAMMAR : METRICS_GRAMMAR;
}

/**
 * Resolve one shard ref to its file through the family's name grammar.
 * A name the grammar does not recognise - a typo, a path traversal, a
 * sync-conflict copy - is a named caller error before anything is read
 * or written.
 */
export function resolveReceiptShardPath(
  vault: string,
  ref: ReceiptShardRef,
): { readonly path: string; readonly base: string; readonly shardId: string } {
  const parsed = parseShardedName(ref.name, familyGrammar(ref.family));
  if (parsed === null) {
    throw new Error(`'${ref.name}' is not a ${ref.family} shard name`);
  }
  return {
    path: join(receiptLedgerDir(vault, ref.family), ref.name),
    base: parsed.base,
    shardId: parsed.shardId,
  };
}

/** Canonical UTC second-precision stamp, the shape every ledger compares. */
export function canonicalSecond(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

/** Parse one shard's non-blank lines into raw line texts. */
function readRawLines(text: string): ReadonlyArray<string> {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** One shard's counts against the cutoff. */
function scanShard(
  vault: string,
  family: ReceiptLedgerFamily,
  shard: {
    readonly name: string;
    readonly path: string;
    readonly base: string;
    readonly shardId: string;
  },
  cutoffMs: number,
): { row: ReceiptShardScan } | { error: ReceiptScanError } {
  const ref = receiptShardRefId({ family, name: shard.name });
  let text: string;
  let bytes: number;
  try {
    text = readShardText(shard.path);
    bytes = statSync(shard.path).size;
  } catch {
    return {
      error: {
        shard: ref,
        path: toPosix(relative(vault, shard.path)),
        message: RECEIPT_SHARD_UNREADABLE,
      },
    };
  }
  let records = 0;
  let foldable = 0;
  let protectedRecords = 0;
  let aggregates = 0;
  let unparseable = 0;
  for (const line of readRawLines(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unparseable += 1;
      continue;
    }
    if (isFoldAggregateLine(parsed)) {
      aggregates += 1;
      continue;
    }
    if (family === RECEIPT_LEDGER_FAMILY.continuity) {
      const record = parsed as {
        readonly kind?: unknown;
        readonly createdAt?: unknown;
        readonly payload?: unknown;
      };
      if (typeof record.kind !== "string" || typeof record.createdAt !== "string") {
        unparseable += 1;
        continue;
      }
      records += 1;
      const classification = classifyContinuityRecord(record, cutoffMs);
      if (classification === "foldable") foldable += 1;
      else if (classification === "protected") protectedRecords += 1;
      continue;
    }
    const record = parsed as {
      readonly schema?: unknown;
      readonly surface?: unknown;
      readonly run_at?: unknown;
      readonly payload?: unknown;
    };
    if (!metricRecordShaped(record)) {
      unparseable += 1;
      continue;
    }
    records += 1;
    const classification = classifyMetricRecord(record, cutoffMs);
    if (classification === "foldable") foldable += 1;
    else if (classification === "protected") protectedRecords += 1;
  }
  return {
    row: Object.freeze({
      family,
      name: shard.name,
      path: toPosix(relative(vault, shard.path)),
      base: shard.base,
      shardId: shard.shardId,
      bytes,
      records,
      foldable,
      protectedRecords,
      aggregates,
      unparseable,
    }),
  };
}

function readShardText(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Inventory every shard of both receipt ledgers. Read-only, fail-soft
 * per shard: a shard that cannot be read is an error row naming it, and
 * the rest of the inventory is still returned.
 */
export function scanReceiptLedgers(
  vault: string,
  opts: { readonly olderThanDays?: number; readonly now?: Date } = {},
): ReceiptScanReport {
  const olderThanDays = opts.olderThanDays ?? RECEIPT_FOLD_DEFAULT_AGE_DAYS;
  const nowMs = (opts.now ?? new Date()).getTime();
  const cutoffMs = nowMs - olderThanDays * MS_PER_DAY;
  const cutoff = canonicalSecond(cutoffMs);
  const shards: ReceiptShardScan[] = [];
  const errors: ReceiptScanError[] = [];
  for (const family of RECEIPT_LEDGER_FAMILIES) {
    for (const shard of listShardedFiles(receiptLedgerDir(vault, family), familyGrammar(family))) {
      const result = scanShard(vault, family, shard, cutoffMs);
      if ("error" in result) errors.push(result.error);
      else shards.push(result.row);
    }
  }
  const totals = Object.freeze({
    shards: shards.length,
    records: sum(shards, (s) => s.records),
    bytes: sum(shards, (s) => s.bytes),
    foldable: sum(shards, (s) => s.foldable),
    protectedRecords: sum(shards, (s) => s.protectedRecords),
    aggregates: sum(shards, (s) => s.aggregates),
    unparseable: sum(shards, (s) => s.unparseable),
  });
  return Object.freeze({
    generated_at: canonicalSecond(nowMs),
    olderThanDays,
    cutoff,
    shards: Object.freeze(shards),
    totals,
    errors: Object.freeze(errors),
  });
}

function sum(
  rows: ReadonlyArray<ReceiptShardScan>,
  pick: (row: ReceiptShardScan) => number,
): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

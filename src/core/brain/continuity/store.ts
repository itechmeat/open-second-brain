import { legacyVaultOf } from "../no-vault.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { originChannelStamp } from "../../origin-channel.ts";
import {
  listShardedFiles,
  mergeShardedRows,
  resolveAppendShardId,
  shardedFileName,
  type LedgerShardGrammar,
  type ShardedRow,
} from "../ledger-shards.ts";
import { BRAIN_LOG_REL, ensureInsideVault } from "../paths.ts";
import { acquireLockSync } from "../sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { safeContinuityPayload } from "./redaction.ts";
import { CLIP_PROTECTED_PAYLOAD_KEYS, CONTINUITY_SCHEMA_VERSION } from "./types.ts";
import type {
  AppendContinuityRecordInput,
  ContinuityRecord,
  ContinuityRecordFilter,
  ContinuityRecordKind,
  ContinuityRecordPage,
  ContinuitySourceRef,
} from "./types.ts";
import type { DualWriteRecord } from "../../store/dual-write.ts";
import { readLedgerRows } from "../../store/read/ledger-rows.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { routeWrite, storeWrite } from "../../store/store-write.ts";
import { DUAL_WRITE_LEDGERS, ledgerRowRecord } from "../../store/dual-write-records.ts";
import { type RowPrivacyJudge, rowPrivacyJudge } from "../../store/reference-privacy.ts";

export type {
  AppendContinuityRecordInput,
  ContinuityPayload,
  ContinuityRecord,
  ContinuityRecordFilter,
  ContinuityRecordKind,
  ContinuityRecordPage,
  ContinuitySourceRef,
} from "./types.ts";

export interface AppendSourceInvalidationInput {
  readonly createdAt: string;
  readonly source: ContinuitySourceRef;
  readonly reason: string;
}

export interface ContinuityPaginationOptions extends ContinuityRecordFilter {
  readonly limit: number;
  readonly cursor?: string;
}

const CONTINUITY_REL = `${BRAIN_LOG_REL}/continuity`;
const CURSOR_PREFIX = "offset:";

/** Shard base: one file per UTC month. */
const MONTH_RE = /^\d{4}-\d{2}$/;
const CONTINUITY_EXT = "jsonl";

/**
 * The ledger's file-name layout, handed to the shared shard grammar.
 * The base is the month, so a sharded name still yields the month the
 * `since`/`until` range-skip below tests without re-parsing the name.
 */
export const CONTINUITY_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: "\\d{4}-\\d{2}",
  extensions: Object.freeze([CONTINUITY_EXT]),
});

/**
 * Canonical UTC ISO-8601 shape: `YYYY-MM-DDTHH:MM:SS[.sss]Z`. A trailing
 * `Z` is mandatory — a numeric offset (`+03:00`) is rejected so every
 * stored `createdAt` sorts and filters lexically against its siblings
 * (readers compare the strings directly) and shards into the correct UTC
 * month. Fractional seconds are optional (0–3 digits) to accept both the
 * second-precision and `toISOString()` millisecond forms already on disk.
 */
const CANONICAL_UTC_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/**
 * True when `value` is a canonical UTC timestamp with a real calendar
 * date/time. The regex enforces the `…Z` shape; the round-trip check
 * rejects out-of-range fields that `Date` silently rolls over (e.g.
 * `2026-02-30` → Mar 2, `2026-13-…` → NaN), so `2026-13-01T00:00:00Z`
 * and `2026-02-30T00:00:00Z` are both caught.
 */
export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CANONICAL_UTC_TIMESTAMP_RE.exec(value);
  if (match === null) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  const date = new Date(ms);
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6])
  );
}

/**
 * Guard every record's `createdAt` at the store boundary. Throws on any
 * non-canonical value so a malformed timestamp can never reach disk as a
 * junk shard (`2026-13.jsonl`) or a local-time record that mis-sorts
 * against the fleet of `Z` timestamps. All append paths funnel through
 * `buildRecord`, so this is the single choke point.
 */
export function assertCanonicalCreatedAt(createdAt: unknown): string {
  if (!isCanonicalUtcTimestamp(createdAt)) {
    throw new Error(
      `invalid continuity createdAt: expected a canonical UTC ISO-8601 timestamp ` +
        `(YYYY-MM-DDTHH:MM:SS[.sss]Z with a real calendar date), got ${JSON.stringify(createdAt)}`,
    );
  }
  return createdAt;
}

/**
 * The directory every continuity shard lives in. Exported so the sweep
 * that reports Syncthing conflict copies names this ledger's directory
 * through the module that owns it, rather than re-deriving the path.
 */
export function continuityLogDir(vault: string): string {
  return ensureInsideVault(join(vault, CONTINUITY_REL), vault);
}

/**
 * One month's shard for one device: `<month>[.<shardId>].jsonl`.
 *
 * `shardId` defaults to this device's id, so an append lands in a file no
 * other device writes and Syncthing never has two versions of one month
 * to reconcile. The empty shard id is the legacy un-sharded name, which
 * every reader still merges and no migration renames - a vault whose
 * device id resolves empty keeps writing exactly the file it always did.
 */
export function continuityLogPath(
  vault: string,
  month: string,
  shardId: string = resolveAppendShardId(),
): string {
  if (!MONTH_RE.test(month)) throw new Error(`invalid continuity month: ${month}`);
  return ensureInsideVault(
    join(vault, CONTINUITY_REL, shardedFileName(month, shardId, CONTINUITY_EXT)),
    vault,
  );
}

export function appendContinuityRecord(
  vault: string | null,
  input: AppendContinuityRecordInput,
): ContinuityRecord {
  return appendRecord(vault, buildContinuityRecord(input));
}

/**
 * Build the exact continuity record {@link appendContinuityRecord} would
 * persist, WITHOUT touching disk. Same validation, payload sanitisation,
 * and dedup id as the append path — so a caller can preview a record and
 * trust it byte-for-byte predicts the real write. Used by the dry-run
 * extraction preview (C2 / t_2c6cf3e2).
 */
export function buildContinuityRecord(input: AppendContinuityRecordInput): ContinuityRecord {
  return buildRecord(input);
}

/**
 * Append a batch of continuity records atomically per month shard.
 *
 * Every record is built and validated (payload sanitised, shard month
 * resolved) BEFORE any write touches disk, so a malformed input aborts
 * the whole batch with zero writes — the on-disk log is left unchanged.
 *
 * Atomicity boundary: writes are grouped by month shard. A batch confined
 * to a single month (the common case) appends all its lines under ONE
 * lock acquisition and is fully atomic. A batch that spans multiple months
 * writes each month's shard independently under its own lock; we do NOT
 * guarantee cross-shard atomicity — if a later shard's append fails after
 * an earlier shard committed, the earlier shard stays written. All-or-
 * nothing is guaranteed only against validation failures (which happen
 * before any write) and within a single shard.
 */
export function appendContinuityRecords(
  vault: string | null,
  inputs: ReadonlyArray<AppendContinuityRecordInput>,
): ReadonlyArray<ContinuityRecord> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("appendContinuityRecords: inputs must be a non-empty array");
  }

  // Phase 1 — build + validate ALL records before any disk mutation.
  // buildRecord sanitises payloads; the month prefix is checked here, so a
  // malformed createdAt aborts the batch with nothing written.
  const built = inputs.map((input) => {
    const record = buildRecord(input);
    const month = record.createdAt.slice(0, 7);
    if (!MONTH_RE.test(month)) throw new Error(`invalid continuity month: ${month}`);
    return record;
  });

  // One privacy verdict for the whole batch, so every row of it lands in
  // one partition: `private` when any record is flagged private (a
  // `<private>` region was stripped, or the caller said so) or names a
  // page that is private or cannot be judged. A machine without `private`
  // then refuses the batch at its first row, before anything is appended.
  // The verdict is worked out when the first store record is built, and
  // only then: an unswitched machine with dual writes off writes no store
  // record, and judging every row of a large batch it never stores cost
  // milliseconds per record on the SessionStart path.
  let partition: "private" | "shared" | undefined;
  const rowsOf = (records: ReadonlyArray<ContinuityRecord>): DualWriteRecord[] => {
    if (partition === undefined) {
      const judge = rowPrivacyJudge(vault);
      partition = built.some((record) => continuityRecordIsPrivate(record, judge))
        ? "private"
        : "shared";
    }
    const verdict = partition;
    return records.map((record) => ledgerRowRecord(DUAL_WRITE_LEDGERS.continuity, record, verdict));
  };

  // A store-only machine (design D14 item 1) appends the whole batch as
  // `continuity` ledger rows in one store write; an unswitched one writes
  // its month shards.
  if (vault === null || isStoreOnly({ vault })) {
    storeWrite(() => rowsOf(built), { vault });
    return Object.freeze(built);
  }

  // Vault-identity write guard (context-integrity-gates, Unit J),
  // ahead of the phase-3 shard appends. Backs `brain_session_checkpoint`
  // and every telemetry writer that funnels through the continuity log.
  assertVaultIdentityForWrite(vault);

  // Phase 2 — group by shard path, preserving first-seen order.
  const shards = new Map<string, { path: string; records: ContinuityRecord[] }>();
  for (const record of built) {
    const path = continuityLogPath(vault, record.createdAt.slice(0, 7));
    let bucket = shards.get(path);
    if (!bucket) {
      bucket = { path, records: [] };
      shards.set(path, bucket);
    }
    bucket.records.push(record);
  }

  // Phase 3 — write each shard under a single lock acquisition, each
  // followed by its dual write (off by default, never fails this append).
  for (const { path, records } of shards.values()) {
    routeWrite({
      legacy: () => {
        mkdirSync(join(vault, CONTINUITY_REL), { recursive: true });
        const handle = acquireLockSync(path);
        try {
          const payload = records.map((record) => `${JSON.stringify(record)}\n`).join("");
          writeFileSync(path, payload, { encoding: "utf8", flag: "a" });
        } finally {
          handle.release();
        }
      },
      store: () => rowsOf(records),
      context: { vault },
    });
  }

  return Object.freeze(built);
}

export function appendContinuitySourceInvalidation(
  vault: string,
  input: AppendSourceInvalidationInput,
): ContinuityRecord {
  return appendRecord(
    vault,
    buildRecord({
      kind: "source_invalidation",
      createdAt: input.createdAt,
      sourceRefs: [input.source],
      payload: { reason: input.reason },
    }),
  );
}

/**
 * Clip a continuity payload to a character budget while guaranteeing the
 * protected identity keys survive (t_5be0654d). Non-protected keys are
 * dropped, in original order, only as far as needed to fit `budgetChars`;
 * the protected keys ({@link CLIP_PROTECTED_PAYLOAD_KEYS}) are ALWAYS
 * retained, even if they alone exceed the budget, so a clipped record
 * stays correlatable to its session and agent.
 *
 * Byte-identical when there is no budget pressure: an undefined or
 * non-finite budget, or a payload already within budget, returns the SAME
 * payload reference unchanged (no allocation, no reordering).
 */
export function clipPayloadToBudget(
  payload: Readonly<Record<string, unknown>>,
  budgetChars: number | undefined,
  protectedKeys: ReadonlyArray<string> = CLIP_PROTECTED_PAYLOAD_KEYS,
): Readonly<Record<string, unknown>> {
  if (budgetChars === undefined || !Number.isFinite(budgetChars)) return payload;
  if (JSON.stringify(payload).length <= budgetChars) return payload;

  const keys = Object.keys(payload);
  const protectedSet = new Set(protectedKeys);
  // Protected keys that actually exist are retained unconditionally.
  const included = new Set(keys.filter((key) => protectedSet.has(key)));
  const build = (chosen: ReadonlySet<string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (chosen.has(key)) out[key] = payload[key];
    return out;
  };
  // Greedily keep non-protected keys, in original order, while they fit.
  for (const key of keys) {
    if (included.has(key)) continue;
    const trial = new Set(included);
    trial.add(key);
    if (JSON.stringify(build(trial)).length <= budgetChars) included.add(key);
  }
  return Object.freeze(build(included));
}

export function listContinuityRecords(
  vault: string | null,
  filter: ContinuityRecordFilter = {},
): ReadonlyArray<ContinuityRecord> {
  return Object.freeze(readAllRecords(vault, filter).filter((record) => matches(record, filter)));
}

export function paginateContinuityRecords(
  vault: string,
  opts: ContinuityPaginationOptions,
): ContinuityRecordPage {
  const limit = Math.max(1, Math.floor(opts.limit));
  const start = parseCursor(opts.cursor);
  const filtered = listContinuityRecords(vault, opts);
  const records = filtered.slice(start, start + limit);
  const next = start + limit < filtered.length ? `${CURSOR_PREFIX}${start + limit}` : null;
  return Object.freeze({ records: Object.freeze(records), nextCursor: next });
}

function buildRecord(
  input:
    | AppendContinuityRecordInput
    | {
        readonly kind: "source_invalidation";
        readonly createdAt: string;
        readonly sourceRefs: ReadonlyArray<ContinuitySourceRef>;
        readonly payload: Readonly<Record<string, unknown>>;
      },
): ContinuityRecord {
  assertCanonicalCreatedAt(input.createdAt);
  const payloadResult = safeContinuityPayload(input.payload ?? {});
  const sourceRefs = Object.freeze([...(input.sourceRefs ?? [])]);
  // `schema` and `originChannel` both stay OUT of recordId(): identical
  // records must keep identical dedup ids across the version-stamp
  // transition, and across the channel that happened to append them.
  const id = recordId(input.kind, input.createdAt, sourceRefs, payloadResult.payload);
  return Object.freeze({
    schema: CONTINUITY_SCHEMA_VERSION,
    id,
    // Server-derived (Unit C), read off the module rather than the input:
    // AppendContinuityRecordInput has no channel field and must not grow
    // one. Distinct from the payload's `channel` key, which recall
    // telemetry uses for the transport a recall was DELIVERED over.
    originChannel: originChannelStamp(),
    kind: input.kind,
    createdAt: input.createdAt,
    sourceRefs,
    payload: payloadResult.payload,
    private: payloadResult.private || ("private" in input && input.private === true),
    redacted: payloadResult.redacted,
  });
}

function appendRecord(vault: string | null, record: ContinuityRecord): ContinuityRecord {
  // One `continuity` ledger row on a store-only machine (design D14 item
  // 1), the month shard plus the dual write otherwise.
  routeWrite({
    legacy: () => {
      // Vault-identity write guard (context-integrity-gates, Unit J). The
      // single-record funnel: guarding here covers every public entry point
      // that appends one record rather than a batch.
      const root = legacyVaultOf(vault, "appendContinuityRecord");
      assertVaultIdentityForWrite(root);
      const path = continuityLogPath(root, record.createdAt.slice(0, 7));
      mkdirSync(join(root, CONTINUITY_REL), { recursive: true });
      const handle = acquireLockSync(path);
      try {
        writeFileSync(path, `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          flag: "a",
        });
      } finally {
        handle.release();
      }
    },
    store: () => continuityRowRecord(vault, record),
    context: { vault },
  });
  return record;
}

/**
 * The store copy of a continuity record: `private` only when the record is
 * flagged private or its text names a page that is private or cannot be
 * judged; a turn that names nothing private goes to `shared`.
 */
export function continuityRowRecord(
  vault: string | null,
  record: ContinuityRecord,
): DualWriteRecord {
  return ledgerRowRecord(
    DUAL_WRITE_LEDGERS.continuity,
    record,
    continuityRecordIsPrivate(record, rowPrivacyJudge(vault)) ? "private" : "shared",
  );
}

/**
 * Whether one continuity record belongs in `private`: flagged private, or
 * its text names a page that is private or cannot be judged. The one rule
 * the single-record, batch and migration writers share.
 */
function continuityRecordIsPrivate(record: ContinuityRecord, judge: RowPrivacyJudge): boolean {
  return record.private === true || judge(record);
}

/**
 * Read every stored record across every device shard, optionally skipping
 * whole months that a `since`/`until` filter proves cannot contribute a
 * matching record.
 *
 * Shards are named `<month>[.<deviceId>].jsonl`, and the shared grammar
 * hands back the month as the parsed base - so the range-skip below tests
 * the month whether or not a device suffix is present. A month whose
 * shards sort strictly before `since`'s month can only hold records with
 * `createdAt < since` (rejected by {@link matches}); one strictly after
 * `until`'s month can only hold `createdAt > until`. Both are skipped
 * without opening the file. The boundary months are still read in full,
 * so the returned set is identical to reading everything and letting
 * `matches` filter - this only avoids reading files that would contribute
 * nothing. Grows the read cost with the queried window, not the whole
 * history.
 *
 * Order is (`createdAt`, shard id, `id`). The shard id is the tie-break
 * every device agrees on regardless of Syncthing arrival order; `id` is
 * the last resort, and because it is a content hash a single-shard vault
 * reads back in exactly the order it always did.
 */
function readAllRecords(
  vault: string | null,
  filter: ContinuityRecordFilter = {},
): ContinuityRecord[] {
  // A store-only machine reads the `continuity` ledger rows (design D14
  // item 1). Fold order is append order on every machine, so a stable sort
  // by `createdAt` gives the legacy order's meaning: time first, then the
  // order the rows were written in. The legacy read is already in that
  // order and is returned as it is.
  let legacy = false;
  const rows = readLedgerRows<unknown>(
    DUAL_WRITE_LEDGERS.continuity,
    (legacyVault) => {
      legacy = true;
      return readLegacyRecords(legacyVault, filter);
    },
    { vault },
  );
  if (legacy) return rows as ContinuityRecord[];
  // The store holds every month: drop the rows outside the asked window
  // before the sort, as the legacy read skips whole month shards.
  return rows
    .filter(isContinuityRow)
    .filter(
      (row) =>
        (filter.since === undefined || row.createdAt >= filter.since) &&
        (filter.until === undefined || row.createdAt <= filter.until),
    )
    .toSorted((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** Whether a store row has the fields every continuity reader relies on. */
function isContinuityRow(row: unknown): row is ContinuityRecord {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  const r = row as Partial<Record<keyof ContinuityRecord, unknown>>;
  return (
    typeof r.id === "string" &&
    typeof r.kind === "string" &&
    typeof r.createdAt === "string" &&
    Array.isArray(r.sourceRefs)
  );
}

function readLegacyRecords(vault: string, filter: ContinuityRecordFilter): ContinuityRecord[] {
  const dir = continuityLogDir(vault);
  const sinceMonth = filter.since ? filter.since.slice(0, 7) : undefined;
  const untilMonth = filter.until ? filter.until.slice(0, 7) : undefined;
  const rows: Array<ShardedRow<ContinuityRecord>> = [];
  for (const shard of listShardedFiles(dir, CONTINUITY_GRAMMAR)) {
    if (sinceMonth !== undefined && shard.base < sinceMonth) continue;
    if (untilMonth !== undefined && shard.base > untilMonth) continue;
    let text: string;
    try {
      text = readFileSync(ensureInsideVault(shard.path, vault), "utf8");
    } catch (err) {
      // A shard listed a moment ago and gone now (a concurrent prune, a
      // sync delete) contributes nothing and is skipped. Anything else -
      // EACCES, EIO - propagates: a shard silently dropped shortens the
      // history without saying so, and a caller cannot tell a short
      // history from a complete one.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    let line = 0;
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      // A line that parses but holds no record (a damaged or hand-edited
      // shard: `null`, a number, a wrong shape) is skipped like one that
      // does not parse, as the store read skips it.
      if (!isContinuityRow(value)) continue;
      rows.push({ value, shardId: shard.shardId, line });
      line++;
    }
  }
  // The append-only file is the authority when timestamps tie: rows the
  // same writer appended within one timestamp precision read in append
  // order, never in the arbitrary order of their content-hash ids (two
  // same-instant records hash to ids whose lexical order says nothing
  // about which was written first - "latest wins" reads would answer
  // randomly). Cross-shard ties still order by shard id below, because
  // two devices' arrival orders genuinely cannot be known.
  return mergeShardedRows(rows, (record) => record.createdAt);
}

function matches(record: ContinuityRecord, filter: ContinuityRecordFilter): boolean {
  if (filter.kind && record.kind !== filter.kind) return false;
  if (filter.sourceId && !record.sourceRefs.some((source) => source.id === filter.sourceId)) {
    return false;
  }
  if (filter.since && record.createdAt < filter.since) return false;
  if (filter.until && record.createdAt > filter.until) return false;
  return true;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) return 0;
  const value = Number.parseInt(cursor.slice(CURSOR_PREFIX.length), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function recordId(
  kind: ContinuityRecordKind,
  createdAt: string,
  sourceRefs: ReadonlyArray<ContinuitySourceRef>,
  payload: Readonly<Record<string, unknown>>,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ kind, createdAt, sourceRefs, payload }), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `ctn_${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}_${hash}`;
}

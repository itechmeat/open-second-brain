import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_LOG_REL, ensureInsideVault } from "../paths.ts";
import { acquireLockSync } from "../sync-lockfile.ts";
import { safeContinuityPayload } from "./redaction.ts";
import { CONTINUITY_SCHEMA_VERSION } from "./types.ts";
import type {
  AppendContinuityRecordInput,
  ContinuityRecord,
  ContinuityRecordFilter,
  ContinuityRecordKind,
  ContinuityRecordPage,
  ContinuitySourceRef,
} from "./types.ts";

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

export function continuityLogPath(vault: string, month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`invalid continuity month: ${month}`);
  return ensureInsideVault(join(vault, CONTINUITY_REL, `${month}.jsonl`), vault);
}

export function appendContinuityRecord(
  vault: string,
  input: AppendContinuityRecordInput,
): ContinuityRecord {
  return appendRecord(vault, buildRecord(input));
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
  vault: string,
  inputs: ReadonlyArray<AppendContinuityRecordInput>,
): ReadonlyArray<ContinuityRecord> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("appendContinuityRecords: inputs must be a non-empty array");
  }

  // Phase 1 — build + validate ALL records before any disk mutation.
  // buildRecord sanitises payloads; continuityLogPath validates the month
  // prefix and throws on a malformed createdAt. Any throw here aborts the
  // batch with nothing written.
  const built = inputs.map((input) => {
    const record = buildRecord(input);
    const path = continuityLogPath(vault, record.createdAt.slice(0, 7));
    return { record, path };
  });

  // Phase 2 — group by shard path, preserving first-seen order.
  const shards = new Map<string, { path: string; records: ContinuityRecord[] }>();
  for (const { record, path } of built) {
    let bucket = shards.get(path);
    if (!bucket) {
      bucket = { path, records: [] };
      shards.set(path, bucket);
    }
    bucket.records.push(record);
  }

  // Phase 3 — write each shard under a single lock acquisition.
  mkdirSync(join(vault, CONTINUITY_REL), { recursive: true });
  for (const { path, records } of shards.values()) {
    const handle = acquireLockSync(path);
    try {
      const payload = records.map((record) => `${JSON.stringify(record)}\n`).join("");
      writeFileSync(path, payload, { encoding: "utf8", flag: "a" });
    } finally {
      handle.release();
    }
  }

  return Object.freeze(built.map((entry) => entry.record));
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

export function listContinuityRecords(
  vault: string,
  filter: ContinuityRecordFilter = {},
): ReadonlyArray<ContinuityRecord> {
  return Object.freeze(readAllRecords(vault).filter((record) => matches(record, filter)));
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
  const payloadResult = safeContinuityPayload(input.payload ?? {});
  const sourceRefs = Object.freeze([...(input.sourceRefs ?? [])]);
  // `schema` stays OUT of recordId(): identical records must keep
  // identical dedup ids across the version-stamp transition.
  const id = recordId(input.kind, input.createdAt, sourceRefs, payloadResult.payload);
  return Object.freeze({
    schema: CONTINUITY_SCHEMA_VERSION,
    id,
    kind: input.kind,
    createdAt: input.createdAt,
    sourceRefs,
    payload: payloadResult.payload,
    private: payloadResult.private,
    redacted: payloadResult.redacted,
  });
}

function appendRecord(vault: string, record: ContinuityRecord): ContinuityRecord {
  const path = continuityLogPath(vault, record.createdAt.slice(0, 7));
  mkdirSync(join(vault, CONTINUITY_REL), { recursive: true });
  const handle = acquireLockSync(path);
  try {
    writeFileSync(path, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  } finally {
    handle.release();
  }
  return record;
}

function readAllRecords(vault: string): ContinuityRecord[] {
  const dir = ensureInsideVault(join(vault, CONTINUITY_REL), vault);
  if (!existsSync(dir)) return [];
  const records: ContinuityRecord[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".jsonl")) continue;
    const path = ensureInsideVault(join(dir, name), vault);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as ContinuityRecord);
      } catch {
        continue;
      }
    }
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return records;
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

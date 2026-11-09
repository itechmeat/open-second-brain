/**
 * Dashboard-ready metrics sink (link-recall-intelligence, Task 1).
 *
 * One append-only JSONL file per surface per device under
 * `Brain/metrics/<surface>[.<deviceId>].jsonl` - the stable on-disk
 * contract the upcoming dashboard plugin reads without importing Open
 * Second Brain internals. A reader merges every device's shard of a
 * surface (who-wrote-what, Task B); the bare name is the shard with the
 * empty id. Every record is one line:
 *
 *   {"schema":"o2b.metrics.v1","surface":"...","run_at":"...","payload":{...}}
 *
 * Records are RUN-LEVEL (one per index run, discovery pass, benchmark
 * or tuning run) - per-query events stay in recall telemetry. Writes are
 * single-line O_APPEND appends under the shard's own per-file lock (the
 * same primitive the continuity appender holds), so concurrent appends
 * interleave and a rewrite cannot move the file out from under one;
 * reads are fail-soft (missing dir/file -> empty, torn lines skipped).
 *
 * Evolution rule mirrors continuity records: additive optional fields
 * do NOT bump the version; renames, removals, or semantic changes
 * bump to `o2b.metrics.v2`. The contract is documented for dashboard
 * consumers in `docs/metrics.md`.
 */

import { legacyVaultOf } from "./no-vault.ts";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  listShardedFiles,
  literalBase,
  resolveAppendShardId,
  shardedFileName,
  type LedgerShardGrammar,
} from "./ledger-shards.ts";
import { acquireLockSyncWithRetry } from "./sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { readLedgerRows } from "../store/read/ledger-rows.ts";
import { routeWrite } from "../store/store-write.ts";
import { DUAL_WRITE_LEDGERS, ledgerRowRecord } from "../store/dual-write-records.ts";
import { rowNamesPrivatePage } from "../store/reference-privacy.ts";

/** On-disk schema version stamped on every metric record. */
export const METRICS_SCHEMA_VERSION = "o2b.metrics.v1";

/** Surface names: lowercase snake_case, max 64 chars. */
const SURFACE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Extension of every metric shard. */
const METRICS_EXT = "jsonl";

/** ISO-8601 UTC timestamp shape (second or millisecond precision). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class MetricSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricSurfaceError";
  }
}

/** One persisted metric record, as read back from disk. */
export interface MetricRecord {
  readonly schema: string;
  readonly surface: string;
  readonly run_at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AppendMetricInput {
  readonly surface: string;
  /** ISO-8601 UTC timestamp of the run this record describes. */
  readonly runAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ListMetricsFilter {
  readonly surface?: string;
  /** Inclusive lower bound on `run_at`. */
  readonly since?: string;
  readonly limit?: number;
}

/**
 * The directory every metric shard lives in. Exported so the sweep that
 * reports Syncthing conflict copies names this ledger's directory through
 * the module that owns it, rather than re-deriving the path.
 */
export function metricsDir(vault: string): string {
  return join(vault, "Brain", "metrics");
}

/**
 * This device's shard for one surface: `<surface>[.<deviceId>].jsonl`.
 * The empty shard id is the legacy un-sharded name, which every read
 * still merges and no migration renames.
 */
function surfacePath(
  vault: string,
  surface: string,
  shardId: string = resolveAppendShardId(),
): string {
  return join(metricsDir(vault), shardedFileName(surface, shardId, METRICS_EXT));
}

/**
 * The name layout of ONE surface's shards. Surface names are validated
 * `[a-z][a-z0-9_]*` and so carry no dot, but they go in as a literal all
 * the same: the base is a value, not a shape, and escaping it is what
 * keeps `index_v2.jsonl` from ever parsing as a shard of `index`.
 */
function surfaceGrammar(surface: string): LedgerShardGrammar {
  return { base: literalBase(surface), extensions: [METRICS_EXT] };
}

/** The layout of the whole directory, for discovering surfaces. */
export const ANY_SURFACE_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: "[a-z][a-z0-9_]{0,63}",
  extensions: Object.freeze([METRICS_EXT]),
});

function assertSurface(surface: string): void {
  if (!SURFACE_RE.test(surface)) {
    throw new MetricSurfaceError(
      `invalid metric surface '${surface}': expected lowercase snake_case ([a-z][a-z0-9_]*, max 64 chars)`,
    );
  }
}

/**
 * How long a metric append waits for its surface file's lock: long enough
 * to ride out another append or a shard rewrite, short enough that a
 * telemetry write never stalls the operation it measures.
 */
const METRIC_APPEND_LOCK_WAIT_MS = 1_000;

/**
 * Append one run-level metric record to the surface's JSONL file.
 * Creates `Brain/metrics/` on first write.
 */
export function appendMetric(vault: string | null, input: AppendMetricInput): void {
  assertSurface(input.surface);
  if (!ISO_RE.test(input.runAt)) {
    throw new MetricSurfaceError(
      `invalid run_at '${input.runAt}': expected ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ)`,
    );
  }
  const record: MetricRecord = {
    schema: METRICS_SCHEMA_VERSION,
    surface: input.surface,
    run_at: input.runAt,
    payload: input.payload,
  };
  // One `metrics` ledger row on a store-only machine (design D14 item 1),
  // the surface file plus the dual write otherwise. A sample is counts and
  // timings, but its payload is caller-shaped: one that names a private
  // page, or a page that cannot be judged, goes to `private` only.
  routeWrite({
    legacy: () => appendLegacyMetric(legacyVaultOf(vault, "appendMetric"), record),
    store: () =>
      ledgerRowRecord(
        DUAL_WRITE_LEDGERS.metrics,
        record,
        rowNamesPrivatePage(vault, record) ? "private" : "shared",
      ),
    context: { vault },
    // Best-effort telemetry: a store failure is counted in the device-local
    // write status (doctor reports it) instead of being thrown and dropped
    // by the caller's catch.
    failOpen: true,
  });
}

/** The legacy append: one line in the surface's file under the vault. */
function appendLegacyMetric(vault: string, record: MetricRecord): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = surfacePath(vault, record.surface);
  mkdirSync(dirname(path), { recursive: true });
  // The same per-file lock the continuity appender holds: a bare O_APPEND
  // write interleaves with other APPENDS, but a shard REWRITE (the receipt
  // fold's compare-and-swap) moves the file out from under a concurrent
  // append and the sample is silently lost. Under the lock the rewrite
  // either waits for this append to land (and then reports drift against
  // its recount) or fails its own lock acquisition - either way the sample
  // is a named outcome, never a silent overwrite. The acquisition waits a
  // short budget: two appends to one surface are routine, and a lock that
  // refused at once lost the second sample to a swallowing caller.
  const handle = acquireLockSyncWithRetry(path, METRIC_APPEND_LOCK_WAIT_MS);
  try {
    appendFileSync(path, JSON.stringify(record) + "\n");
  } finally {
    handle.release();
  }
}

/**
 * Metric records, newest-first by `run_at` (file order tie-break).
 * Without a `surface` filter every surface file is merged. Missing
 * dir/file reads as empty; torn or non-object lines are skipped.
 */
export function listMetrics(vault: string, filter: ListMetricsFilter = {}): MetricRecord[] {
  if (filter.surface !== undefined) assertSurface(filter.surface);
  // The `metrics` ledger rows in fold order on a store-only machine (design
  // D14 item 1), the surface files otherwise.
  const rows = readLedgerRows<unknown>(
    DUAL_WRITE_LEDGERS.metrics,
    (legacyVault) => readLegacyMetrics(legacyVault, filter.surface),
    { vault },
  );
  const out: Array<{ record: MetricRecord; seq: number }> = [];
  let seq = 0;
  for (const row of rows) {
    if (!isMetricRecord(row)) continue;
    if (filter.surface !== undefined && row.surface !== filter.surface) continue;
    if (filter.since !== undefined && row.run_at < filter.since) continue;
    out.push({ record: row, seq: seq++ });
  }
  // Newest first; stable on equal timestamps via file/line order.
  out.sort((a, b) =>
    a.record.run_at === b.record.run_at
      ? a.seq - b.seq
      : a.record.run_at < b.record.run_at
        ? 1
        : -1,
  );
  const records = out.map((e) => e.record);
  return filter.limit !== undefined ? records.slice(0, Math.max(0, filter.limit)) : records;
}

/** The legacy records of one surface, or of every surface in name order. */
function readLegacyMetrics(vault: string, surface: string | undefined): MetricRecord[] {
  // Every surface that has at least one shard, sharded or not. The
  // grammar strips a device suffix, so one surface written by three
  // devices is discovered once.
  const surfaces =
    surface !== undefined
      ? [surface]
      : [
          ...new Set(listShardedFiles(metricsDir(vault), ANY_SURFACE_GRAMMAR).map((f) => f.base)),
        ].toSorted();
  return surfaces.flatMap((name) => readSurface(vault, name));
}

/** Whether a parsed line or a store row has the shape of a metric record. */
function isMetricRecord(parsed: unknown): parsed is MetricRecord {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as { schema?: unknown }).schema === "string" &&
    typeof (parsed as { surface?: unknown }).surface === "string" &&
    typeof (parsed as { run_at?: unknown }).run_at === "string" &&
    (parsed as { payload?: unknown }).payload !== null &&
    typeof (parsed as { payload?: unknown }).payload === "object" &&
    !Array.isArray((parsed as { payload?: unknown }).payload)
  );
}

/**
 * One surface's records across every device shard, in (shard id, line)
 * order. The shard id orders the merge rather than the file name, so the
 * legacy un-sharded file - the shard with the empty id - always leads,
 * and two devices agree on the sequence whatever order Syncthing
 * delivered their files in.
 */
function readSurface(vault: string, surface: string): MetricRecord[] {
  const shards = listShardedFiles(metricsDir(vault), surfaceGrammar(surface)).toSorted((a, b) =>
    a.shardId < b.shardId ? -1 : a.shardId > b.shardId ? 1 : 0,
  );
  const out: MetricRecord[] = [];
  for (const shard of shards) {
    let text: string;
    try {
      text = readFileSync(shard.path, "utf8");
    } catch {
      // Fail-soft: an unreadable shard never breaks the metrics read.
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isMetricRecord(parsed)) out.push(parsed);
      } catch {
        // Fail-soft: a torn line never breaks the metrics read.
      }
    }
  }
  return out;
}

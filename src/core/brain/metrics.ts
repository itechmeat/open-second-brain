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
 * or tuning run) - per-query events stay in recall telemetry. Writes
 * use O_APPEND single lines (the maintenance-journal pattern) so
 * concurrent writers interleave instead of racing a rewrite; reads
 * are fail-soft (missing dir/file -> empty, torn lines skipped).
 *
 * Evolution rule mirrors continuity records: additive optional fields
 * do NOT bump the version; renames, removals, or semantic changes
 * bump to `o2b.metrics.v2`. The contract is documented for dashboard
 * consumers in `docs/metrics.md`.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  listShardedFiles,
  literalBase,
  resolveAppendShardId,
  shardedFileName,
  type LedgerShardGrammar,
} from "./ledger-shards.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

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

function metricsDir(vault: string): string {
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
const ANY_SURFACE_GRAMMAR: LedgerShardGrammar = Object.freeze({
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
 * Append one run-level metric record to the surface's JSONL file.
 * Creates `Brain/metrics/` on first write.
 */
export function appendMetric(vault: string, input: AppendMetricInput): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
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
  const path = surfacePath(vault, input.surface);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

/**
 * Metric records, newest-first by `run_at` (file order tie-break).
 * Without a `surface` filter every surface file is merged. Missing
 * dir/file reads as empty; torn or non-object lines are skipped.
 */
export function listMetrics(vault: string, filter: ListMetricsFilter = {}): MetricRecord[] {
  let surfaces: string[];
  if (filter.surface !== undefined) {
    assertSurface(filter.surface);
    surfaces = [filter.surface];
  } else {
    // Every surface that has at least one shard, sharded or not. The
    // grammar strips a device suffix, so one surface written by three
    // devices is discovered once.
    surfaces = [
      ...new Set(listShardedFiles(metricsDir(vault), ANY_SURFACE_GRAMMAR).map((f) => f.base)),
    ].toSorted();
  }

  const out: Array<{ record: MetricRecord; seq: number }> = [];
  let seq = 0;
  for (const surface of surfaces) {
    for (const record of readSurface(vault, surface)) {
      if (filter.since !== undefined && record.run_at < filter.since) continue;
      out.push({ record, seq: seq++ });
    }
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
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof (parsed as { schema?: unknown }).schema === "string" &&
          typeof (parsed as { surface?: unknown }).surface === "string" &&
          typeof (parsed as { run_at?: unknown }).run_at === "string" &&
          (parsed as { payload?: unknown }).payload !== null &&
          typeof (parsed as { payload?: unknown }).payload === "object" &&
          !Array.isArray((parsed as { payload?: unknown }).payload)
        ) {
          out.push(parsed as MetricRecord);
        }
      } catch {
        // Fail-soft: a torn line never breaks the metrics read.
      }
    }
  }
  return out;
}

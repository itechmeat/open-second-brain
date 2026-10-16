/**
 * Receipt fold engine (storage-lifecycle, Lane 3 task 3.2).
 *
 * `compactReceiptLedgers` rewrites explicitly named receipt-ledger
 * shards: records older than the age threshold fold into one aggregate
 * line per (kind, month) preserving count, first/last timestamps and the
 * folded records' byte total; protected records survive verbatim, in
 * file order; unknown kinds fail closed to keep. The rewrite is atomic
 * per shard (compare-and-swap through `atomicWriteFileSync`) inside a
 * `withDestructiveSnapshot` span, and per-shard fail-soft: a poisoned
 * shard is collected and the run still completes with an honest audit.
 *
 * The audit is the additive `receipt_compaction` continuity kind: one
 * record per confirmed run, never on a dry run. A count-guard mismatch
 * aborts before any write, including the snapshot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  continuityLogDir,
  continuityLogPath,
  listContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
import { metricsDir, appendMetric } from "../../../src/core/brain/metrics.ts";
import {
  compactReceiptLedgers,
  RECEIPT_AUDIT_APPEND_FAILED,
} from "../../../src/core/brain/receipts/compact.ts";
import {
  RECEIPT_SHARD_FOREIGN_DEVICE,
  RECEIPT_SHARD_UNREADABLE,
} from "../../../src/core/brain/receipts/scan.ts";
import { compactView } from "../../../src/core/brain/receipts/views.ts";
import {
  RECEIPT_COMPACTION_OPERATION,
  RECEIPT_FOLD_SCHEMA,
  RECEIPT_LEDGER_FAMILY,
} from "../../../src/core/brain/receipts/types.ts";
import { CountGuardError } from "../../../src/core/brain/count-guard.ts";
import { listSnapshots } from "../../../src/core/brain/snapshot.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { WriteRefusedError } from "../../../src/core/brain/write-disposition.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { withDeviceId } from "../../helpers/device-id.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";

const NOW = new Date("2026-09-25T00:00:00Z");

let vault: string;
let configHome: string;

function continuityLine(
  kind: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
): string {
  const id = `ctn_${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}_${kind}`;
  return `${JSON.stringify({
    schema: "o2b.continuity.v1",
    id,
    kind,
    createdAt,
    sourceRefs: [],
    payload,
    private: false,
    redacted: false,
  })}\n`;
}

function metricLine(surface: string, runAt: string, payload: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ schema: "o2b.metrics.v1", surface, run_at: runAt, payload })}\n`;
}

function writeShard(dir: string, name: string, lines: ReadonlyArray<string> | string): void {
  const text = typeof lines === "string" ? lines : lines.join("");
  writeFileSync(join(dir, name), text, "utf8");
}

function readShard(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

/** Byte length of one record line, newline separators excluded. */
function recordLineBytes(line: string): number {
  return Buffer.byteLength(line.trimEnd(), "utf8");
}

/** The continuity shard the happy-path tests fold: two old, one protected, one young. */
const MIXED_SHARD = [
  continuityLine("recall_telemetry", "2026-08-10T12:00:00Z", { note: "first old" }),
  continuityLine("source_invalidation", "2026-08-11T12:00:00Z", { reason: "audit trail" }),
  continuityLine("recall_telemetry", "2026-08-20T12:00:00Z", { note: "second old" }),
  continuityLine("gate_telemetry", "2026-09-15T12:00:00Z", { fresh: true }),
].join("");

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-receipts-compact-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-receipts-compact-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(continuityLogDir(vault), { recursive: true });
  mkdirSync(metricsDir(vault), { recursive: true });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("compactReceiptLedgers", () => {
  test("folds old records into one aggregate line per (kind, month), preserving the totals", () => {
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
      expect: 2,
    });
    expect(result.dryRun).toBe(false);
    expect(result.totals.folded).toBe(2);
    const after = readShard(continuityLogDir(vault), "2026-08.jsonl");
    const lines = after.split("\n").filter((line) => line.trim() !== "");
    // Two folded records became one aggregate line; protected and young kept.
    expect(lines).toHaveLength(3);
    const aggregate = JSON.parse(lines[0]!) as {
      schema: string;
      fold: Record<string, unknown>;
    };
    expect(aggregate.schema).toBe(RECEIPT_FOLD_SCHEMA);
    expect(aggregate.fold).toMatchObject({
      family: RECEIPT_LEDGER_FAMILY.continuity,
      kind: "recall_telemetry",
      month: "2026-08",
      count: 2,
      first_created_at: "2026-08-10T12:00:00Z",
      last_created_at: "2026-08-20T12:00:00Z",
    });
    // The folded records' byte total is preserved as metadata (record
    // lines, newline separators excluded).
    const foldedBytes =
      Buffer.byteLength(
        continuityLine("recall_telemetry", "2026-08-10T12:00:00Z", { note: "first old" }).trimEnd(),
      ) +
      Buffer.byteLength(
        continuityLine("recall_telemetry", "2026-08-20T12:00:00Z", {
          note: "second old",
        }).trimEnd(),
      );
    expect(aggregate.fold.bytes).toBe(foldedBytes);
    // Shrink verified: the rewrite is strictly smaller than the original.
    expect(Buffer.byteLength(after)).toBeLessThan(Buffer.byteLength(MIXED_SHARD));
    expect(result.totals.bytesBefore).toBe(Buffer.byteLength(MIXED_SHARD));
    expect(result.totals.bytesAfter).toBe(Buffer.byteLength(after));
  });

  test("protected records survive verbatim, in file order, and unknown kinds fail closed to keep", () => {
    const shard = [
      continuityLine("recall_telemetry", "2026-08-10T12:00:00Z"),
      continuityLine("source_invalidation", "2026-08-11T12:00:00Z", { reason: "audit" }),
      continuityLine("kind_from_the_future", "2026-08-12T12:00:00Z"),
      continuityLine("gate_telemetry", "2026-08-13T12:00:00Z", { session_id: "sess-1" }),
      continuityLine("recall_telemetry", "2026-08-14T12:00:00Z"),
    ].join("");
    writeShard(continuityLogDir(vault), "2026-08.jsonl", shard);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(result.totals.folded).toBe(2);
    expect(result.totals.kept).toBe(3);
    const after = readShard(continuityLogDir(vault), "2026-08.jsonl");
    // Every kept line is byte-present, and their relative order holds.
    const keptLines = [
      continuityLine("source_invalidation", "2026-08-11T12:00:00Z", { reason: "audit" }),
      continuityLine("kind_from_the_future", "2026-08-12T12:00:00Z"),
      continuityLine("gate_telemetry", "2026-08-13T12:00:00Z", { session_id: "sess-1" }),
    ];
    let cursor = -1;
    for (const line of keptLines) {
      const at = after.indexOf(line.trim());
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("the aggregate's first and last compare by instant, not by stamp text", () => {
    // Both stamps pass the canonical grammar, which admits optional
    // fractional seconds - and "." sorts before "Z", so a text compare
    // puts the LATER half-second stamp first. Written later-instant-first
    // to make the text order and the instant order disagree.
    const shard = [
      continuityLine("recall_telemetry", "2026-08-10T12:00:00.500Z", { note: "later half" }),
      continuityLine("recall_telemetry", "2026-08-10T12:00:00Z", { note: "earlier whole" }),
    ].join("");
    writeShard(continuityLogDir(vault), "2026-08.jsonl", shard);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
      expect: 2,
    });
    expect(result.totals.folded).toBe(2);
    const aggregate = JSON.parse(
      readShard(continuityLogDir(vault), "2026-08.jsonl")
        .split("\n")
        .find((line) => line.trim() !== "")!,
    ) as { fold: Record<string, unknown> };
    expect(aggregate.fold.first_created_at).toBe("2026-08-10T12:00:00Z");
    expect(aggregate.fold.last_created_at).toBe("2026-08-10T12:00:00.500Z");
  });

  test("metrics shards fold per (surface, month)", () => {
    writeShard(metricsDir(vault), "storage_usage.jsonl", [
      metricLine("storage_usage", "2026-08-01T00:00:00Z", { bytes: 10 }),
      metricLine("storage_usage", "2026-08-05T00:00:00Z", { bytes: 11 }),
      metricLine("storage_usage", "2026-08-10T00:00:00Z", { bytes: 12 }),
      metricLine("storage_usage", "2026-08-15T00:00:00Z", { bytes: 13 }),
      metricLine("storage_usage", "2026-08-20T00:00:00Z", { bytes: 14 }),
      metricLine("storage_usage", "2026-07-05T00:00:00Z", { bytes: 5 }),
      metricLine("storage_usage", "2026-07-06T00:00:00Z", { bytes: 6 }),
    ]);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.metrics, name: "storage_usage.jsonl" }],
      now: NOW,
      dryRun: false,
      expect: 7,
    });
    expect(result.totals.folded).toBe(7);
    const lines = readShard(metricsDir(vault), "storage_usage.jsonl")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(2);
    const folds = lines.map((line) => (JSON.parse(line) as { fold: Record<string, unknown> }).fold);
    expect(folds.map((f) => f.month).toSorted()).toEqual(["2026-07", "2026-08"]);
    const august = folds.find((f) => f.month === "2026-08")!;
    expect(august).toMatchObject({
      family: RECEIPT_LEDGER_FAMILY.metrics,
      surface: "storage_usage",
      count: 5,
      first_run_at: "2026-08-01T00:00:00Z",
      last_run_at: "2026-08-20T00:00:00Z",
    });
  });

  test("a metrics line outside the record shape is kept, never folded into a surface-less aggregate", () => {
    // The scan counts a parsed line without the full metrics record shape
    // (schema, surface and run_at strings, plain-object payload) as
    // unparseable. The fold engine must classify it the same way: gated
    // only on run_at, a line carrying nothing but an old stamp would fold
    // with an undefined surface, and JSON.stringify would drop that
    // surface from the aggregate - an aggregate no reader can attribute.
    const malformed = JSON.stringify({ run_at: "2026-07-01T00:00:00Z" });
    writeShard(metricsDir(vault), "storage_usage.jsonl", [
      metricLine("storage_usage", "2026-08-01T00:00:00Z", { bytes: 10 }),
      metricLine("storage_usage", "2026-08-05T00:00:00Z", { bytes: 11 }),
      metricLine("storage_usage", "2026-08-10T00:00:00Z", { bytes: 12 }),
      `${malformed}\n`,
    ]);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.metrics, name: "storage_usage.jsonl" }],
      now: NOW,
      dryRun: false,
      expect: 3,
    });
    expect(result.totals.folded).toBe(3);
    expect(result.totals.kept).toBe(1);
    expect(result.totals.aggregates).toBe(1);
    const after = readShard(metricsDir(vault), "storage_usage.jsonl");
    // The malformed line is still there, byte-verbatim.
    expect(after).toContain(malformed);
    for (const line of after.split("\n").filter((entry) => entry.trim() !== "")) {
      const fold = (JSON.parse(line) as { fold?: { surface?: unknown } }).fold;
      if (fold !== undefined) expect(typeof fold.surface).toBe("string");
    }
  });

  test("a confirmed run takes one recovery point and appends the audit record exactly once", () => {
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(result.snapshotRunId).toBeDefined();
    expect(result.auditRecordId).toBeDefined();
    expect(result.recoverability).toBeDefined();
    const snapshots = listSnapshots(vault).snapshots;
    expect(snapshots.some((s) => s.run_id === result.snapshotRunId)).toBe(true);
    const audits = listContinuityRecords(vault, { kind: "receipt_compaction" });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.id).toBe(result.auditRecordId!);
  });

  test("a dry run writes nothing: no rewrite, no snapshot, no audit record", () => {
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    const before = digestVaultTree(vault);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.totals.folded).toBe(2);
    expect(digestVaultTree(vault)).toBe(before);
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(0);
  });

  test("a count-guard mismatch aborts before any write, snapshot included", () => {
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    const before = digestVaultTree(vault);
    expect(() =>
      compactReceiptLedgers(vault, {
        shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
        now: NOW,
        dryRun: false,
        expect: 3,
      }),
    ).toThrow(CountGuardError);
    expect(digestVaultTree(vault)).toBe(before);
    expect(readdirSync(join(vault, "Brain", ".snapshots"))).toEqual([]);
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(0);
  });

  test("a re-run over a compacted ledger folds nothing and writes nothing", () => {
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    const after = digestVaultTree(vault);
    const audits = listContinuityRecords(vault, { kind: "receipt_compaction" }).length;
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(result.totals.folded).toBe(0);
    expect(digestVaultTree(vault)).toBe(after);
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(audits);
  });

  test("the confirmed result reports the recovery point's bytes and the net delta", () => {
    // M6 (confirm half): the recovery point is a whole-Brain archive
    // written BEFORE the ledger shrink lands, into a surface the storage
    // census counts as vault content. A result carrying only the ledger
    // shrink reads as pure win even where the net effect is growth. The
    // confirmed result names both sides: the archive's bytes, and the
    // ledger shrink minus the recovery point's growth.
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(result.snapshotRunId).toBeDefined();
    expect(result.snapshotBytes).toBeGreaterThan(0);
    const shrink = result.totals.bytesBefore - result.totals.bytesAfter;
    expect(shrink).toBeGreaterThan(0);
    expect(result.netDeltaBytes).toBe(shrink - result.snapshotBytes!);
    // A dry run takes no recovery point, so it names neither.
    writeShard(continuityLogDir(vault), "2026-07.jsonl", [
      continuityLine("recall_telemetry", "2026-07-10T12:00:00Z"),
    ]);
    const preview = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-07.jsonl" }],
      now: NOW,
      dryRun: true,
    });
    expect(preview.snapshotBytes).toBeUndefined();
    expect(preview.netDeltaBytes).toBeUndefined();
    // Both figures ride the shared wire view.
    const view = compactView(result);
    expect(view["snapshot_bytes"]).toBe(result.snapshotBytes);
    expect(view["net_delta_bytes"]).toBe(result.netDeltaBytes);
    expect(compactView(preview)["snapshot_bytes"]).toBeUndefined();
  });

  test("a shard whose fold would not shrink is collected and the rest of the run completes", () => {
    // One old record whose aggregate line would be LARGER than the
    // record itself: the engine refuses the rewrite rather than grow a
    // ledger, and the refusal is collected while the healthy shard
    // beside it still folds and the run still completes.
    writeShard(continuityLogDir(vault), "2026-07.jsonl", [
      continuityLine("recall_telemetry", "2026-07-10T12:00:00Z"),
    ]);
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    const result = compactReceiptLedgers(vault, {
      shards: [
        { family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-07.jsonl" },
        { family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" },
      ],
      now: NOW,
      dryRun: false,
    });
    expect(result.shards.map((s) => s.shard)).toEqual(["continuity:2026-08.jsonl"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.shard).toBe("continuity:2026-07.jsonl");
    expect(result.failures[0]!.message).toContain("shrink");
    // The run still completed: the healthy shard folded, and the audit
    // names the refusal honestly.
    expect(result.totals.folded).toBe(2);
    const audits = listContinuityRecords(vault, { kind: "receipt_compaction" });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.payload)).toContain("continuity:2026-07.jsonl");
    // The refused shard is untouched on disk.
    expect(readShard(continuityLogDir(vault), "2026-07.jsonl")).toContain("2026-07-10T12:00:00Z");
  });

  test("a lost audit record is a named outcome, never a throw that discards the run", () => {
    // The audit record lands in the continuity ledger under the run
    // clock's month, beside the shards being folded. A directory parked
    // at that exact path makes the append fail while the metrics shard
    // selected here folds untouched - the window where every shard is
    // already durable and a post-write throw would discard every
    // outcome, failure and recovery point with it.
    writeShard(
      metricsDir(vault),
      "storage_usage.jsonl",
      [
        metricLine("brain", "2026-06-01T00:00:00Z", { n: 1 }),
        metricLine("brain", "2026-06-02T00:00:00Z", { n: 2 }),
        metricLine("brain", "2026-06-03T00:00:00Z", { n: 3 }),
        metricLine("brain", "2026-06-04T00:00:00Z", { n: 4 }),
      ].join(""),
    );
    mkdirSync(continuityLogPath(vault, "2026-09"), { recursive: true });
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.metrics, name: "storage_usage.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(result.totals.folded).toBe(4);
    expect(result.auditRecordId).toBeUndefined();
    expect(result.auditError).toBe(RECEIPT_AUDIT_APPEND_FAILED);
    // The fold itself landed: the shard on disk holds the aggregate.
    expect(readShard(metricsDir(vault), "storage_usage.jsonl")).toContain(RECEIPT_FOLD_SCHEMA);
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(0);
  });

  test("the review probe: entity mentions and the audit trail survive two confirmed runs", () => {
    // The H1 probe the external review ran: a 2026-08 shard holding 28
    // session_entity_mention records and 28 receipt_compaction records
    // ended 0 records / 4 aggregates after two confirmed runs - the
    // cross-session entity index and the fold's own audit trail folded
    // away, because folding used to be the default for every kind outside
    // a short protected list. Folding is now opt-in per kind and both
    // kinds are data, not telemetry: nothing here may fold, so two runs
    // leave all 56 records in place and write no aggregate at all.
    const lines: string[] = [];
    for (let i = 0; i < 28; i += 1) {
      const day = String((i % 25) + 1).padStart(2, "0");
      lines.push(
        continuityLine("session_entity_mention", `2026-08-${day}T12:00:00Z`, {
          session_ref: "imports/a.md",
          key: `sym:S${i}`,
        }),
      );
      lines.push(
        continuityLine("receipt_compaction", `2026-08-${day}T13:00:00Z`, {
          operation: RECEIPT_COMPACTION_OPERATION,
        }),
      );
    }
    writeShard(continuityLogDir(vault), "2026-08.jsonl", lines);
    for (let run = 0; run < 2; run += 1) {
      const result = compactReceiptLedgers(vault, {
        shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
        now: NOW,
        dryRun: false,
      });
      expect(result.totals.folded).toBe(0);
      expect(result.failures).toEqual([]);
    }
    // The read model still sees every record, and no aggregate line was
    // written. (Nothing folded, so the runs appended no audit either.)
    expect(listContinuityRecords(vault, { kind: "session_entity_mention" })).toHaveLength(28);
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(28);
    expect(readShard(continuityLogDir(vault), "2026-08.jsonl")).not.toContain(RECEIPT_FOLD_SCHEMA);
  });

  test("a later run merges into the existing (kind, month) aggregate instead of adding a second line", () => {
    // M13: the cutoff slides with each run and re-imports append new old
    // records into an already-compacted monthly shard, so a shard folded
    // twice used to gain a SECOND aggregate line per (kind, month) - a
    // growing stack the one-aggregate-per-key contract forbids, and whose
    // ~200-byte lines could tip a small fold into the strict-shrink
    // refusal. The fold now merges into the aggregate it finds: count and
    // bytes sum, first and last widen.
    writeShard(continuityLogDir(vault), "2026-08.jsonl", [
      continuityLine("recall_telemetry", "2026-08-10T12:00:00Z", { note: "first" }),
      continuityLine("recall_telemetry", "2026-08-20T12:00:00Z", { note: "second" }),
    ]);
    const first = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(first.totals.aggregates).toBe(1);
    // A re-import appends another old record into the same monthly shard.
    const compacted = readShard(continuityLogDir(vault), "2026-08.jsonl");
    const reimported = continuityLine("recall_telemetry", "2026-08-15T12:00:00Z", {
      note: "re-imported",
    });
    writeShard(continuityLogDir(vault), "2026-08.jsonl", compacted + reimported);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(result.totals.folded).toBe(1);
    // The small fold merged instead of failing the strict-shrink guard.
    expect(result.failures).toEqual([]);
    const lines = readShard(continuityLogDir(vault), "2026-08.jsonl")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(1);
    const fold = (JSON.parse(lines[0]!) as { fold: Record<string, unknown> }).fold;
    expect(fold.kind).toBe("recall_telemetry");
    expect(fold.month).toBe("2026-08");
    expect(fold.count).toBe(3);
    expect(fold.first_created_at).toBe("2026-08-10T12:00:00Z");
    expect(fold.last_created_at).toBe("2026-08-20T12:00:00Z");
    expect(fold.bytes).toBe(
      recordLineBytes(
        continuityLine("recall_telemetry", "2026-08-10T12:00:00Z", { note: "first" }),
      ) +
        recordLineBytes(
          continuityLine("recall_telemetry", "2026-08-20T12:00:00Z", { note: "second" }),
        ) +
        recordLineBytes(reimported),
    );
  });

  test("a metrics fold merges into the existing (surface, month) aggregate the same way", () => {
    writeShard(metricsDir(vault), "storage_usage.jsonl", [
      metricLine("storage_usage", "2026-08-01T00:00:00Z", { bytes: 10 }),
      metricLine("storage_usage", "2026-08-05T00:00:00Z", { bytes: 11 }),
    ]);
    compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.metrics, name: "storage_usage.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    const compacted = readShard(metricsDir(vault), "storage_usage.jsonl");
    writeShard(metricsDir(vault), "storage_usage.jsonl", [
      compacted,
      metricLine("storage_usage", "2026-08-03T00:00:00Z", { bytes: 12 }),
    ]);
    const result = compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.metrics, name: "storage_usage.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(result.totals.folded).toBe(1);
    expect(result.failures).toEqual([]);
    const lines = readShard(metricsDir(vault), "storage_usage.jsonl")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(1);
    const fold = (JSON.parse(lines[0]!) as { fold: Record<string, unknown> }).fold;
    expect(fold.surface).toBe("storage_usage");
    expect(fold.count).toBe(3);
    expect(fold.first_run_at).toBe("2026-08-01T00:00:00Z");
    expect(fold.last_run_at).toBe("2026-08-05T00:00:00Z");
  });

  test("appendMetric holds the shard's lock, so a rewrite window cannot swallow a sample", () => {
    // M12: the metrics append path wrote bare `appendFileSync` with no
    // lock, so a sample landing between the fold engine's compare-and-swap
    // re-read and its rename was overwritten without error - exactly the
    // loss the CAS was built to turn into reported drift. The append now
    // takes the same per-file lock the continuity appender takes, in both
    // directions: a contended append is a loud failure, never a silent
    // overwrite, and a compact that meets a held lock is a collected
    // failure, never a rewrite that wins the race.
    mkdirSync(metricsDir(vault), { recursive: true });
    const shardPath = join(metricsDir(vault), "storage_usage.jsonl");
    writeFileSync(
      shardPath,
      [
        metricLine("storage_usage", "2026-08-01T00:00:00Z", { bytes: 10 }),
        metricLine("storage_usage", "2026-08-02T00:00:00Z", { bytes: 11 }),
      ].join(""),
      "utf8",
    );
    writeFileSync(`${shardPath}.lock`, "held by another writer", "utf8");
    try {
      expect(() =>
        appendMetric(vault, {
          surface: "storage_usage",
          runAt: "2026-09-02T00:00:00Z",
          payload: { bytes: 12 },
        }),
      ).toThrow(/lock busy/);
      // Nothing landed while the lock was held.
      expect(readFileSync(shardPath, "utf8")).not.toContain("2026-09-02");
      // And the fold engine reports the contention instead of rewriting.
      const result = compactReceiptLedgers(vault, {
        shards: [{ family: RECEIPT_LEDGER_FAMILY.metrics, name: "storage_usage.jsonl" }],
        now: NOW,
        dryRun: false,
      });
      expect(result.shards).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.shard).toBe("metrics:storage_usage.jsonl");
      expect(result.failures[0]!.message).toContain("locked");
    } finally {
      rmSync(`${shardPath}.lock`, { force: true });
    }
  });

  test("another device's shard is refused by name; this device's shard beside it still folds", () => {
    // M11: shards are named per device so exactly one device writes a
    // given file, but the fold's lock and compare-and-swap are local
    // only - rewriting a peer's shard here is the divergent-copy conflict
    // the shard layout exists to prevent. A named foreign shard is a
    // refusal by name, and the local shard in the same selection folds.
    withDeviceId("", () => {
      writeShard(continuityLogDir(vault), "2026-08.telescope.jsonl", MIXED_SHARD);
      writeShard(continuityLogDir(vault), "2026-07.jsonl", [
        continuityLine("recall_telemetry", "2026-07-10T12:00:00Z", { note: "local a" }),
        continuityLine("recall_telemetry", "2026-07-20T12:00:00Z", { note: "local b" }),
      ]);
      const result = compactReceiptLedgers(vault, {
        shards: [
          { family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.telescope.jsonl" },
          { family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-07.jsonl" },
        ],
        now: NOW,
        dryRun: false,
      });
      expect(result.failures).toEqual([
        {
          shard: "continuity:2026-08.telescope.jsonl",
          message: RECEIPT_SHARD_FOREIGN_DEVICE,
        },
      ]);
      expect(result.totals.folded).toBe(2);
      // The foreign shard is untouched on disk.
      expect(readShard(continuityLogDir(vault), "2026-08.telescope.jsonl")).toBe(MIXED_SHARD);
      // A dry run refuses the same way, so a preview never promises a
      // peer's fold.
      const preview = compactReceiptLedgers(vault, {
        shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.telescope.jsonl" }],
        now: NOW,
        dryRun: true,
      });
      expect(preview.failures).toEqual([
        { shard: "continuity:2026-08.telescope.jsonl", message: RECEIPT_SHARD_FOREIGN_DEVICE },
      ]);
    });
  });

  test("a mixed selection reports a compacted shard as nothing-to-do, not a failure", () => {
    // The re-run contract: a compacted shard folds nothing and writes
    // nothing. A MIXED selection never reaches the run-level
    // nothing-foldable shortcut - the compacted shard arrives at the
    // rewriter with foldable 0, its rebuild is byte-identical, and the
    // strict-shrink guard then failed exactly the shard the contract
    // calls a no-op.
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    const compacted = readShard(continuityLogDir(vault), "2026-08.jsonl");
    writeShard(continuityLogDir(vault), "2026-07.jsonl", [
      continuityLine("recall_telemetry", "2026-07-10T12:00:00Z"),
      continuityLine("recall_telemetry", "2026-07-20T12:00:00Z"),
    ]);
    const result = compactReceiptLedgers(vault, {
      shards: [
        { family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-07.jsonl" },
        { family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" },
      ],
      now: NOW,
      dryRun: false,
    });
    expect(result.failures).toEqual([]);
    expect(result.shards.map((shard) => shard.shard).toSorted()).toEqual([
      "continuity:2026-07.jsonl",
      "continuity:2026-08.jsonl",
    ]);
    const untouched = result.shards.find((shard) => shard.shard === "continuity:2026-08.jsonl");
    expect(untouched).toBeDefined();
    expect(untouched!.folded).toBe(0);
    expect(untouched!.bytesAfter).toBe(untouched!.bytesBefore);
    // The compacted shard is byte-identical on disk.
    expect(readShard(continuityLogDir(vault), "2026-08.jsonl")).toBe(compacted);
    // The run still folded the shard that had foldable records.
    expect(result.totals.folded).toBe(2);
    expect(result.auditRecordId).toBeDefined();
  });

  test("a zero-foldable shard is never rewritten, so its bytes never grow", () => {
    // The rebuild joins the kept lines and appends one newline, so a
    // shard whose file lacks a trailing newline rebuilds one byte LONGER
    // than it stands. With nothing foldable there is nothing to write:
    // the file must come out byte-identical, not grown, not failed.
    writeShard(
      continuityLogDir(vault),
      "2026-08.jsonl",
      continuityLine("gate_telemetry", "2026-09-15T12:00:00Z").replace(/\n$/, ""),
    );
    writeShard(continuityLogDir(vault), "2026-07.jsonl", [
      continuityLine("recall_telemetry", "2026-07-10T12:00:00Z"),
      continuityLine("recall_telemetry", "2026-07-20T12:00:00Z"),
    ]);
    const before = readShard(continuityLogDir(vault), "2026-08.jsonl");
    const result = compactReceiptLedgers(vault, {
      shards: [
        { family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-07.jsonl" },
        { family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" },
      ],
      now: NOW,
      dryRun: false,
    });
    expect(result.failures).toEqual([]);
    expect(readShard(continuityLogDir(vault), "2026-08.jsonl")).toBe(before);
    expect(result.totals.folded).toBe(2);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unreadable shard fails by name, never with the raw filesystem error",
    () => {
      // The failure rows ride the compact view to remote callers verbatim:
      // the raw Node error text would hand them an absolute host path and
      // an absent-versus-denied oracle. The boundary names the shard and
      // the one class the operator can act on: unreadable.
      writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
      const shardPath = join(continuityLogDir(vault), "2026-08.jsonl");
      chmodSync(shardPath, 0o000);
      try {
        const result = compactReceiptLedgers(vault, {
          shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
          now: NOW,
          dryRun: true,
        });
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]!.shard).toBe("continuity:2026-08.jsonl");
        expect(result.failures[0]!.message).toBe(RECEIPT_SHARD_UNREADABLE);
        const rendered = JSON.stringify(result.failures);
        expect(rendered).not.toContain("ENOENT");
        expect(rendered).not.toContain("EACCES");
        expect(rendered).not.toContain(vault);
      } finally {
        chmodSync(shardPath, 0o644);
      }
    },
  );

  test("a shard ref that is not a valid shard name is refused before anything runs", () => {
    expect(() =>
      compactReceiptLedgers(vault, {
        shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "../metrics/x.jsonl" }],
        now: NOW,
        dryRun: true,
      }),
    ).toThrow(/not a continuity shard/);
  });

  test("a permissions-document deny refuses the confirmed run before any write", () => {
    writeShard(continuityLogDir(vault), "2026-08.jsonl", MIXED_SHARD);
    atomicWriteFileSync(
      join(vault, "Brain", "_permissions.yaml"),
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze\n    agent: test-agent\n" +
        "    action: ingest\n    verdict: deny\n",
    );
    const before = readShard(continuityLogDir(vault), "2026-08.jsonl");
    expect(() =>
      compactReceiptLedgers(vault, {
        shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
        now: NOW,
        dryRun: false,
        subject: { agent: "test-agent", via: "config" },
      }),
    ).toThrow(WriteRefusedError);
    // The ledger shard is untouched. (The refusal itself writes its
    // decision-ledger row - that record is the point of the consult -
    // so the assertion is on the shard the run would have rewritten.)
    expect(readShard(continuityLogDir(vault), "2026-08.jsonl")).toBe(before);
    expect(readdirSync(join(vault, "Brain", ".snapshots"))).toEqual([]);
  });

  test("an empty shard selection is a named caller error, never a silent full scan", () => {
    expect(() => compactReceiptLedgers(vault, { shards: [], now: NOW, dryRun: true })).toThrow(
      /explicit shard ids/,
    );
  });
});

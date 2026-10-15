/**
 * Receipt ledger scan (storage-lifecycle, Lane 3 task 3.1).
 *
 * `scanReceiptLedgers` inventories the two append-only receipt ledgers -
 * the continuity log and the metrics sink - as the fold engine's preview:
 * per shard, how many records it holds, how many are old enough to fold,
 * and how many are in a protected class the fold must never touch. The
 * protected vocabulary is the audit posture named in the design:
 * `source_invalidation` (the deleteBySource audit trail), the two Hermes
 * context-compaction kinds (`pre_compact_extract`, `post_compact_audit`),
 * any record whose payload carries a clip-protected correlation key, and
 * any kind this build does not know (fail closed to keep). None of them
 * may ever be counted foldable.
 *
 * The scan is a pure read: a byte-identical vault after the run is part
 * of the acceptance, asserted with the whole-tree digest.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { continuityLogDir } from "../../../src/core/brain/continuity/store.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { metricsDir } from "../../../src/core/brain/metrics.ts";
import {
  RECEIPT_SHARD_UNREADABLE,
  scanReceiptLedgers,
} from "../../../src/core/brain/receipts/scan.ts";
import {
  RECEIPT_FOLD_DEFAULT_AGE_DAYS,
  RECEIPT_LEDGER_FAMILY,
  type ReceiptScanReport,
} from "../../../src/core/brain/receipts/types.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";

const CONTINUITY_SCHEMA = "o2b.continuity.v1";
const METRICS_SCHEMA = "o2b.metrics.v1";

const NOW = new Date("2026-09-25T00:00:00Z");

function mintVault(): string {
  const root = mkdtempSync(join(tmpdir(), "o2b-receipts-scan-"));
  mkdirSync(continuityLogDir(root), { recursive: true });
  mkdirSync(metricsDir(root), { recursive: true });
  return root;
}

let vault: string;

function cleanup(): void {
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** One fixture continuity record line with a content-shaped fixture id. */
function continuityLine(
  kind: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
): string {
  const id = `ctn_${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}_${kind}`;
  return `${JSON.stringify({
    schema: CONTINUITY_SCHEMA,
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
  return `${JSON.stringify({
    schema: METRICS_SCHEMA,
    surface,
    run_at: runAt,
    payload,
  })}\n`;
}

function writeShard(dir: string, name: string, lines: ReadonlyArray<string>): void {
  writeFileSync(join(dir, name), lines.join(""), "utf8");
}

function shardOf(report: ReceiptScanReport, family: string, name: string) {
  const shard = report.shards.find((s) => s.family === family && s.name === name);
  expect(shard, `${family} shard ${name} is inventoried`).toBeDefined();
  return shard!;
}

describe("scanReceiptLedgers", () => {
  test("counts foldable records above the age threshold per shard", () => {
    vault = mintVault();
    try {
      const continuity = continuityLogDir(vault);
      writeShard(continuity, "2026-08.jsonl", [
        continuityLine("recall_telemetry", "2026-08-10T12:00:00Z"),
      ]);
      writeShard(continuity, "2026-09.telescope.jsonl", [
        continuityLine("gate_telemetry", "2026-09-15T12:00:00Z"),
      ]);
      const report = scanReceiptLedgers(vault, { now: NOW });
      const august = shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-08.jsonl");
      expect(august.records).toBe(1);
      // 2026-08-10 is 46 days before the pinned now: past the 30-day fold age.
      expect(august.foldable).toBe(1);
      expect(august.protectedRecords).toBe(0);
      const september = shardOf(
        report,
        RECEIPT_LEDGER_FAMILY.continuity,
        "2026-09.telescope.jsonl",
      );
      // A record inside the window is neither foldable nor protected.
      expect(september.records).toBe(1);
      expect(september.foldable).toBe(0);
      expect(september.protectedRecords).toBe(0);
      expect(report.totals.foldable).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("the protected vocabulary is never counted foldable", () => {
    vault = mintVault();
    try {
      const continuity = continuityLogDir(vault);
      // The deleteBySource audit trail.
      writeShard(continuity, "2026-07.jsonl", [
        continuityLine("source_invalidation", "2026-07-10T12:00:00Z", { reason: "test" }),
      ]);
      // The Hermes context-compaction kinds: a storage fold must stay
      // disjoint from that vocabulary on every surface, ledgers included.
      writeShard(continuity, "2026-06.jsonl", [
        continuityLine("pre_compact_extract", "2026-06-10T12:00:00Z"),
        continuityLine("post_compact_audit", "2026-06-11T12:00:00Z"),
      ]);
      // A clip-protected correlation key carrier: folding would destroy
      // the correlation the clip rule guarantees survives.
      writeShard(continuity, "2026-05.jsonl", [
        continuityLine("gate_telemetry", "2026-05-10T12:00:00Z", { session_id: "sess-1" }),
      ]);
      // An unknown kind fails closed to keep: a future build's records
      // are not this build's to fold.
      writeShard(continuity, "2026-04.jsonl", [
        continuityLine("kind_from_the_future", "2026-04-10T12:00:00Z"),
      ]);
      const report = scanReceiptLedgers(vault, { now: NOW });
      expect(shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-07.jsonl").foldable).toBe(0);
      expect(
        shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-07.jsonl").protectedRecords,
      ).toBe(1);
      expect(shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-06.jsonl").foldable).toBe(0);
      expect(
        shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-06.jsonl").protectedRecords,
      ).toBe(2);
      expect(shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-05.jsonl").foldable).toBe(0);
      expect(
        shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-05.jsonl").protectedRecords,
      ).toBe(1);
      expect(shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-04.jsonl").foldable).toBe(0);
      expect(
        shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-04.jsonl").protectedRecords,
      ).toBe(1);
      expect(report.totals.foldable).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("inventories metrics shards with run_at-based ages and the same protected rule", () => {
    vault = mintVault();
    try {
      const metrics = metricsDir(vault);
      writeShard(metrics, "storage_usage.jsonl", [
        metricLine("storage_usage", "2026-08-01T00:00:00Z"),
        metricLine("storage_usage", "2026-08-15T00:00:00Z"),
        metricLine("storage_usage", "2026-09-20T00:00:00Z"),
      ]);
      writeShard(metrics, "recall_probe.telescope.jsonl", [
        metricLine("recall_probe", "2026-08-02T00:00:00Z", { session_id: "sess-1" }),
      ]);
      const report = scanReceiptLedgers(vault, { now: NOW });
      const usage = shardOf(report, RECEIPT_LEDGER_FAMILY.metrics, "storage_usage.jsonl");
      expect(usage.base).toBe("storage_usage");
      expect(usage.records).toBe(3);
      expect(usage.foldable).toBe(2);
      expect(usage.protectedRecords).toBe(0);
      const probe = shardOf(report, RECEIPT_LEDGER_FAMILY.metrics, "recall_probe.telescope.jsonl");
      expect(probe.foldable).toBe(0);
      expect(probe.protectedRecords).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("a parsed line outside the metrics record shape is unparseable, never foldable", () => {
    // The same shape gate the fold engine's classifier carries: a line
    // the scan counts unparseable must never be foldable in a confirmed
    // run, or the preview and the rewrite would disagree.
    vault = mintVault();
    try {
      writeShard(metricsDir(vault), "storage_usage.jsonl", [
        metricLine("storage_usage", "2026-08-01T00:00:00Z"),
        `${JSON.stringify({ run_at: "2026-08-02T00:00:00Z" })}\n`,
        `${JSON.stringify({ schema: METRICS_SCHEMA, surface: "storage_usage" })}\n`,
        `${JSON.stringify({ schema: METRICS_SCHEMA, surface: "storage_usage", payload: [] })}\n`,
      ]);
      const report = scanReceiptLedgers(vault, { now: NOW });
      const shard = shardOf(report, RECEIPT_LEDGER_FAMILY.metrics, "storage_usage.jsonl");
      expect(shard.records).toBe(1);
      expect(shard.unparseable).toBe(3);
      expect(shard.foldable).toBe(1);
      expect(shard.protectedRecords).toBe(0);
      expect(report.totals.foldable).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("byte sizes and vault-relative paths are reported per shard", () => {
    vault = mintVault();
    try {
      writeShard(continuityLogDir(vault), "2026-08.jsonl", [
        continuityLine("recall_telemetry", "2026-08-10T12:00:00Z"),
      ]);
      const report = scanReceiptLedgers(vault, { now: NOW });
      const shard = shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-08.jsonl");
      expect(shard.bytes).toBeGreaterThan(0);
      expect(shard.path).toBe("Brain/log/continuity/2026-08.jsonl");
      expect(report.totals.bytes).toBe(shard.bytes);
    } finally {
      cleanup();
    }
  });

  test("a record exactly at the cutoff is kept; one second earlier folds", () => {
    vault = mintVault();
    try {
      const continuity = continuityLogDir(vault);
      writeShard(continuity, "2026-08.jsonl", [
        continuityLine("recall_telemetry", "2026-08-26T00:00:00Z"),
      ]);
      writeShard(continuity, "2026-07.jsonl", [
        continuityLine("recall_telemetry", "2026-07-25T23:59:59Z"),
      ]);
      const report = scanReceiptLedgers(vault, { now: NOW, olderThanDays: 30 });
      expect(shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-08.jsonl").foldable).toBe(0);
      expect(shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-07.jsonl").foldable).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("torn lines are counted, never folded", () => {
    vault = mintVault();
    try {
      writeShard(continuityLogDir(vault), "2026-08.jsonl", [
        continuityLine("recall_telemetry", "2026-08-10T12:00:00Z"),
        "{not json\n",
      ]);
      const report = scanReceiptLedgers(vault, { now: NOW });
      const shard = shardOf(report, RECEIPT_LEDGER_FAMILY.continuity, "2026-08.jsonl");
      expect(shard.records).toBe(1);
      expect(shard.unparseable).toBe(1);
      expect(report.totals.unparseable).toBe(1);
    } finally {
      cleanup();
    }
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a shard that cannot be read is reported unreadable by name, never with filesystem detail",
    () => {
      // The error rows ride the scan view to remote callers verbatim: the
      // raw Node error text would hand them an absolute host path and an
      // absent-versus-denied oracle. The boundary reports the shard
      // unreadable, with its vault-relative name, and nothing else.
      vault = mintVault();
      try {
        const shardPath = join(continuityLogDir(vault), "2026-08.jsonl");
        writeShard(continuityLogDir(vault), "2026-08.jsonl", [
          continuityLine("recall_telemetry", "2026-08-10T12:00:00Z"),
        ]);
        chmodSync(shardPath, 0o000);
        try {
          const report = scanReceiptLedgers(vault, { now: NOW });
          expect(report.shards).toEqual([]);
          expect(report.errors).toHaveLength(1);
          const error = report.errors[0]!;
          expect(error.shard).toBe("continuity:2026-08.jsonl");
          expect(error.path).toBe("Brain/log/continuity/2026-08.jsonl");
          expect(error.message).toBe(RECEIPT_SHARD_UNREADABLE);
          const rendered = JSON.stringify(report.errors);
          expect(rendered).not.toContain("ENOENT");
          expect(rendered).not.toContain("EACCES");
          expect(rendered).not.toContain(vault);
        } finally {
          chmodSync(shardPath, 0o644);
        }
      } finally {
        cleanup();
      }
    },
  );

  test("the scan is read-only: the vault digest is byte-identical after the run", () => {
    vault = mintVault();
    try {
      writeShard(continuityLogDir(vault), "2026-08.jsonl", [
        continuityLine("recall_telemetry", "2026-08-10T12:00:00Z"),
      ]);
      writeShard(metricsDir(vault), "storage_usage.jsonl", [
        metricLine("storage_usage", "2026-08-01T00:00:00Z"),
      ]);
      const before = digestVaultTree(vault);
      scanReceiptLedgers(vault, { now: NOW });
      expect(digestVaultTree(vault)).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("a vault with no ledgers scans to an empty report without throwing", () => {
    vault = mintVault();
    try {
      rmSync(continuityLogDir(vault), { recursive: true, force: true });
      rmSync(metricsDir(vault), { recursive: true, force: true });
      const report = scanReceiptLedgers(vault, { now: NOW });
      expect(report.shards).toEqual([]);
      expect(report.totals.records).toBe(0);
      expect(report.totals.foldable).toBe(0);
      expect(report.errors).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("the age threshold defaults to the named constant and stamps the report", () => {
    vault = mintVault();
    try {
      const report = scanReceiptLedgers(vault, { now: NOW });
      expect(report.olderThanDays).toBe(RECEIPT_FOLD_DEFAULT_AGE_DAYS);
      expect(report.generated_at).toBe("2026-09-25T00:00:00Z");
    } finally {
      cleanup();
    }
  });
});

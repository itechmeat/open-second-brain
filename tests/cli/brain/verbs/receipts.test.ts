/**
 * `o2b brain receipts` at the CLI level (storage-lifecycle, Lane 3
 * task 3.4).
 *
 * Scan is the default and writes nothing. Compact previews unless
 * `--apply` is passed, never runs without explicit `--shard family:name`
 * ids from a scan, and honors the count guard before any write. The
 * parity half pins the surface vocabulary to the shared receipts modes:
 * the usage line and the brain_receipts input schema derive from the
 * same closed tuple, so the two surfaces cannot drift.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  continuityLogDir,
  continuityLogPath,
  listContinuityRecords,
} from "../../../../src/core/brain/continuity/store.ts";
import { metricsDir } from "../../../../src/core/brain/metrics.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import {
  RECEIPT_MODES,
  RECEIPT_COMPACTION_OPERATION,
} from "../../../../src/core/brain/receipts/types.ts";
import { RECEIPTS_USAGE } from "../../../../src/cli/brain/verbs/receipts.ts";
import { RECEIPT_TOOLS } from "../../../../src/mcp/brain/receipt-tools.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { digestVaultTree } from "../../../helpers/vault-digest.ts";

/** The ledger month the fixtures write; safely past any fold cutoff. */
const LEDGER_MONTH = "2026-08";

let vault: string;
let configHome: string;

function continuityLine(kind: string, createdAt: string): string {
  const id = `ctn_${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}_${kind}`;
  return `${JSON.stringify({
    schema: "o2b.continuity.v1",
    id,
    kind,
    createdAt,
    sourceRefs: [],
    payload: {},
    private: false,
    redacted: false,
  })}\n`;
}

function seedLedger(): void {
  const lines: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    lines.push(continuityLine("recall_telemetry", `${LEDGER_MONTH}-0${i + 1}T12:00:0${i}Z`));
  }
  mkdirSync(continuityLogDir(vault), { recursive: true });
  mkdirSync(metricsDir(vault), { recursive: true });
  writeFileSync(join(continuityLogDir(vault), `${LEDGER_MONTH}.jsonl`), lines.join(""), "utf8");
}

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-receipts-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-cli-receipts-cfg-"));
  atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function env(): Record<string, string> {
  return { OPEN_SECOND_BRAIN_CONFIG: join(configHome, "config.yaml") };
}

describe("o2b brain receipts", () => {
  test("scan is the default mode and writes nothing", async () => {
    seedLedger();
    const before = digestVaultTree(vault);
    const bare = await runCli(["brain", "receipts", "--json"], { env: env() });
    expect(bare.returncode).toBe(0);
    const report = JSON.parse(bare.stdout) as {
      operation: string;
      totals: { foldable: number; records: number };
      shards: Array<{ family: string; name: string; foldable: number }>;
    };
    expect(report.operation).toBe(RECEIPT_COMPACTION_OPERATION);
    expect(report.totals.records).toBe(5);
    expect(report.totals.foldable).toBe(5);
    expect(report.shards[0]!.name).toBe("2026-08.jsonl");
    expect(digestVaultTree(vault)).toBe(before);
    // The named scan mode behaves identically.
    const named = await runCli(["brain", "receipts", "scan", "--json"], { env: env() });
    expect(named.returncode).toBe(0);
    expect(JSON.parse(named.stdout).totals.foldable).toBe(5);
  });

  test("compact previews by default and writes nothing", async () => {
    seedLedger();
    const before = digestVaultTree(vault);
    const out = await runCli(
      ["brain", "receipts", "compact", "--shard", `continuity:${LEDGER_MONTH}.jsonl`, "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const result = JSON.parse(out.stdout) as {
      dry_run: boolean;
      totals: { folded: number };
    };
    expect(result.dry_run).toBe(true);
    expect(result.totals.folded).toBe(5);
    expect(digestVaultTree(vault)).toBe(before);
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(0);
  });

  test("compact --apply folds behind the count guard and appends one audit record", async () => {
    seedLedger();
    const out = await runCli(
      [
        "brain",
        "receipts",
        "compact",
        "--shard",
        `continuity:${LEDGER_MONTH}.jsonl`,
        "--apply",
        "--expect",
        "5",
        "--json",
      ],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const result = JSON.parse(out.stdout) as {
      dry_run: boolean;
      totals: { folded: number };
      audit_record_id: string;
      snapshot_run_id: string;
    };
    expect(result.dry_run).toBe(false);
    expect(result.totals.folded).toBe(5);
    expect(result.snapshot_run_id).toBeDefined();
    const audits = listContinuityRecords(vault, { kind: "receipt_compaction" });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.id).toBe(result.audit_record_id);
  });

  test("a count-guard mismatch aborts with the guard message and writes nothing", async () => {
    seedLedger();
    const before = digestVaultTree(vault);
    const out = await runCli(
      [
        "brain",
        "receipts",
        "compact",
        "--shard",
        `continuity:${LEDGER_MONTH}.jsonl`,
        "--apply",
        "--expect",
        "4",
      ],
      { env: env() },
    );
    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("--expect 4");
    expect(digestVaultTree(vault)).toBe(before);
  });

  test("compact without shard ids and a malformed shard ref are usage failures", async () => {
    const bare = await runCli(["brain", "receipts", "compact"], { env: env() });
    expect(bare.returncode).toBe(1);
    expect(bare.stderr).toContain("--shard");
    const malformed = await runCli(
      ["brain", "receipts", "compact", "--shard", "continuity:../../escape.jsonl"],
      { env: env() },
    );
    expect(malformed.returncode).toBe(1);
    expect(malformed.stderr).toContain("is not a continuity shard");
    const unknownFamily = await runCli(
      ["brain", "receipts", "compact", "--shard", "scratch:x.jsonl"],
      { env: env() },
    );
    expect(unknownFamily.returncode).toBe(1);
    expect(unknownFamily.stderr).toContain("unknown ledger family");
  });

  test("a confirmed run's text report names the net byte effect beside the recovery point", async () => {
    // M6 (confirm half): the recovery point is a whole-Brain archive in a
    // surface the storage census counts, so the report shows the ledger
    // shrink beside what the archive added - the net figure an operator
    // at a capacity tier decides on.
    seedLedger();
    const out = await runCli(
      ["brain", "receipts", "compact", "--shard", `continuity:${LEDGER_MONTH}.jsonl`, "--apply"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("recovery point:");
    expect(out.stdout).toMatch(/net: -?\d+ bytes \(ledger shrank \d+, recovery point added \d+\)/);
  });

  test("a confirmed run whose audit record cannot be appended fails loudly in text mode", async () => {
    // L10: the audit outcome rode only the JSON view, so a text-mode
    // `--apply` whose receipt_compaction record did not land exited 0
    // with no trace of the failure. A directory parked at the run month's
    // shard path makes the audit append fail after the shards are
    // durable - the run must print the named outcome and exit 1.
    seedLedger();
    const runMonth = new Date().toISOString().slice(0, 7);
    mkdirSync(continuityLogPath(vault, runMonth), { recursive: true });
    const out = await runCli(
      ["brain", "receipts", "compact", "--shard", `continuity:${LEDGER_MONTH}.jsonl`, "--apply"],
      { env: env() },
    );
    expect(out.returncode).toBe(1);
    expect(out.stdout).toContain("receipt_compaction audit record could not be appended");
    // The fold itself landed - the failure is only the audit trail's.
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(0);
  });

  test("the surface vocabulary derives from one source on both surfaces", () => {
    // The verb's usage line and the tool's mode enum come from the same
    // closed tuple, so neither surface can rename a mode alone.
    for (const mode of RECEIPT_MODES) {
      expect(RECEIPTS_USAGE).toContain(mode);
    }
    const tool = RECEIPT_TOOLS[0]!;
    const schemaModes = (
      tool.inputSchema.properties as {
        mode: { enum: string[] };
      }
    ).mode.enum;
    expect(schemaModes).toEqual([...RECEIPT_MODES]);
    expect(tool.name).toBe("brain_receipts");
  });
});

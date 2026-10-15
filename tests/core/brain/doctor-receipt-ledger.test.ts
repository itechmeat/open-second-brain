/**
 * Receipt-ledger growth doctor check (storage-lifecycle, Lane 3 task 3.3).
 *
 * A receipt ledger that keeps growing because nothing ever folded it is
 * a storage condition the operator can act on, and the act is the
 * receipts scan: the check reports a warning once a family's foldable
 * record count crosses the growth threshold, naming the command, and
 * stays silent when the ledger is compacted or young. A ledger the scan
 * cannot read is not a zero - it reaches the uncertain stream under its
 * own code, like every other measurement the doctor could not take.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { continuityLogDir } from "../../../src/core/brain/continuity/store.ts";
import { metricsDir } from "../../../src/core/brain/metrics.ts";
import {
  RECEIPT_LEDGER_GROWTH_CODE,
  RECEIPT_LEDGER_GROWTH_MIN_FOLDABLE,
  RECEIPT_LEDGER_UNMEASURED_CODE,
} from "../../../src/core/brain/doctor/receipt-ledger.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { compactReceiptLedgers } from "../../../src/core/brain/receipts/compact.ts";
import { RECEIPT_LEDGER_FAMILY } from "../../../src/core/brain/receipts/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-09-25T00:00:00Z");

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

function receiptIssues(): Array<{ code: string; message: string; path?: string }> {
  const doctor = runDoctor(vault, { now: NOW });
  return [...doctor.errors, ...doctor.warnings].filter(
    (issue) => issue.code === RECEIPT_LEDGER_GROWTH_CODE,
  );
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-receipt-ledger-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-doctor-receipt-ledger-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(continuityLogDir(vault), { recursive: true });
  mkdirSync(metricsDir(vault), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("receiptLedgerCheck", () => {
  test("a ledger above the growth threshold yields one warning naming the receipts command", () => {
    const lines: string[] = [];
    for (let i = 0; i < RECEIPT_LEDGER_GROWTH_MIN_FOLDABLE + 100; i += 1) {
      const minute = (i % 60).toString().padStart(2, "0");
      lines.push(
        continuityLine(
          "recall_telemetry",
          `2026-08-01T12:${minute}:${(i % 60).toString().padStart(2, "0")}Z`,
        ),
      );
    }
    writeFileSync(join(continuityLogDir(vault), "2026-08.jsonl"), lines.join(""), "utf8");
    const issues = receiptIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(RECEIPT_LEDGER_GROWTH_CODE);
    expect(issues[0]!.message).toContain("o2b brain receipts scan");
    expect(issues[0]!.message).toContain(`${RECEIPT_LEDGER_GROWTH_MIN_FOLDABLE + 100}`);
  });

  test("a compacted ledger yields no issue", () => {
    const lines: string[] = [];
    for (let i = 0; i < RECEIPT_LEDGER_GROWTH_MIN_FOLDABLE + 100; i += 1) {
      const minute = (i % 60).toString().padStart(2, "0");
      lines.push(
        continuityLine(
          "recall_telemetry",
          `2026-08-01T12:${minute}:${(i % 60).toString().padStart(2, "0")}Z`,
        ),
      );
    }
    writeFileSync(join(continuityLogDir(vault), "2026-08.jsonl"), lines.join(""), "utf8");
    compactReceiptLedgers(vault, {
      shards: [{ family: RECEIPT_LEDGER_FAMILY.continuity, name: "2026-08.jsonl" }],
      now: NOW,
      dryRun: false,
    });
    expect(receiptIssues()).toEqual([]);
  });

  test("a ledger below the threshold yields no issue", () => {
    writeFileSync(
      join(metricsDir(vault), "storage_usage.jsonl"),
      `${JSON.stringify({
        schema: "o2b.metrics.v1",
        surface: "storage_usage",
        run_at: "2026-08-01T00:00:00Z",
        payload: {},
      })}\n`,
      "utf8",
    );
    expect(receiptIssues()).toEqual([]);
  });

  test("a ledger the scan cannot read reaches the uncertain stream, never a zero", () => {
    // A regular file where the continuity ledger directory belongs: the
    // scan cannot enumerate it.
    rmSync(continuityLogDir(vault), { recursive: true, force: true });
    writeFileSync(continuityLogDir(vault), "not a directory\n", "utf8");
    const doctor = runDoctor(vault, { now: NOW });
    const uncertain = doctor.uncertain ?? [];
    expect(uncertain.some((entry) => entry.code === RECEIPT_LEDGER_UNMEASURED_CODE)).toBe(true);
  });

  test("both codes are classified: growth registered, unmeasured excused with a reason", async () => {
    const { DIAGNOSTIC_SIGNALS } = await import("../../../src/core/brain/diagnostics.ts");
    const { DOCTOR_EXIT_EXCLUSIONS } = await import("../../../src/core/brain/doctor-exits.ts");
    expect(DIAGNOSTIC_SIGNALS.get(RECEIPT_LEDGER_GROWTH_CODE)?.nextCommand).toBe(
      "o2b brain receipts scan",
    );
    expect(DOCTOR_EXIT_EXCLUSIONS.get(RECEIPT_LEDGER_UNMEASURED_CODE)).toBeDefined();
  });
});

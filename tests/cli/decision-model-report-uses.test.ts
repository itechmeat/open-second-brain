/**
 * `o2b decision-model report --use <use>` for every decision-model use:
 * the generic summary plus the use's own evaluation report, on an empty
 * ledger and on a ledger with one record per use, in JSON and text.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DECISION_MODEL_USES,
  type DecisionModelUse,
} from "../../src/core/decision-model/contract.ts";
import { emitDecisionModelCall } from "../../src/core/decision-model/record.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-report-uses-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface ReportJson {
  readonly total: number;
  readonly uses: ReadonlyArray<{ readonly use: string; readonly calls: number }>;
  readonly use_report?: { readonly use: string; readonly report: unknown };
}

async function report(use: DecisionModelUse, json: boolean) {
  return runCli(
    ["decision-model", "report", "--use", use, "--config", configPath, ...(json ? ["--json"] : [])],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
}

function seedOneRecordPerUse(): void {
  for (const use of DECISION_MODEL_USES) {
    emitDecisionModelCall(vault, {
      use,
      mode: "shadow",
      provider: "compatible",
      model: "fake-model-1",
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      usage: { inputTokens: 10 },
      inputPriceUsdPerMtok: 0.042,
      latencyMs: 12,
      outcome: "ok",
    });
  }
}

describe("o2b decision-model report --use", () => {
  for (const ledger of ["empty", "one record per use"] as const) {
    for (const use of DECISION_MODEL_USES) {
      test(`${use} on an ${ledger} ledger`, async () => {
        if (ledger !== "empty") seedOneRecordPerUse();
        const expectedCalls = ledger === "empty" ? 0 : 1;

        const res = await report(use, true);
        expect(res.returncode).toBe(0);
        const parsed = JSON.parse(res.stdout) as ReportJson;
        expect(parsed.total).toBe(expectedCalls);
        expect(parsed.uses.map((u) => u.use)).toEqual(expectedCalls === 0 ? [] : [use]);
        if (use === "rerank") {
          // The rerank metric is the summary's shadow agreement.
          expect(parsed.use_report).toBeUndefined();
        } else {
          expect(parsed.use_report?.use).toBe(use);
          expect(parsed.use_report?.report).toBeDefined();
        }

        const text = await report(use, false);
        expect(text.returncode).toBe(0);
        expect(text.stdout).toContain(`decision model calls: ${expectedCalls}`);
        if (use !== "rerank") expect(text.stdout).toContain(use);
      });
    }
  }
});

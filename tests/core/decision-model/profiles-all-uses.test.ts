/**
 * Threshold profiles hold for every use, not only rerank: `enforce` on a
 * profile without tuned thresholds (`laya`, `openjev`, `llm-emulation`)
 * runs as `shadow` for each of the eight uses, `runDecision` reports and
 * records `shadow`, and `check` lists every use with its configured mode
 * and names each shadow-only one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decisionModelModeFor,
  resolveDecisionModelConfig,
} from "../../../src/core/decision-model/config.ts";
import { DECISION_MODEL_USES } from "../../../src/core/decision-model/contract.ts";
import {
  buildDecisionModelCheck,
  renderDecisionModelCheck,
} from "../../../src/core/decision-model/diagnostics.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { runDecision } from "../../../src/core/decision-model/run.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

const ALL_ENFORCE = DECISION_MODEL_USES.map((use) => `${use}:enforce`).join(",");
const KEY_VAR = "O2B_TEST_PROFILES_ALL_USES_KEY";

const PROFILES: Record<string, Record<string, string>> = {
  laya: { decision_model_provider: "laya" },
  openjev: { decision_model_provider: "openjev" },
  "llm-emulation": {
    decision_model_provider: "llm-emulation",
    decision_model_base_url: "http://127.0.0.1:9/v1",
    decision_model_id: "fake-chat-1",
    decision_model_env_key: KEY_VAR,
    decision_model_allow_uncalibrated: "true",
  },
};

let tmp: string;
let vault: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-profiles-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function config(profile: string): Record<string, string> {
  return {
    decision_model_enabled: "true",
    decision_model_uses: ALL_ENFORCE,
    ...PROFILES[profile],
  };
}

const ENV = { [KEY_VAR]: FAKE_DECISION_KEY };

describe("enforce on an untuned threshold profile runs as shadow for every use", () => {
  for (const profile of Object.keys(PROFILES)) {
    test(profile, async () => {
      const cfg = resolveDecisionModelConfig({ env: ENV, config: config(profile), vault });
      expect(cfg.status).toBe("active");
      expect(cfg.thresholdProfile).toBe(profile);
      expect(cfg.shadowOnlyUses).toEqual([...DECISION_MODEL_USES]);

      for (const use of DECISION_MODEL_USES) {
        expect(`${use}: ${cfg.configuredUses[use]}`).toBe(`${use}: enforce`);
        expect(`${use}: ${decisionModelModeFor(cfg, use)}`).toBe(`${use}: shadow`);
        const result = await runDecision(
          use,
          () => ({
            kind: "ok",
            state: { items: { I0: "text" } },
            candidateCount: 1,
            context: null,
          }),
          () => ({ q_0: { type: "noul", instructions: "Is it?" } }),
          { config: cfg, provider: new FakeDecisionProvider() },
        );
        expect(`${use}: ${result.status}`).toBe(`${use}: ok`);
        expect(result.status === "ok" ? `${use}: ${result.mode}` : "").toBe(`${use}: shadow`);
      }
      const records = listDecisionModelCalls(vault);
      expect(records.map((r) => String(r.payload["use"])).toSorted()).toEqual(
        [...DECISION_MODEL_USES].toSorted(),
      );
      expect(new Set(records.map((r) => r.payload["mode"]))).toEqual(new Set(["shadow"]));
    });
  }

  test("check lists all eight uses and names each shadow-only one", async () => {
    const report = await buildDecisionModelCheck({ config: config("laya"), vault, env: ENV });
    expect(report.shadow_only_uses).toEqual([...DECISION_MODEL_USES]);
    const text = renderDecisionModelCheck(report);
    const usesLine = text.split("\n").find((line) => line.startsWith("  uses: ")) ?? "";
    expect(usesLine).toBe(`  uses: ${DECISION_MODEL_USES.map((u) => `${u}:enforce`).join(", ")}`);
    const warning = text.split("\n").find((line) => line.includes("enforce runs as shadow")) ?? "";
    for (const use of DECISION_MODEL_USES) expect(warning).toContain(use);
  });
});

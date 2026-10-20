/**
 * The eval surfaces (cycle 20261020, card t_4e1681b3, task C4): the
 * measured tuning state in `o2b decision-model check`, the eval section
 * of `report`, and the prose/JSON rendering the CLI shows for both.
 *
 * The check is where an untuned use's shadow hold is explained; with a
 * valid machine-side mark the same line names the spec hash the mark was
 * accepted under, and a tampered or stale mark reads as untuned again -
 * the fail-closed direction, visible on the surface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRequest } from "../../../src/core/decision-model/contract.ts";
import {
  buildDecisionModelCheck,
  buildDecisionModelReport,
  renderDecisionModelCheck,
  renderDecisionModelReport,
} from "../../../src/core/decision-model/diagnostics.ts";
import {
  decisionEvalSpecFor,
  decisionEvalSpecHash,
} from "../../../src/core/decision-model/eval-spec.ts";
import { runDecisionModelEval } from "../../../src/core/decision-model/eval/grade.ts";
import {
  decisionModelTuningMarkPath,
  resetTuningMarkCache,
} from "../../../src/core/decision-model/eval/mark.ts";
import type { ResolvedDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import type { PlatformDirsEnv } from "../../../src/core/platform-dirs.ts";
import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { resetDecisionSpendCache } from "../../../src/core/decision-model/record.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

let tmp: string;
let vault: string;
let stateEnv: PlatformDirsEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-eval-surface-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  stateEnv = { platform: "linux", home: tmp, env: { XDG_STATE_HOME: join(tmp, "state") } };
  resetTuningMarkCache();
  resetDecisionSpendCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetTuningMarkCache();
  resetDecisionSpendCache();
});

/** Answers by the fixtures' labeling rule: an on-topic passage helps. */
function byLabelRule(id: string, req: DecisionRequest): number {
  const state = req.state as {
    query?: string;
    prompt?: string;
    passages?: Record<string, string>;
    notes?: Record<string, string>;
  };
  const subject = /the (.+)\?/.exec(state.query ?? state.prompt ?? "")![1]!;
  const key = id.startsWith("rel_") ? `P${id.slice(4)}` : null;
  if (key === null) return 0.5;
  const text = state.passages?.[key] ?? "";
  return text.includes(subject) ? 0.99 : 0.01;
}

function evalConfig(): ResolvedDecisionModelConfig {
  const uses = {
    rerank: "shadow",
    answerable: "off",
    skills: "off",
    extract_prefilter: "off",
    dedup: "off",
    tension: "off",
    labels: "off",
    recall_inject: "off",
  } as ResolvedDecisionModelConfig["uses"];
  return {
    status: "active",
    errors: [],
    notes: [],
    enabled: true,
    provider: "compatible",
    adapter: "systemone",
    baseUrl: "http://127.0.0.1:9",
    model: "fake-model-1",
    envKey: "FAKE_DECISION_KEY_UNUSED",
    keyPresent: true,
    allowInsecureHttp: false,
    timeoutMs: 3000,
    hookBudgetMs: 700,
    maxStateTokens: 32_000,
    uses,
    configuredUses: uses,
    dailyCostGateUsd: 0.5,
    inputPriceUsdPerMtok: 0.042,
    allowUncalibrated: false,
    calibrated: true,
    thresholdProfile: "laya",
    shadowOnlyUses: ["rerank"],
    processor: null,
    vault,
  };
}

const CHECK_CONFIG = {
  decision_model_enabled: "true",
  decision_model_provider: "compatible",
  decision_model_base_url: "http://127.0.0.1:9",
  decision_model_id: "fake-model-1",
  decision_model_threshold_profile: "laya",
  decision_model_uses: "rerank:shadow",
} as const;

function checkWith(markSource: PlatformDirsEnv | null) {
  return buildDecisionModelCheck({ config: { ...CHECK_CONFIG }, vault, markSource });
}

describe("the check's measured tuning state", () => {
  test("no mark reads as untuned, on the record and in the prose", async () => {
    const report = await checkWith(stateEnv);
    expect(report.tuning).toMatchObject({ profile: "laya", state: "untuned", marked_uses: [] });
    const text = renderDecisionModelCheck(report);
    expect(text).toContain("tuning: profile 'laya' is untuned");
    expect(text).toContain("eval run");
  });

  test("a valid mark reads as measured under its spec hash, naming the uses", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const report = await checkWith(stateEnv);
    const spec = decisionEvalSpecFor("rerank")!;
    expect(report.tuning.state).toBe("measured");
    expect(report.tuning.marked_uses).toEqual([
      { use: "rerank", spec_hash: decisionEvalSpecHash(spec) },
    ]);
    const text = renderDecisionModelCheck(report);
    expect(text).toContain(
      `tuning: profile 'laya' measured under spec hash ${decisionEvalSpecHash(spec).slice(0, 12)}… (rerank)`,
    );
  });

  test("a mark measured on model A reads as measured elsewhere, not measured, on model B", async () => {
    // The mark is bound to the endpoint that earned it (provider, model,
    // base-url hash). The gate reader refuses it for another endpoint and
    // holds the use shadow - so the check must not claim measured-enforce
    // here either: it names the mark and why it does not arm.
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const spec = decisionEvalSpecFor("rerank")!;
    const elsewhere = await buildDecisionModelCheck({
      config: { ...CHECK_CONFIG, decision_model_id: "fake-model-2" },
      vault,
      markSource: stateEnv,
    });
    expect(elsewhere.tuning.state).toBe("measured_elsewhere");
    expect(elsewhere.tuning.marked_uses).toEqual([]);
    expect(elsewhere.tuning.elsewhere_uses).toEqual([
      { use: "rerank", spec_hash: decisionEvalSpecHash(spec) },
    ]);
    const text = renderDecisionModelCheck(elsewhere);
    expect(text).toContain("on another endpoint (provider, model or base-url mismatch)");
    expect(text).toContain("enforce holds as shadow");
    // The same holds when only the base URL moved and the model stayed.
    const movedUrl = await buildDecisionModelCheck({
      config: { ...CHECK_CONFIG, decision_model_base_url: "http://127.0.0.1:10" },
      vault,
      markSource: stateEnv,
    });
    expect(movedUrl.tuning.state).toBe("measured_elsewhere");
    expect(renderDecisionModelCheck(movedUrl)).toContain("on another endpoint");
  });

  test("a tampered mark fails closed to untuned on the surface", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    const path = decisionModelTuningMarkPath(stateEnv, "laya", "rerank");
    const valid = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...valid, fixture_hash: "0".repeat(64) }), "utf8");
    resetTuningMarkCache();
    const report = await checkWith(stateEnv);
    expect(report.tuning.state).toBe("untuned");
  });

  test("the baseline profile says baseline; no profile says none", async () => {
    // A hosted Jev-family route carries the baseline profile by preset.
    const baseline = await buildDecisionModelCheck({
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "vercel",
        decision_model_uses: "rerank:shadow",
      },
      vault,
      markSource: stateEnv,
      env: { AI_GATEWAY_API_KEY: "unused" } as unknown as NodeJS.ProcessEnv,
    });
    expect(baseline.tuning).toMatchObject({ profile: "jev-1.13", state: "baseline" });
    expect(renderDecisionModelCheck(baseline)).toContain("is the baseline");

    const noProfile = await buildDecisionModelCheck({
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "compatible",
        decision_model_base_url: "http://127.0.0.1:9",
        decision_model_id: "fake-model-1",
        decision_model_uses: "rerank:shadow",
      },
      vault,
      markSource: stateEnv,
    });
    expect(noProfile.tuning).toMatchObject({ profile: null, state: "none", marked_uses: [] });
    expect(renderDecisionModelCheck(noProfile)).toContain("no threshold profile resolves");
  });
});

describe("the check's cached eval grades", () => {
  test("lists cached grade records per use and skips malformed ones by count", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    appendContinuityRecord(vault, {
      kind: "decision_model_eval_grade",
      createdAt: new Date().toISOString(),
      sourceRefs: [],
      payload: { use: "rerank", verdict: "promote" },
    });
    const report = await checkWith(stateEnv);
    expect(report.eval_grades.total).toBe(1);
    expect(report.eval_grades.skipped).toHaveLength(1);
    expect(report.eval_grades.uses[0]).toMatchObject({
      use: "rerank",
      runs: 1,
      last_verdict: "promote",
    });
    const text = renderDecisionModelCheck(report);
    expect(text).toContain("eval grades: 1 record(s)");
    expect(text).toContain("rerank: 1 run(s), last promote");
    expect(text).toContain("1 skipped");
  });

  test("no grades at all reads as none cached", async () => {
    const report = await checkWith(stateEnv);
    expect(report.eval_grades.total).toBe(0);
    expect(renderDecisionModelCheck(report)).toContain("eval grades: none cached");
  });
});

describe("the report's eval section", () => {
  test("carries the cached grades, oldest first, and skips malformed by note", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: () => 0.01 }),
      markSource: stateEnv,
    });
    appendContinuityRecord(vault, {
      kind: "decision_model_eval_grade",
      createdAt: new Date().toISOString(),
      sourceRefs: [],
      payload: { verdict: "promote" },
    });
    const report = buildDecisionModelReport(vault);
    expect(report.eval).toBeDefined();
    expect(report.eval!.grades).toHaveLength(2);
    expect(report.eval!.grades[0]!.verdict).toBe("promote");
    expect(report.eval!.grades[1]!.verdict).toBe("hold");
    expect(report.eval!.skipped).toHaveLength(1);
    expect(report.eval!.skipped[0]).toMatch(/decision_model_eval_grade record .+ skipped:/);

    const text = renderDecisionModelReport(report);
    expect(text).toContain("eval grades: 2 record(s)");
    expect(text).toContain("rerank (laya) promote: counted error 0.000 over n=30");
    // A constant answer leaves the input order in place: the counted
    // error is exactly the input-order baseline's, and the verdict holds.
    expect(text).toContain("rerank (laya) hold: counted error 0.733 over n=30");
    expect(text).toContain("skipped: decision_model_eval_grade record");
  });

  test("a vault with no grades renders no eval section", () => {
    const report = buildDecisionModelReport(vault);
    expect(report.eval).toBeUndefined();
    expect(renderDecisionModelReport(report)).not.toContain("eval grades:");
  });
});

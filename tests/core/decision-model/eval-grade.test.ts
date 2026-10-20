/**
 * The graded eval runner and its cached verdict records (cycle 20261020,
 * card t_4e1681b3, task C2).
 *
 * The runner verifies the preregistration (spec receipt, fixture hash)
 * before it sends anything, runs one decision request per take item with
 * `recordOrigin: "eval"`, and caches the verdicts as
 * `decision_model_eval_grade` records stamped with the spec hash. Eval
 * requests are real spend: they count toward the daily cost gate but
 * stay out of the rerank shadow agreement. The graded eval itself runs
 * against the fake provider - no real model calls in tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRequest } from "../../../src/core/decision-model/contract.ts";
import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import type { ResolvedDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import {
  decisionEvalSpecFor,
  decisionEvalSpecHash,
  type DecisionEvalSpec,
} from "../../../src/core/decision-model/eval-spec.ts";
import { runDecisionModelEval } from "../../../src/core/decision-model/eval/grade.ts";
import { buildDecisionModelReport } from "../../../src/core/decision-model/diagnostics.ts";
import {
  listDecisionModelCalls,
  listDecisionModelEvalGrades,
  resetDecisionSpendCache,
  todaySpendUsd,
} from "../../../src/core/decision-model/record.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-eval-grade-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  resetDecisionSpendCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetDecisionSpendCache();
});

/** The subject each fixture query prompts about, by the fixtures' own rule. */
function subjectOf(query: string): string {
  return /the (.+)\?/.exec(query)![1]!;
}

/** Answers relevance/helps by the fixtures' labeling rule: on-topic helps. */
function byLabelRule(id: string, req: DecisionRequest): number {
  const state = req.state as {
    query?: string;
    prompt?: string;
    passages?: Record<string, string>;
    notes?: Record<string, string>;
  };
  const subject = subjectOf(state.query ?? state.prompt ?? "");
  const key = id.startsWith("rel_")
    ? `P${id.slice(4)}`
    : id.startsWith("helps_")
      ? `N${id.slice(6)}`
      : null;
  if (key === null) return 0.5;
  const text = state.passages?.[key] ?? state.notes?.[key] ?? "";
  return text.includes(subject) ? 0.99 : 0.01;
}

const INVERTED = (id: string, req: DecisionRequest): number =>
  byLabelRule(id, req) > 0.5 ? 0.01 : 0.99;

function evalConfig(
  overrides: Partial<ResolvedDecisionModelConfig> = {},
): ResolvedDecisionModelConfig {
  const uses = {
    rerank: "shadow",
    answerable: "off",
    skills: "off",
    extract_prefilter: "off",
    dedup: "off",
    tension: "off",
    labels: "off",
    recall_inject: "shadow",
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
    shadowOnlyUses: ["rerank", "recall_inject"],
    processor: null,
    vault,
    ...overrides,
  };
}

describe("runDecisionModelEval", () => {
  test("a provider that answers by the labeling rule promotes the rerank use", async () => {
    const spec = decisionEvalSpecFor("rerank")!;
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
    });
    expect(result.verdict).toBe("promote");
    expect(result.use).toBe("rerank");
    expect(result.profile).toBe("laya");
    expect(result.spec_hash).toBe(decisionEvalSpecHash(spec));
    expect(result.counted.n).toBe(30);
    expect(result.counted.error).toBe(0);
    // The committed take holds the gold-relevant candidate first on only
    // 11 of 43 items, and the counted split of those is 8 - the
    // input-order baseline must not look better than it is.
    expect(result.baseline_error).toBeCloseTo(22 / 30, 10);
    // One grade record, stamped with the spec hash and the correlated
    // per-item request ids.
    const { grades, skipped } = listDecisionModelEvalGrades(vault);
    expect(skipped).toEqual([]);
    expect(grades).toHaveLength(1);
    const grade = grades[0]!;
    expect(grade.use).toBe("rerank");
    expect(grade.profile).toBe("laya");
    expect(grade.specHash).toBe(decisionEvalSpecHash(spec));
    expect(grade.countedIds).toHaveLength(30);
    expect(grade.devIds).toHaveLength(13);
    expect(Object.entries(grade.verdicts)).toHaveLength(30);
    for (const verdict of Object.values(grade.verdicts)) expect(verdict).toBe(true);
    expect(grade.callIds).toHaveLength(43);
    expect(grade.verdict).toBe("promote");
    expect(grade.metric).toBe("counted_error_rate");
  });

  test("a provider that ranks the relevant candidate last holds, and the record says so", async () => {
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: INVERTED }),
    });
    expect(result.verdict).toBe("hold");
    expect(result.counted.error).toBe(1);
    const { grades } = listDecisionModelEvalGrades(vault);
    expect(grades[0]!.verdict).toBe("hold");
    expect(grades[0]!.countedError).toBe(1);
    for (const verdict of Object.values(grades[0]!.verdicts)) expect(verdict).toBe(false);
  });

  test("eval requests carry origin eval, count as spend, and stay out of shadow agreement", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
    });
    const calls = listDecisionModelCalls(vault);
    expect(calls.length).toBe(43);
    for (const call of calls) {
      expect(`origin: ${String(call.payload["origin"])}`).toBe("origin: eval");
      expect(`mode: ${String(call.payload["mode"])}`).toBe("mode: enforce");
    }
    expect(todaySpendUsd(vault)).toBeGreaterThan(0);
    // The agreement compares shadow records only; eval records are kept
    // out of it (diagnostics agreementOf skips any record with an origin).
    const report = buildDecisionModelReport(vault, { use: "rerank" });
    const rerank = report.uses.find((u) => u.use === "rerank");
    expect(rerank?.agreement).toBeUndefined();
  });

  test("a spec whose counted take is below its minimum n is not enough evidence", async () => {
    const registry = decisionEvalSpecFor("rerank")!;
    const spec: DecisionEvalSpec = {
      ...registry,
      min_counted: registry.receipt.counted.length + 1,
    };
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      spec,
    });
    expect(result.verdict).toBe("not_enough_evidence");
    const { grades } = listDecisionModelEvalGrades(vault);
    expect(grades[0]!.specHash).toBe(decisionEvalSpecHash(spec));
    expect(grades[0]!.specHash).not.toBe(decisionEvalSpecHash(registry));
  });

  test("degraded requests shrink the counted n instead of counting as misses", async () => {
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ fail: "timeout" }),
    });
    expect(result.degraded_n).toBe(43);
    expect(result.counted.n).toBe(0);
    expect(result.verdict).toBe("not_enough_evidence");
  });

  test("the recall_inject use grades regret against the pinned drop floor", async () => {
    const promoted = await runDecisionModelEval("recall_inject", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
    });
    expect(promoted.verdict).toBe("promote");
    expect(promoted.counted.n).toBe(20);
    expect(promoted.counted.error).toBe(0);
    // A useful note rated below the pinned note_min floor is regret.
    const regretful = await runDecisionModelEval("recall_inject", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: INVERTED }),
    });
    expect(regretful.verdict).toBe("hold");
    expect(regretful.counted.error).toBe(1);
  });

  test("refuses a use with no preregistered spec and an inactive config", async () => {
    await expect(
      runDecisionModelEval("dedup", {
        config: evalConfig(),
        provider: new FakeDecisionProvider({ answer: byLabelRule }),
      }),
    ).rejects.toThrow(/no preregistered spec/);
    await expect(
      runDecisionModelEval("rerank", {
        config: evalConfig({ status: "no_key" }),
        provider: new FakeDecisionProvider({ answer: byLabelRule }),
      }),
    ).rejects.toThrow(/active/);
  });

  test("the runner verifies the preregistration before sending anything", async () => {
    const registry = decisionEvalSpecFor("rerank")!;
    const tampered: DecisionEvalSpec = {
      ...registry,
      receipt: { dev: registry.receipt.dev, counted: registry.receipt.counted.slice(1) },
    };
    const provider = new FakeDecisionProvider({ answer: byLabelRule });
    await expect(
      runDecisionModelEval("rerank", { config: evalConfig(), provider, spec: tampered }),
    ).rejects.toThrow(/preregistration/);
    expect(provider.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  });
});

describe("listDecisionModelEvalGrades", () => {
  test("skips a malformed grade record with a named note", async () => {
    await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
    });
    // A hand-written record that claims a measurement but lacks the
    // fields every real grade carries.
    appendContinuityRecord(vault, {
      kind: "decision_model_eval_grade",
      createdAt: new Date().toISOString(),
      sourceRefs: [],
      payload: { use: "rerank", verdict: "promote" },
    });
    const { grades, skipped } = listDecisionModelEvalGrades(vault);
    expect(grades).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/decision_model_eval_grade/);
    expect(skipped[0]).toMatch(/spec_hash/);
  });
});

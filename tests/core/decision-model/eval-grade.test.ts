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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRequest } from "../../../src/core/decision-model/contract.ts";
import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import type { ResolvedDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import {
  DECISION_EVAL_DEV_FRACTION,
  DECISION_EVAL_METRIC,
  DECISION_EVAL_SPEC_VERSION,
  DECISION_EVAL_SPLIT_RULE,
  decisionEvalSpecFor,
  decisionEvalSpecHash,
  type DecisionEvalSpec,
} from "../../../src/core/decision-model/eval-spec.ts";
import { runDecisionModelEval } from "../../../src/core/decision-model/eval/grade.ts";
import {
  resetTuningMarkCache,
  validatedTuningMark,
} from "../../../src/core/decision-model/eval/mark.ts";
import {
  hashOrderSplit,
  loadDecisionEvalFixture,
} from "../../../src/core/decision-model/eval/take.ts";
import { canonicalJson, sha256Hex } from "../../../src/core/integrity/digest.ts";
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
let stateEnv: Parameters<typeof validatedTuningMark>[2];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-eval-grade-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  stateEnv = { platform: "linux", home: tmp, env: { XDG_STATE_HOME: join(tmp, "state") } };
  resetDecisionSpendCache();
  resetTuningMarkCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetDecisionSpendCache();
  resetTuningMarkCache();
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

  test("the eval asks inject_any and grades its abstain arm like enforce does", async () => {
    // High helps everywhere, but inject_any below the pinned any_min: the
    // enforced filter abstains the whole brief (every note was sent), so
    // every useful note is lost - real regret the metric must see.
    const provider = new FakeDecisionProvider({
      answer: (id, req) => (id === "inject_any" ? 0.01 : byLabelRule(id, req)),
    });
    const result = await runDecisionModelEval("recall_inject", {
      config: evalConfig(),
      provider,
    });
    expect(Object.keys(provider.requests[0]!.questions)).toContain("inject_any");
    expect(result.verdict).toBe("hold");
    expect(result.counted.n).toBe(20);
    expect(result.counted.error).toBe(1);
    const { grades } = listDecisionModelEvalGrades(vault);
    expect(grades).toHaveLength(1);
    expect(grades[0]!.verdict).toBe("hold");
    for (const verdict of Object.values(grades[0]!.verdicts)) expect(verdict).toBe(false);
  });

  test("an inject_any answer above the abstain floor does not manufacture regret", async () => {
    const result = await runDecisionModelEval("recall_inject", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({
        answer: (id, req) => (id === "inject_any" ? 0.99 : byLabelRule(id, req)),
      }),
    });
    expect(result.verdict).toBe("promote");
    expect(result.counted.error).toBe(0);
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

  test("an ok reply whose every answer is invalid degrades instead of matching the baseline", async () => {
    // Every relevance answer unusable: the enforced reorder has no usable
    // answer either, so the item shrinks n - it must never count as a
    // full-n sample whose verdict equals the input-order baseline.
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: () => ({ invalid: true }) }),
    });
    expect(result.degraded_n).toBe(43);
    expect(result.counted.n).toBe(0);
    expect(result.verdict).toBe("not_enough_evidence");
  });

  test("an invalid first answer still pins the top slot like the enforced reorder", async () => {
    // One unusable answer with the rest usable is not degradation: the
    // enforced reorder pins the unanswered candidate at index 0.
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({
        answer: (id) => (id === "rel_0" ? { invalid: true } : 0.5),
      }),
    });
    expect(result.degraded_n).toBe(0);
    expect(result.counted.n).toBe(30);
    expect(result.counted.error).toBeCloseTo(22 / 30, 10);
  });

  test("scoring is canonical: an early invalid answer does not mask a later below-floor note", async () => {
    // Two counted items carry the same answers in opposite slot order:
    // one useful note with no usable answer and one valid answer below
    // the pinned note_min. The below-floor note is dropped in enforce on
    // both, so both are counted failures - the first slot's invalid
    // answer must not turn the item into a shrunk-n degrade.
    const seed = "order-scoring";
    const ids = ["ord-1", "ord-2", "ord-3", "ord-4", "ord-5", "ord-6", "ord-7"];
    const { dev, counted } = hashOrderSplit(seed, ids);
    const [invalidFirst, floorFirst] = counted.slice(0, 2);
    const fillerSubjects = new Map(
      ids
        .filter((id) => id !== invalidFirst && id !== floorFirst)
        .map((id, i) => [id, ["marmalade", "ballast", "kestrel", "vellum", "tundra"][i]!]),
    );
    const note = (
      subject: string,
      useful: boolean,
    ): { title: string; text: string; useful: boolean } => ({
      title: `${subject} note`,
      text: useful ? `all about ${subject}` : "nothing about anything",
      useful,
    });
    const raw = {
      use: "recall_inject",
      items: ids.map((id) => {
        if (id === invalidFirst || id === floorFirst) {
          const subject = id === invalidFirst ? "arduino" : "beadwork";
          return {
            id,
            kind: "recall_inject",
            prompt: `What should I know about the ${subject}?`,
            notes: [note(subject, true), note(`${subject} second`, true)],
          };
        }
        const subject = fillerSubjects.get(id)!;
        return {
          id,
          kind: "recall_inject",
          prompt: `What should I know about the ${subject}?`,
          notes: [note(subject, true), note("unrelated", false)],
        };
      }),
    };
    const fixturePath = join(tmp, "order-take.json");
    writeFileSync(fixturePath, JSON.stringify(raw), "utf8");
    const spec: DecisionEvalSpec = {
      version: DECISION_EVAL_SPEC_VERSION,
      use: "recall_inject",
      fixture: fixturePath,
      seed,
      split: { rule: DECISION_EVAL_SPLIT_RULE, dev_fraction: DECISION_EVAL_DEV_FRACTION },
      receipt: { dev, counted },
      fixture_hash: sha256Hex(canonicalJson(raw)),
      metric: DECISION_EVAL_METRIC,
      ceiling: 0,
      min_counted: counted.length,
      thresholds: { any_min: 0.2, note_min: 0.2 },
    };
    const provider = new FakeDecisionProvider({
      answer: (id, req) => {
        const prompt = (req.state as { prompt?: string }).prompt ?? "";
        if (prompt.includes("arduino")) {
          if (id === "helps_0") return { invalid: true };
          if (id === "helps_1") return 0.01;
        }
        if (prompt.includes("beadwork")) {
          if (id === "helps_0") return 0.01;
          if (id === "helps_1") return { invalid: true };
        }
        return byLabelRule(id, req);
      },
    });
    const result = await runDecisionModelEval("recall_inject", {
      config: evalConfig(),
      provider,
      spec,
    });
    expect(result.degraded_n).toBe(0);
    expect(result.counted.n).toBe(4);
    expect(result.counted.error).toBe(0.5);
    expect(result.baseline_error).toBe(0);
    expect(result.verdict).toBe("hold");
    const { grades } = listDecisionModelEvalGrades(vault);
    expect(grades[0]!.verdicts[invalidFirst]).toBe(false);
    expect(grades[0]!.verdicts[floorFirst]).toBe(false);
  });

  test("a grade record correlates only its own run's calls", async () => {
    await runDecisionModelEval("recall_inject", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
    });
    await runDecisionModelEval("recall_inject", {
      config: evalConfig(),
      provider: new FakeDecisionProvider({ answer: INVERTED }),
    });
    const { grades } = listDecisionModelEvalGrades(vault);
    expect(grades).toHaveLength(2);
    // The take has 29 items: each record lists this run's one call per
    // item, never the earlier runs' calls with the same item ids.
    const [first, second] = grades;
    expect(first!.callIds).toHaveLength(29);
    expect(second!.callIds).toHaveLength(29);
    expect(second!.callIds.filter((id) => first!.callIds.includes(id))).toEqual([]);
  });

  test("a promote with no grade evidence refuses the mark by name", async () => {
    // No vault: nothing was recorded, so the promote has no review
    // evidence a reviewer could audit the mark against - the run
    // measures, but the gate input is never written.
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig({ vault: null }),
      provider: new FakeDecisionProvider({ answer: byLabelRule }),
      markSource: stateEnv,
    });
    expect(result.verdict).toBe("promote");
    expect(result.grade_record_id).toBeNull();
    expect(result.mark_written).toBe(false);
    expect(result.mark_note).toMatch(/grade record/);
    expect(validatedTuningMark("laya", "rerank", stateEnv)).toBeNull();
  });

  test("a promote whose counted spend passed the daily cost gate refuses the mark", async () => {
    // Every request starts under the gate but the run's total lands past
    // it: the verdict is promote and the spend is real, yet the mark
    // waits for a run whose counted spend stayed under the gate.
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig({ dailyCostGateUsd: 42.5, inputPriceUsdPerMtok: 1 }),
      provider: new FakeDecisionProvider({
        answer: byLabelRule,
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      }),
      markSource: stateEnv,
    });
    expect(result.verdict).toBe("promote");
    expect(result.counted.n).toBe(30);
    expect(result.counted.error).toBe(0);
    expect(todaySpendUsd(vault)).toBeGreaterThanOrEqual(42.5);
    expect(result.mark_written).toBe(false);
    expect(result.mark_note).toMatch(/cost gate/);
    expect(validatedTuningMark("laya", "rerank", stateEnv)).toBeNull();
  });

  test("a counted error past the baseline holds even under a permissive ceiling", async () => {
    // The no-regression arm is a refusal in its own right, distinct from
    // the ceiling: this provider answers the labeling rule on the dev
    // split only, so the counted split regresses past the input-order
    // baseline (error 1 against 22/30) while staying under this spec's
    // permissive ceiling of 1. Only the baseline comparison refuses the
    // promote - and with it, the tuning mark.
    const registry = decisionEvalSpecFor("rerank")!;
    // Queries repeat across the take, so the split is keyed by request
    // order: the runner sends exactly one request per item, in fixture
    // order.
    const items = loadDecisionEvalFixture(registry.fixture, "rerank").fixture.items;
    const countedIndexes = new Set(
      items
        .map((item, i) => (registry.receipt.counted.includes(item.id) ? i : -1))
        .filter((i) => i >= 0),
    );
    const spec: DecisionEvalSpec = { ...registry, ceiling: 1 };
    // One index per distinct request object (the fake answers per
    // question, so a counter would run several times per item).
    const indexOfRequest = new Map<DecisionRequest, number>();
    const provider = new FakeDecisionProvider({
      answer: (id, req) => {
        let i = indexOfRequest.get(req);
        if (i === undefined) {
          i = indexOfRequest.size;
          indexOfRequest.set(req, i);
        }
        return countedIndexes.has(i) ? INVERTED(id, req) : byLabelRule(id, req);
      },
    });
    const result = await runDecisionModelEval("rerank", {
      config: evalConfig(),
      provider,
      spec,
      markSource: stateEnv,
    });
    expect(result.dev.error).toBe(0);
    expect(result.counted.error).toBe(1);
    expect(result.counted.error!).toBeLessThanOrEqual(spec.ceiling);
    expect(result.baseline_error!).toBeLessThan(result.counted.error!);
    expect(result.verdict).toBe("hold");
    expect(result.mark_written).toBe(false);
    const { grades } = listDecisionModelEvalGrades(vault);
    expect(grades[0]!.verdict).toBe("hold");
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

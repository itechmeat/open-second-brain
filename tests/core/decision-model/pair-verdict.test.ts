/**
 * The pair-verdict helper (issue #213, Part 5): batching under the state
 * budget, the privacy filter per side, failure handling and the enforce
 * ordering that only reorders and marks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  orderByVerdicts,
  runPairVerdicts,
  verdictFields,
  type PairVerdictSpec,
  type VerdictPairInput,
} from "../../../src/core/decision-model/pair-verdict.ts";
import {
  DEDUP_QUESTIONS,
  PAIR_VERDICT_LIMITS,
} from "../../../src/core/decision-model/questions.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { estimateTokens } from "../../../src/core/decision-model/state.ts";
import { activeDecisionConfig } from "../../helpers/fake-decision-provider.ts";
import { FakeChoiceProvider } from "../../helpers/fake-choice-decision.ts";

const SPEC: PairVerdictSpec = {
  use: "dedup",
  pairKind: "preference",
  options: DEDUP_QUESTIONS.options,
  clipChars: DEDUP_QUESTIONS.clipChars,
  question: DEDUP_QUESTIONS.preference,
};

const PUBLIC = { visibility: [], privateRegions: [] } as const;

function pair(i: number, text = `rule number ${i}`): VerdictPairInput {
  return {
    id: `f${i}`,
    a: `pref-a${i}`,
    b: `pref-b${i}`,
    sideA: { text: `${text} a`, ...PUBLIC },
    sideB: { text: `${text} b`, ...PUBLIC },
  };
}

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pair-verdict-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const dedupEnforce = (over: Record<string, unknown> = {}) =>
  activeDecisionConfig({
    vault,
    uses: { ...activeDecisionConfig().uses, rerank: "off", dedup: "enforce" },
    ...over,
  });

describe("batching", () => {
  test("every request fits the budget; a pair too large alone gets no verdict", async () => {
    const provider = new FakeChoiceProvider(() => ({ choice: "same", p: 0.9 }));
    const pairs = Array.from({ length: 12 }, (_, i) => pair(i));
    // Both sides clipped to 600 characters still exceed the budget alone.
    pairs.push({
      ...pair(12),
      sideA: { text: "z".repeat(5000), ...PUBLIC },
      sideB: { text: "y".repeat(5000), ...PUBLIC },
    });
    const budget = 700;
    const run = await runPairVerdicts(pairs, SPEC, {
      config: dedupEnforce({ maxStateTokens: budget }),
      provider,
    });
    expect(provider.requests.length).toBeGreaterThan(1);
    for (const req of provider.requests) {
      expect(estimateTokens({ state: req.state, questions: req.questions })).toBeLessThanOrEqual(
        budget,
      );
    }
    expect(run.status === "done" && run.verdicts.map((v) => v !== null)).toEqual([
      ...Array.from({ length: 12 }, () => true),
      false,
    ]);
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(provider.requests.length);
    expect(records.every((r) => r.payload["budget_dropped_count"] === 1)).toBe(true);
  });

  test("caps pairs per request and requests per call", async () => {
    const provider = new FakeChoiceProvider(() => ({ choice: "same", p: 0.9 }));
    const n = PAIR_VERDICT_LIMITS.maxPairsPerRequest * PAIR_VERDICT_LIMITS.maxRequests + 3;
    const run = await runPairVerdicts(
      Array.from({ length: n }, (_, i) => pair(i)),
      SPEC,
      { config: dedupEnforce(), provider },
    );
    expect(provider.requests).toHaveLength(PAIR_VERDICT_LIMITS.maxRequests);
    for (const req of provider.requests) {
      expect(Object.keys(req.questions).length).toBeLessThanOrEqual(
        PAIR_VERDICT_LIMITS.maxPairsPerRequest,
      );
    }
    expect(run.status === "done" && run.verdicts.filter((v) => v === null)).toHaveLength(3);
  });

  test("a degraded request stops the remaining ones", async () => {
    const provider = new FakeChoiceProvider(() => ({ choice: "same", p: 0.9 }), {
      fail: "timeout",
    });
    const n = PAIR_VERDICT_LIMITS.maxPairsPerRequest * 2;
    const run = await runPairVerdicts(
      Array.from({ length: n }, (_, i) => pair(i)),
      SPEC,
      { config: dedupEnforce(), provider },
    );
    expect(provider.requests).toHaveLength(1);
    expect(run.status === "done" && run.degraded).toBe("timeout");
  });
});

describe("runPairVerdicts", () => {
  test("off: nothing is sent or recorded", async () => {
    const provider = new FakeChoiceProvider(() => ({ choice: "same", p: 0.9 }));
    const run = await runPairVerdicts([pair(0)], SPEC, {
      config: activeDecisionConfig({
        vault,
        uses: { ...activeDecisionConfig().uses, rerank: "off" },
      }),
      provider,
    });
    expect(run.status).toBe("off");
    expect(provider.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  });

  test("verdicts per pair; the record carries ids and verdicts, never text", async () => {
    const provider = new FakeChoiceProvider((id) =>
      id === "pair_0" ? { choice: "same", p: 0.8 } : { choice: "different", p: 0.95 },
    );
    const run = await runPairVerdicts([pair(0, "secret wording"), pair(1)], SPEC, {
      config: dedupEnforce(),
      provider,
    });
    expect(run.status).toBe("done");
    if (run.status !== "done") return;
    expect(run.verdicts.map((v) => v?.verdict)).toEqual(["same", "different"]);
    expect(run.verdicts[0]!.probabilities["same"]).toBeCloseTo(0.8);
    expect(run.verdicts[0]!.model).toBe("fake-choice-1");
    const state = provider.requests[0]!.state as { pairs: Record<string, string> };
    expect(Object.keys(state.pairs)).toEqual(["A0", "B0", "A1", "B1"]);
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    const payload = records[0]!.payload;
    expect(payload["pair_kind"]).toBe("preference");
    expect(payload["pairs"]).toEqual([
      { id: "f0", a: "pref-a0", b: "pref-b0", verdict: "same", probability: 0.8 },
      { id: "f1", a: "pref-a1", b: "pref-b1", verdict: "different", probability: 0.95 },
    ]);
    expect(JSON.stringify(payload)).not.toContain("secret wording");
  });

  test("a private or unreadable side is never sent and gets no verdict", async () => {
    const provider = new FakeChoiceProvider(() => ({ choice: "same", p: 0.9 }));
    const privatePage = pair(0, "hidden plan");
    const unreadable = pair(1, "lost page");
    const regionLine = pair(2, "carries region");
    const pairs: VerdictPairInput[] = [
      { ...privatePage, sideB: { ...privatePage.sideB, visibility: ["private"] } },
      { ...unreadable, sideA: { ...unreadable.sideA, privateRegions: null } },
      {
        ...regionLine,
        sideA: {
          text: "a line inside a region",
          visibility: [],
          privateRegions: ["<private>\na line inside a region\n</private>"],
        },
      },
      pair(3),
    ];
    const run = await runPairVerdicts(pairs, SPEC, { config: dedupEnforce(), provider });
    expect(run.status === "done" && run.verdicts.map((v) => v?.verdict ?? null)).toEqual([
      null,
      null,
      null,
      "same",
    ]);
    const body = JSON.stringify(provider.requests);
    expect(body).not.toContain("hidden plan");
    expect(body).not.toContain("lost page");
    expect(body).not.toContain("a line inside a region");
  });

  test("a degraded request leaves its pairs without a verdict and stops", async () => {
    const provider = new FakeChoiceProvider(() => ({ choice: "same", p: 0.9 }), {
      fail: "http_529",
    });
    const run = await runPairVerdicts([pair(0), pair(1)], SPEC, {
      config: dedupEnforce(),
      provider,
    });
    expect(run.status).toBe("done");
    if (run.status !== "done") return;
    expect(run.verdicts).toEqual([null, null]);
    expect(run.degraded).toBe("http_529");
    expect(listDecisionModelCalls(vault)[0]!.payload["outcome"]).toBe("http_529");
  });

  test("an invalid answer leaves only its pair without a verdict", async () => {
    const provider = new FakeChoiceProvider((id) =>
      id === "pair_0" ? "invalid" : { choice: "related", p: 0.7 },
    );
    const run = await runPairVerdicts([pair(0), pair(1)], SPEC, {
      config: dedupEnforce(),
      provider,
    });
    expect(run.status === "done" && run.verdicts.map((v) => v?.verdict ?? null)).toEqual([
      null,
      "related",
    ]);
  });
});

describe("orderByVerdicts", () => {
  const v = (verdict: string, p: number) => ({
    verdict,
    probabilities: { [verdict]: p },
    model: "m",
    calibrated: true,
  });

  test("enforce moves confident low-priority verdicts last, marks them, removes nothing", () => {
    const items = ["w", "x", "y", "z"];
    const out = orderByVerdicts(
      items,
      [v("different", 0.95), null, v("different", 0.5), v("same", 0.99)],
      "enforce",
      DEDUP_QUESTIONS.lowPriority,
    );
    expect(out.map((a) => a.item)).toEqual(["x", "y", "z", "w"]);
    expect(out.map((a) => a.lowPriority)).toEqual([false, false, false, true]);
    expect(verdictFields(out[3]!)).toMatchObject({ decision_model_low_priority: true });
    expect(verdictFields(out[0]!)).toEqual({});
    expect(verdictFields(out[1]!)["decision_model"]).toMatchObject({ verdict: "different" });
  });
});

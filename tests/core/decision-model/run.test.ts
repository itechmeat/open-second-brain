/**
 * `runDecision`, the state builder and the accounting records.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDecision } from "../../../src/core/decision-model/run.ts";
import { buildCandidateState } from "../../../src/core/decision-model/state.ts";
import {
  emitDecisionModelCall,
  listDecisionModelCalls,
  todaySpendUsd,
} from "../../../src/core/decision-model/record.ts";
import { createDecisionLatencyScope } from "../../../src/core/decision-model/latency.ts";
import {
  activeDecisionConfig,
  FakeDecisionProvider,
} from "../../helpers/fake-decision-provider.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempVault(): string {
  const v = mkdtempSync(join(tmpdir(), "osb-dm-run-"));
  dirs.push(v);
  return v;
}

const SECRET_TEXT = "the passage text that must never be recorded";

function build() {
  return {
    kind: "ok" as const,
    state: { query: "q", passages: { P0: SECRET_TEXT } },
    candidateCount: 1,
    context: { included: [0] },
  };
}
const QUESTIONS = () => ({ rel_0: { type: "noul" as const, instructions: "relevant?" } });

describe("runDecision", () => {
  test("off: no state is built and nothing is sent or recorded", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider();
    let built = 0;
    const configs = [
      null,
      activeDecisionConfig({ status: "disabled", vault }),
      activeDecisionConfig({ status: "no_key", vault }),
      activeDecisionConfig({ status: "disabled_by_vault", vault }),
      activeDecisionConfig({ status: "invalid", vault }),
      activeDecisionConfig({ vault, uses: { ...activeDecisionConfig().uses, rerank: "off" } }),
    ];
    const results = await Promise.all(
      configs.map((config) =>
        runDecision(
          "rerank",
          () => {
            built++;
            return build();
          },
          QUESTIONS,
          { config, provider },
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(configs.map(() => "off"));
    expect(built).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  });

  test("a call writes one record with identifiers and numbers, never text", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({ answer: () => 0.8 });
    const res = await runDecision("rerank", build, QUESTIONS, {
      config: activeDecisionConfig({ vault }),
      provider,
      recordDetails: () => ({ heuristic_order: ["a.md"] }),
    });
    expect(res.status).toBe("ok");
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    const p = records[0]!.payload;
    expect(p).toMatchObject({
      use: "rerank",
      mode: "enforce",
      provider: "fake",
      model: "fake-model-1",
      calibrated: true,
      question_count: 1,
      candidate_count: 1,
      input_tokens: 100,
      output_tokens: 5,
      cost_source: "estimated",
      outcome: "ok",
      heuristic_order: ["a.md"],
    });
    expect(p["cost_usd"]).toBeCloseTo((100 * 0.042) / 1e6, 12);
    expect(JSON.stringify(records[0])).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(records[0])).not.toContain("relevant?");
  });

  test("per-use details cannot overwrite an accounting field", async () => {
    const vault = tempVault();
    await runDecision("rerank", build, QUESTIONS, {
      config: activeDecisionConfig({ vault }),
      provider: new FakeDecisionProvider({ answer: () => 0.8, usage: { costUsd: 0.001 } }),
      recordDetails: () => ({ cost_usd: 0, outcome: "forged" }),
    });
    const p = listDecisionModelCalls(vault)[0]!.payload;
    expect(p["cost_usd"]).toBe(0.001);
    expect(p["outcome"]).toBe("ok");
  });

  test("a provider failure degrades with its reason and is recorded", async () => {
    const vault = tempVault();
    const res = await runDecision("rerank", build, QUESTIONS, {
      config: activeDecisionConfig({ vault }),
      provider: new FakeDecisionProvider({ fail: "http_529" }),
    });
    expect(res).toMatchObject({ status: "degraded", reason: "http_529" });
    expect(listDecisionModelCalls(vault)[0]!.payload["outcome"]).toBe("http_529");
  });

  test("the daily cost gate degrades before any state is built", async () => {
    const vault = tempVault();
    emitDecisionModelCall(vault, {
      use: "rerank",
      mode: "shadow",
      provider: "fake",
      model: "m",
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      usage: { costUsd: 0.6 },
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
    });
    expect(todaySpendUsd(vault)).toBeCloseTo(0.6, 9);
    const provider = new FakeDecisionProvider();
    let built = 0;
    const res = await runDecision(
      "rerank",
      () => {
        built++;
        return build();
      },
      QUESTIONS,
      { config: activeDecisionConfig({ vault, dailyCostGateUsd: 0.5 }), provider },
    );
    expect(res).toMatchObject({ status: "degraded", reason: "cost_gate" });
    expect(built).toBe(0);
    expect(provider.requests).toHaveLength(0);
    const outcomes = listDecisionModelCalls(vault).map((r) => r.payload["outcome"]);
    // Both records can share a millisecond, so compare as a set.
    expect(outcomes.toSorted()).toEqual(["cost_gate", "ok"]);
  });

  test("yesterday's spend does not count toward today's gate", async () => {
    const vault = tempVault();
    emitDecisionModelCall(vault, {
      use: "rerank",
      mode: "shadow",
      provider: "fake",
      model: "m",
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      usage: { costUsd: 5 },
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    expect(todaySpendUsd(vault)).toBe(0);
  });

  test("a budget refusal from the state builder is recorded as budget", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider();
    const res = await runDecision("rerank", () => ({ kind: "budget" as const }), QUESTIONS, {
      config: activeDecisionConfig({ vault }),
      provider,
    });
    expect(res).toMatchObject({ status: "degraded", reason: "budget" });
    expect(provider.requests).toHaveLength(0);
  });

  test("a failing record write never fails the decision", async () => {
    const res = await runDecision("rerank", build, QUESTIONS, {
      config: activeDecisionConfig({ vault: "/nonexistent/\0bad" }),
      provider: new FakeDecisionProvider({ answer: () => 0.9 }),
    });
    expect(res.status).toBe("ok");
  });

  test("an open latency scope collects decision time", async () => {
    const scope = createDecisionLatencyScope();
    await scope.run(() =>
      runDecision("rerank", build, QUESTIONS, {
        config: activeDecisionConfig(),
        provider: new FakeDecisionProvider({ latencyMs: 20 }),
      }),
    );
    expect(scope.decisionMs()).toBeGreaterThanOrEqual(15);
    expect(createDecisionLatencyScope().decisionMs()).toBeUndefined();
  });
});

function frame(texts: Readonly<Record<string, string>>) {
  return { query: "q", passages: texts };
}

describe("state builder", () => {
  test("private and unresolvable pages are withheld; private regions are stripped", () => {
    const res = buildCandidateState({
      candidates: [
        { text: "public one <private>hidden bit</private> end", visibility: [] },
        { text: "private page", visibility: ["private"] },
        { text: "unknown visibility", visibility: null },
        { text: "team page", visibility: ["team"] },
      ],
      prefix: "P",
      clipChars: 900,
      maxStateTokens: 32_000,
      frame,
    });
    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.included).toEqual([0, 3]);
    expect(res.withheld).toEqual([1, 2]);
    const text = JSON.stringify(res.state);
    expect(text).not.toContain("hidden bit");
    expect(text).not.toContain("private page");
    expect(text).not.toContain("unknown visibility");
    expect(Object.keys((res.state as { passages: object }).passages)).toEqual(["P0", "P1"]);
  });

  test("every candidate private gives empty", () => {
    const res = buildCandidateState({
      candidates: [{ text: "x", visibility: ["private"] }],
      prefix: "P",
      clipChars: 900,
      maxStateTokens: 32_000,
      frame,
    });
    expect(res.kind).toBe("empty");
  });

  test("texts are clipped and the lowest-ranked candidates dropped to fit", () => {
    const long = "x".repeat(2000);
    const res = buildCandidateState({
      candidates: [0, 1, 2, 3].map(() => ({ text: long, visibility: [] })),
      prefix: "P",
      clipChars: 900,
      maxStateTokens: 256 + 1000,
      frame,
    });
    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.included).toEqual([0, 1]);
    expect(res.dropped).toEqual([2, 3]);
    const passages = (res.state as { passages: Record<string, string> }).passages;
    expect(passages["P0"]!.length).toBe(900);
  });

  test("when not even one candidate fits, the result is budget", () => {
    const res = buildCandidateState({
      candidates: [{ text: "x".repeat(900), visibility: [] }],
      prefix: "P",
      clipChars: 900,
      maxStateTokens: 300,
      frame,
    });
    expect(res.kind).toBe("budget");
  });
});

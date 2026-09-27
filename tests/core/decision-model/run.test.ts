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
import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { buildDecisionModelReport } from "../../../src/core/decision-model/diagnostics.ts";
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

  test("requests in flight count toward the gate, so concurrent calls cannot all pass", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({ latencyMs: 30 });
    // A gate just above one request's estimate: the second concurrent
    // request must see the first one's reservation and stop.
    const config = activeDecisionConfig({
      vault,
      dailyCostGateUsd: 1e-9,
      inputPriceUsdPerMtok: 0.042,
    });
    const results = await Promise.all(
      [0, 1, 2].map(() => runDecision("rerank", build, QUESTIONS, { config, provider })),
    );
    expect(results.map((r) => r.status).toSorted()).toEqual(["degraded", "degraded", "ok"]);
    expect(provider.requests).toHaveLength(1);
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

  test("today's spend is read from the log once, then kept current by own writes", () => {
    const vault = tempVault();
    // Midday, so the reload below stays on the same UTC day.
    const now = new Date("2031-05-10T12:00:00.000Z");
    const spent = (usd: number) => ({
      use: "rerank" as const,
      mode: "shadow" as const,
      provider: "fake",
      model: "m",
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      usage: { costUsd: usd },
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
      createdAt: now.toISOString(),
    });
    emitDecisionModelCall(vault, spent(0.1));
    expect(todaySpendUsd(vault, now)).toBeCloseTo(0.1, 10);
    // Another process writes a record: not seen until the next reload.
    appendContinuityRecord(vault, {
      kind: "decision_model_call",
      createdAt: now.toISOString(),
      sourceRefs: [],
      payload: { cost_usd: 1 },
    });
    expect(todaySpendUsd(vault, now)).toBeCloseTo(0.1, 10);
    // This process's own write counts at once.
    emitDecisionModelCall(vault, spent(0.2));
    expect(todaySpendUsd(vault, now)).toBeCloseTo(0.3, 10);
    // After the reload window the log is read again and the other
    // process's record is in.
    expect(todaySpendUsd(vault, new Date(now.getTime() + 61_000))).toBeCloseTo(1.3, 10);
  });

  test("the report's shadow agreement counts only ordinary shadow records", () => {
    const vault = tempVault();
    const rec = (mode: "shadow" | "enforce", origin?: "eval") =>
      emitDecisionModelCall(vault, {
        use: "rerank",
        mode,
        provider: "fake",
        model: "m",
        calibrated: true,
        questionCount: 2,
        candidateCount: 2,
        usage: { costUsd: 0.001 },
        inputPriceUsdPerMtok: null,
        latencyMs: 1,
        outcome: "ok",
        // Agreeing for the ordinary shadow run, disagreeing for the others.
        details: {
          heuristic_order: ["a.md", "b.md"],
          decision_order:
            mode === "shadow" && origin === undefined ? ["a.md", "b.md"] : ["b.md", "a.md"],
        },
        ...(origin !== undefined ? { origin } : {}),
      });
    rec("shadow");
    rec("enforce");
    rec("shadow", "eval");
    const rerank = buildDecisionModelReport(vault).uses.find((u) => u.use === "rerank")!;
    expect(rerank.calls).toBe(3);
    expect(rerank.cost_usd).toBeCloseTo(0.003, 10);
    expect(rerank.agreement).toEqual({ compared: 1, top1_agreement: 1, top5_overlap: 1 });
    expect(buildDecisionModelReport(vault, { origin: "eval" }).total).toBe(1);
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
        {
          text: "public one <private>hidden bit</private> end",
          visibility: [],
          privateRegions: ["<private>hidden bit</private>"],
        },
        { text: "private page", visibility: ["private"], privateRegions: [] },
        { text: "unknown visibility", visibility: null, privateRegions: [] },
        { text: "team page", visibility: ["team"], privateRegions: [] },
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

  test("a chunk cut from inside a private region is withheld, though it has no tag", () => {
    // The page's region spans three chunks; only the first carries the
    // opening tag and only the last the closing one.
    const region = "<private>\nsecret line one\nsecret line two\nsecret line three\n</private>";
    const res = buildCandidateState({
      candidates: [
        { text: "intro\n<private>\nsecret line one", visibility: [], privateRegions: [region] },
        { text: "secret line two", visibility: [], privateRegions: [region] },
        { text: "secret line three\n</private>\noutro", visibility: [], privateRegions: [region] },
        { text: "a public paragraph", visibility: [], privateRegions: [region] },
        { text: "page not readable", visibility: [], privateRegions: null },
      ],
      prefix: "P",
      clipChars: 900,
      maxStateTokens: 32_000,
      frame,
    });
    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.included).toEqual([0, 3]);
    expect(res.withheld).toEqual([1, 2, 4]);
    const text = JSON.stringify(res.state);
    expect(text).not.toContain("secret line");
    expect(text).not.toContain("page not readable");
  });

  test("every candidate private gives empty", () => {
    const res = buildCandidateState({
      candidates: [{ text: "x", visibility: ["private"], privateRegions: [] }],
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
      candidates: [0, 1, 2, 3].map(() => ({ text: long, visibility: [], privateRegions: [] })),
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
      candidates: [{ text: "x".repeat(900), visibility: [], privateRegions: [] }],
      prefix: "P",
      clipChars: 900,
      maxStateTokens: 300,
      frame,
    });
    expect(res.kind).toBe("budget");
  });
});

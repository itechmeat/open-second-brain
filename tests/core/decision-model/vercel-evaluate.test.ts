/**
 * `vercel-evaluate`: the Vercel AI Gateway `/v1/evaluate` field mapping,
 * both ways (issue #213, Part 7). Loopback fake server only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { resolveDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import type { DecisionRequest } from "../../../src/core/decision-model/contract.ts";
import { makeDecisionProvider } from "../../../src/core/decision-model/provider.ts";
import { decisionCost } from "../../../src/core/decision-model/record.ts";
import { VercelEvaluateDecisionProvider } from "../../../src/core/decision-model/vercel-evaluate.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeSystemOne, type FakeSystemOne } from "../../helpers/fake-decision-provider.ts";

let server: FakeSystemOne;
beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
});

const REQUEST: DecisionRequest = {
  use: "rerank",
  state: "The support agent issued a full refund.",
  questions: {
    refunded: {
      type: "noul",
      instructions: "Was a refund issued?",
      criteria: { true: "a refund was issued", false: "no refund" },
    },
    route: {
      type: "choice",
      instructions: "Route it",
      criteria: { billing: "money", other: null },
    },
    urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "high"] },
  },
};

function provider(): VercelEvaluateDecisionProvider {
  return new VercelEvaluateDecisionProvider({
    name: "vercel-evaluate",
    baseUrl: server.url,
    model: "typesafe-ai/jev",
    envKey: "AI_GATEWAY_API_KEY",
    apiKey: FAKE_DECISION_KEY,
    calibrated: true,
    timeoutMs: 2000,
  });
}

describe("vercel-evaluate mapping", () => {
  test("request: noul is sent as boolean to /v1/evaluate; nothing else is renamed", async () => {
    server.setReply(() => ({
      json: {
        model: "typesafe-ai/jev",
        answers: { refunded: { type: "boolean", probability: 0.98 } },
        usage: { inputTokens: 275, outputTokens: 20 },
      },
    }));
    await provider().decide(REQUEST, { timeoutMs: 2000 });
    const sent = server.requests[0]!;
    expect(sent.path).toBe("/v1/evaluate");
    const questions = sent.body["questions"] as Record<string, Record<string, unknown>>;
    expect(questions["refunded"]).toEqual({
      type: "boolean",
      instructions: "Was a refund issued?",
      criteria: { true: "a refund was issued", false: "no refund" },
    });
    expect(questions["route"]!["type"]).toBe("choice");
    expect(questions["urgency"]).toEqual({
      type: "score",
      instructions: "How urgent?",
      criteria: ["low", "high"],
    });
    // No gateway fallback options: they could hand the request to a chat model.
    expect(sent.body["providerOptions"]).toBeUndefined();
    expect(sent.body["model"]).toBe("typesafe-ai/jev");
  });

  test("response: probability, camelCase usage, gateway cost, missing confidence", async () => {
    server.setReply(() => ({
      json: {
        model: "typesafe-ai/jev",
        answers: {
          refunded: { type: "boolean", probability: 0.98 },
          route: { type: "choice", choice: "billing", probabilities: { billing: 0.9, other: 0.1 } },
          urgency: { type: "score", score: 0.3, probabilities: { "0": 0.7, "1": 0.3 } },
        },
        usage: { inputTokens: 275, outputTokens: 20 },
        providerMetadata: { gateway: { cost: "0.00001155", routing: { finalProvider: "x" } } },
      },
    }));
    const res = await provider().decide(REQUEST, { timeoutMs: 2000 });
    expect(res.answers["refunded"]).toEqual({ type: "noul", value: 0.98, valid: true });
    expect(res.answers["route"]!.value).toBe("billing");
    expect(res.answers["route"]!.confidence!).toBeCloseTo(0.8, 9);
    expect(res.answers["urgency"]!.value).toBe(0.3);
    expect(res.answers["urgency"]!.confidence!).toBeCloseTo(0.4, 9);
    expect(res.usage).toEqual({ inputTokens: 275, outputTokens: 20, costUsd: 0.00001155 });
    expect(decisionCost(res.usage, 0.042).source).toBe("reported");
  });

  test("a systemone-shaped answer passes through; a boolean without probability is invalid", async () => {
    server.setReply(() => ({
      json: { answers: { refunded: { type: "noul", noul: 0.5 } }, usage: {} },
    }));
    const res = await provider().decide(
      { ...REQUEST, questions: { refunded: REQUEST.questions["refunded"]! } },
      { timeoutMs: 2000 },
    );
    expect(res.answers["refunded"]!.valid).toBe(true);
    server.setReply(() => ({
      json: { answers: { refunded: { type: "boolean", noul: 0.5 } }, usage: {} },
    }));
    const odd = await provider().decide(
      { ...REQUEST, questions: { refunded: REQUEST.questions["refunded"]! } },
      { timeoutMs: 2000 },
    );
    expect(odd.answers["refunded"]!.valid).toBe(false);
  });

  test("a cost that is not a plain decimal string is ignored", async () => {
    server.setReply(() => ({
      json: {
        answers: { refunded: { type: "boolean", probability: 0.1 } },
        usage: { inputTokens: 10 },
        providerMetadata: { gateway: { cost: "1e400" } },
      },
    }));
    const res = await provider().decide(
      { ...REQUEST, questions: { refunded: REQUEST.questions["refunded"]! } },
      { timeoutMs: 2000 },
    );
    expect(res.usage).toEqual({ inputTokens: 10 });
  });
});

describe("vercel-evaluate preset", () => {
  test("resolves to the evaluate adapter on the gateway with the Jev profile", () => {
    const env = { AI_GATEWAY_API_KEY: FAKE_DECISION_KEY } as NodeJS.ProcessEnv;
    const cfg = resolveDecisionModelConfig({
      env,
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "vercel-evaluate",
        decision_model_uses: "rerank:enforce",
      },
      vault: null,
    });
    expect(cfg.status).toBe("active");
    expect(cfg.adapter).toBe("vercel-evaluate");
    expect(cfg.baseUrl).toBe("https://ai-gateway.vercel.sh");
    expect(cfg.model).toBe("typesafe-ai/jev");
    expect(cfg.envKey).toBe("AI_GATEWAY_API_KEY");
    expect(cfg.thresholdProfile).toBe("jev-1.13");
    expect(cfg.uses.rerank).toBe("enforce");
    expect(makeDecisionProvider(cfg, env)).toBeInstanceOf(VercelEvaluateDecisionProvider);
  });
});

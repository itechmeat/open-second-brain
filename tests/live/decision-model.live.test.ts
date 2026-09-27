/**
 * Live check of the decision-model route against a real provider.
 *
 * Skipped unless `O2B_DECISION_MODEL_LIVE=1`, so it never runs in the
 * normal suite or in CI. It sends only synthetic text, never vault
 * content. Configure with:
 *
 *   O2B_DECISION_MODEL_LIVE=1
 *   O2B_LIVE_DECISION_PROVIDER=typesafe          # any preset; default typesafe
 *   O2B_LIVE_DECISION_ENV_KEY=TYPESAFE_API_KEY   # NAME of the variable holding the key
 *
 * The key is read from the named variable and never printed.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDecisionModelConfig } from "../../src/core/decision-model/config.ts";
import { makeDecisionProvider } from "../../src/core/decision-model/provider.ts";
import { listDecisionModelCalls } from "../../src/core/decision-model/record.ts";
import { applyCrossEncoderRerank } from "../../src/core/search/rerank/index.ts";
import type { BrainSearchResult } from "../../src/core/search/types.ts";

const LIVE = process.env["O2B_DECISION_MODEL_LIVE"] === "1";
const vault = mkdtempSync(join(tmpdir(), "osb-dm-live-"));
afterAll(() => rmSync(vault, { recursive: true, force: true }));

function config(uses: string) {
  return resolveDecisionModelConfig({
    config: {
      decision_model_enabled: "true",
      decision_model_provider: process.env["O2B_LIVE_DECISION_PROVIDER"] ?? "typesafe",
      decision_model_env_key: process.env["O2B_LIVE_DECISION_ENV_KEY"] ?? "TYPESAFE_API_KEY",
      decision_model_uses: uses,
      decision_model_timeout_ms: "10000",
    },
    vault,
  });
}

function hit(id: number, content: string): BrainSearchResult {
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path: `live-${id}.md`,
    title: `Live ${id}`,
    content,
    startLine: 1,
    endLine: 2,
    score: 1 - id * 0.1,
    keywordScore: 0.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze([]),
  });
}

test.skipIf(!LIVE)("the configured route answers a ping with a pinned model", async () => {
  const cfg = config("rerank:shadow");
  expect(cfg.status).toBe("active");
  const provider = makeDecisionProvider(cfg);
  expect(provider).not.toBeNull();
  const pong = await provider!.ping();
  console.log(`live ping: ok=${pong.ok} model=${pong.model} latency_ms=${pong.latencyMs}`);
  expect(pong.ok).toBe(true);
});

test.skipIf(!LIVE)("an enforced rerank puts the relevant synthetic passage first", async () => {
  const cfg = config("rerank:enforce,answerable:shadow");
  const results = [
    hit(0, "The office coffee machine is cleaned every Friday afternoon."),
    hit(1, "Parking permits are renewed at the front desk in January."),
    hit(2, "To rotate the database password, run the rotate script and restart the API pods."),
  ];
  let answerable: unknown;
  const out = await applyCrossEncoderRerank(
    results,
    "how do I rotate the database password",
    {
      enabled: true,
      kind: "decision-model",
      baseUrl: null,
      model: null,
      envKey: null,
      apiKey: null,
      topK: 3,
      minScore: 0,
      decisionModel: cfg,
    },
    {
      resolveVisibility: () => [],
      resolvePrivateRegions: () => [],
      onDecisionExtras: (extras) => {
        answerable = extras.answerable;
      },
    },
  );
  const record = listDecisionModelCalls(vault).at(-1)!.payload;
  console.log(
    `live rerank: order=${out.map((r) => r.path).join(",")} outcome=${String(record["outcome"])} ` +
      `model=${String(record["model"])} input_tokens=${String(record["input_tokens"])} ` +
      `cost_usd=${String(record["cost_usd"])} latency_ms=${String(record["latency_ms"])} ` +
      `answerable=${JSON.stringify(answerable)}`,
  );
  expect(record["outcome"]).toBe("ok");
  expect(out[0]!.path).toBe("live-2.md");
});

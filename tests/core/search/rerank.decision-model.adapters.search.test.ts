/**
 * The decision-model reranker end to end over the Part 7 routes: the
 * keyless loopback `laya` preset, the `vercel-evaluate` adapter and the
 * uncalibrated `llm-emulation` adapter, through the real config
 * resolution, `search()` and a loopback fake server (issue #213).
 *
 * Off sends nothing; shadow sends one request and returns the heuristic
 * output byte for byte; enforce on a profile without tuned thresholds
 * behaves as shadow; enforce on the Jev profile reorders.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { search } from "../../../src/core/search/search.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import {
  answerAll,
  startFakeSystemOne,
  type FakeSystemOne,
  type SystemOneRequestLog,
} from "../../helpers/fake-decision-provider.ts";
import { createTempVault, writeMd } from "../../helpers/search-fixtures.ts";

const KEY_VAR = "O2B_TEST_DECISION_ADAPTERS_KEY";

let server: FakeSystemOne;
let vault: string;
let dbPath: string;
let cleanup: () => void;
let fetchCalls = 0;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("dm-adapters-search"));
  writeMd(vault, "strong.md", "# Strong\n\nfox fox fox fox the quick brown fox jumps high.");
  writeMd(vault, "weak.md", "# Weak\n\nA note mostly about cats, with one fox mention here.");
  writeMd(vault, "mid.md", "# Mid\n\nThe fox and the hound; a fox story about foxes.");
  server.requests.length = 0;
  fetchCalls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls++;
    return realFetch(...args);
  }) as typeof fetch;
  delete process.env[KEY_VAR];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[KEY_VAR];
  cleanup();
});

function resolve(entries: Record<string, string>): ResolvedSearchConfig {
  const path = join(vault, ".o2b-test-config.yaml");
  const all = { search_recency_amplitude: "0", ...entries };
  writeFileSync(
    path,
    Object.entries(all)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n") + "\n",
  );
  return resolveSearchConfig({ vault, configPath: path, overrides: { dbPath } });
}

const RERANK = { search_rerank_enabled: "true", search_rerank_kind: "decision-model" };

async function outcome(cfg: ResolvedSearchConfig): Promise<string> {
  const out = await search(cfg, { query: "fox", limit: 10 });
  return JSON.stringify({ results: out.results, warnings: out.warnings });
}

async function baseline(): Promise<string> {
  const off = resolve({});
  await indexVault(off);
  return outcome(off);
}

/** A rerank passage as sent: the note title, its declared metadata and the chunk text. */
interface Passage {
  readonly title: string;
  readonly text: string;
}

/** Relevance: the cats note wins, so an applied decision is visible. */
function catsFirst(passages: Record<string, Passage>): (id: string) => number {
  return (id) => {
    if (!id.startsWith("rel_")) return 0.01;
    return passages[`P${id.slice(4)}`]!.text.includes("cats") ? 0.99 : 0.05;
  };
}

function laya(uses: string): Record<string, string> {
  return {
    ...RERANK,
    decision_model_enabled: "true",
    decision_model_provider: "laya",
    decision_model_base_url: server.url,
    decision_model_uses: uses,
  };
}

describe("laya preset (keyless loopback)", () => {
  test("rerank off with the preset configured: identical output, no request", async () => {
    const before = await baseline();
    const cfg = resolve(laya("rerank:off"));
    expect(await outcome(cfg)).toBe(before);
    expect(fetchCalls).toBe(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  });

  test("shadow: one request without a key, one record, identical output", async () => {
    const before = await baseline();
    server.setReply((req) => ({ json: answerAll(req, () => 0.5) }));
    const cfg = resolve(laya("rerank:shadow"));
    expect(cfg.rerank.enabled).toBe(true);
    expect(await outcome(cfg)).toBe(before);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers["authorization"]).toBeUndefined();
    expect(server.requests[0]!.body["model"]).toBe("english");
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["provider"]).toBe("laya");
    expect(records[0]!.payload["mode"]).toBe("shadow");
  });

  test("enforce without tuned thresholds behaves as shadow, silently", async () => {
    const before = await baseline();
    server.setReply((req) => {
      const passages = (req.body["state"] as { passages: Record<string, Passage> }).passages;
      return { json: answerAll(req, catsFirst(passages)) };
    });
    const cfg = resolve(laya("rerank:enforce"));
    expect(await outcome(cfg)).toBe(before);
    expect(server.requests).toHaveLength(1);
    expect(listDecisionModelCalls(vault)[0]!.payload["mode"]).toBe("shadow");
  });

  test("a failure is silent: identical output, the reason only in the record", async () => {
    const before = await baseline();
    server.setReply(() => ({ status: 503 }));
    expect(await outcome(resolve(laya("rerank:shadow")))).toBe(before);
    expect(listDecisionModelCalls(vault)[0]!.payload["outcome"]).toBe("http_503");
  });
});

function vercel(uses: string): Record<string, string> {
  return {
    ...RERANK,
    decision_model_enabled: "true",
    decision_model_provider: "vercel-evaluate",
    // The gateway replaced by the loopback fake for the test.
    decision_model_base_url: server.url,
    decision_model_env_key: KEY_VAR,
    decision_model_uses: uses,
  };
}

function evaluateReply(req: SystemOneRequestLog): unknown {
  const passages = (req.body["state"] as { passages: Record<string, Passage> }).passages;
  const p = catsFirst(passages);
  const questions = req.body["questions"] as Record<string, { type: string }>;
  return {
    model: "typesafe-ai/jev",
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [id, { type: q.type, probability: p(id) }]),
    ),
    usage: { inputTokens: 300, outputTokens: 10 },
    providerMetadata: { gateway: { cost: "0.0000126" } },
  };
}

describe("vercel-evaluate adapter", () => {
  test("without the key: identical output, no request", async () => {
    const before = await baseline();
    expect(await outcome(resolve(vercel("rerank:enforce")))).toBe(before);
    expect(fetchCalls).toBe(0);
  });

  test("enforce on the Jev profile: /v1/evaluate answers reorder the head", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const cfg = resolve(vercel("rerank:enforce"));
    await indexVault(cfg);
    server.setReply((req) => ({ json: evaluateReply(req) }));
    const out = await search(cfg, { query: "fox", limit: 10 });
    expect(server.requests[0]!.path).toBe("/v1/evaluate");
    const types = Object.values(
      server.requests[0]!.body["questions"] as Record<string, { type: string }>,
    );
    expect(types.every((q) => q.type === "boolean")).toBe(true);
    expect(out.results[0]!.path).toBe("weak.md");
    const record = listDecisionModelCalls(vault)[0]!.payload;
    expect(record["cost_source"]).toBe("reported");
    expect(record["cost_usd"]).toBe(0.0000126);
  });
});

describe("llm-emulation adapter", () => {
  test("shadow: identical output, and the record says calibrated: false", async () => {
    const before = await baseline();
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    server.setReply((req) => {
      const passages = JSON.parse(
        /<untrusted_source[^>]*>\n([^]*)\n<\/untrusted_source>/.exec(
          (req.body["messages"] as Array<{ content: string }>)[1]!.content,
        )![1]!,
      ) as { passages: Record<string, Passage> };
      const p = catsFirst(passages.passages);
      const schema = (
        req.body["response_format"] as { json_schema: { schema: { required: string[] } } }
      ).json_schema.schema;
      const content = Object.fromEntries(schema.required.map((id) => [id, { p: p(id) }]));
      return {
        json: {
          model: "fake-chat-1",
          choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 900, completion_tokens: 60 },
        },
      };
    });
    const cfg = resolve({
      ...RERANK,
      decision_model_enabled: "true",
      decision_model_provider: "llm-emulation",
      decision_model_base_url: `${server.url}/v1`,
      decision_model_id: "fake-chat-1",
      decision_model_env_key: KEY_VAR,
      decision_model_uses: "rerank:shadow",
    });
    expect(await outcome(cfg)).toBe(before);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.path).toBe("/v1/chat/completions");
    const record = listDecisionModelCalls(vault)[0]!.payload;
    expect(record["outcome"]).toBe("ok");
    expect(record["calibrated"]).toBe(false);
    expect(record["cost_source"]).toBe("unknown");
    expect(record["decision_order"]).toBeDefined();
    expect((record["decision_order"] as string[])[0]).toBe("weak.md");
  });
});

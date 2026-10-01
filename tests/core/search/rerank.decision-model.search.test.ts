/**
 * The decision-model reranker end to end, through the real config
 * resolution, `search()`, the `systemone` adapter and a loopback fake
 * server (issue #213, Parts 1 and 2).
 *
 * The four activation cases:
 *   1. no key and no decision config at all;
 *   2. the key is in the environment, but the feature is not enabled;
 *   3. the feature is enabled, but the key variable is not set;
 *   4. enabled AND the key is set.
 * In 1-3 there is no network call, no record, and the search output is
 * identical to rerank off. Only 4 sends anything.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { search } from "../../../src/core/search/search.ts";
import { runRerankEvalGate } from "../../../src/core/search/rerank-eval-gate.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { SearchError, type ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { defaultRecallRetriever } from "../../../src/core/brain/recall-inject.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import {
  answerAll,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../../helpers/fake-decision-provider.ts";
import { createTempVault, writeMd } from "../../helpers/search-fixtures.ts";
import { parseStructuredRecallQueryDocument } from "../../../src/core/search/structured-query.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";

const KEY_VAR = "O2B_TEST_DECISION_RERANK_KEY";

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
  ({ vault, dbPath, cleanup } = createTempVault("dm-rerank-search"));
  writeMd(vault, "strong.md", "# Strong\n\nfox fox fox fox the quick brown fox jumps high.");
  writeMd(vault, "weak.md", "# Weak\n\nA note mostly about cats, with one fox mention here.");
  writeMd(vault, "mid.md", "# Mid\n\nThe fox and the hound; a fox story about foxes.");
  writeMd(
    vault,
    "secret.md",
    "---\nvisibility: private\n---\n# Secret\n\nfox plans for the fox den.",
  );
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

function configFile(entries: Record<string, string>): string {
  // Inside the temp vault so cleanup removes it; not a note, never indexed.
  const path = join(vault, ".o2b-test-config.yaml");
  // Recency depends on the wall clock; pin it off so two searches compare.
  const all = { search_recency_amplitude: "0", ...entries };
  writeFileSync(
    path,
    Object.entries(all)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n") + "\n",
  );
  return path;
}

function resolve(entries: Record<string, string>): ResolvedSearchConfig {
  return resolveSearchConfig({ vault, configPath: configFile(entries), overrides: { dbPath } });
}

const RERANK = { search_rerank_enabled: "true", search_rerank_kind: "decision-model" };
const DECISION = {
  decision_model_enabled: "true",
  decision_model_provider: "compatible",
  decision_model_id: "fake-model-1",
  decision_model_env_key: KEY_VAR,
  // The fake server stands in for a Jev-family route, so enforce applies.
  decision_model_threshold_profile: "jev-1.13",
  decision_model_uses: "rerank:shadow",
};

function withServer(): Record<string, string> {
  return { ...DECISION, decision_model_base_url: server.url };
}

async function outcome(cfg: ResolvedSearchConfig): Promise<string> {
  const out = await search(cfg, { query: "fox", limit: 10 });
  return JSON.stringify({ results: out.results, warnings: out.warnings });
}

function decisionRecords(): number {
  return listDecisionModelCalls(vault).length;
}

describe("decision-model rerank: activation", () => {
  test("1. no key and no decision config: identical to rerank off, no request", async () => {
    const off = resolve({});
    await indexVault(off);
    const baseline = await outcome(off);
    const cfg = resolve(RERANK);
    expect(cfg.rerank.enabled).toBe(false);
    expect(await outcome(cfg)).toBe(baseline);
    expect(fetchCalls).toBe(0);
    expect(server.connections()).toBe(0);
    expect(decisionRecords()).toBe(0);
  });

  test("2. key set but the feature not enabled: identical to rerank off, no request", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const off = resolve({});
    await indexVault(off);
    const baseline = await outcome(off);
    const { decision_model_enabled: _, ...notEnabled } = withServer();
    const cfg = resolve({ ...RERANK, ...notEnabled });
    expect(cfg.rerank.enabled).toBe(false);
    expect(await outcome(cfg)).toBe(baseline);
    expect(fetchCalls).toBe(0);
    expect(server.requests).toHaveLength(0);
    expect(decisionRecords()).toBe(0);
  });

  test("3. enabled but the key variable missing: identical to rerank off, no request", async () => {
    const off = resolve({});
    await indexVault(off);
    const baseline = await outcome(off);
    const cfg = resolve({ ...RERANK, ...withServer() });
    expect(cfg.rerank.decisionModel?.status).toBe("no_key");
    expect(cfg.rerank.enabled).toBe(false);
    expect(await outcome(cfg)).toBe(baseline);
    expect(fetchCalls).toBe(0);
    expect(server.requests).toHaveLength(0);
    expect(decisionRecords()).toBe(0);
  });

  test("an invalid decision config is off too, never a search error", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const off = resolve({});
    await indexVault(off);
    const baseline = await outcome(off);
    const cfg = resolve({ ...RERANK, ...withServer(), decision_model_uses: "rerank:loud" });
    expect(cfg.rerank.decisionModel?.status).toBe("invalid");
    expect(await outcome(cfg)).toBe(baseline);
    expect(fetchCalls).toBe(0);
  });

  test("4. enabled with the key, shadow: one request, one record, identical output", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const off = resolve({});
    await indexVault(off);
    const baseline = await outcome(off);
    server.setReply((req) => ({ json: answerAll(req, () => 0.5) }));
    const cfg = resolve({ ...RERANK, ...withServer() });
    expect(cfg.rerank.enabled).toBe(true);
    expect(await outcome(cfg)).toBe(baseline);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_DECISION_KEY}`);
    // The private page is a search hit but is never sent.
    expect(server.requests[0]!.bodyText).not.toContain("fox den");
    expect(decisionRecords()).toBe(1);
    const record = JSON.stringify(listDecisionModelCalls(vault)[0]);
    expect(record).not.toContain("quick brown fox");
    expect(record).not.toContain(FAKE_DECISION_KEY);
  });

  test("4. enabled with the key, enforce: the decision order is applied", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const cfg = resolve({ ...RERANK, ...withServer(), decision_model_uses: "rerank:enforce" });
    await indexVault(cfg);
    server.setReply((req) => {
      const passages = (req.body["state"] as { passages: Record<string, { text: string }> })
        .passages;
      return {
        json: answerAll(req, (id) => {
          if (!id.startsWith("rel_")) return 0.01;
          return passages[`P${id.slice(4)}`]!.text.includes("cats") ? 0.99 : 0.05;
        }),
      };
    });
    const out = await search(cfg, { query: "fox", limit: 10 });
    expect(out.results[0]!.path).toBe("weak.md");
    expect(out.results[0]!.reasons.some((r) => r.startsWith("decision_model: "))).toBe(true);
  });

  test("4. enabled with the key, provider error: identical to rerank off, no warning", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const off = resolve({});
    await indexVault(off);
    const baseline = await outcome(off);
    server.setReply(() => ({ status: 503 }));
    const cfg = resolve({ ...RERANK, ...withServer(), decision_model_uses: "rerank:enforce" });
    expect(await outcome(cfg)).toBe(baseline);
    expect(listDecisionModelCalls(vault)[0]!.payload["outcome"]).toBe("http_503");
  });

  test("the vault opt-out turns an active config off", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    writeMd(vault, "Brain/_brain.yaml", "schema_version: 1\ndecision_model:\n  enabled: false\n");
    const cfg = resolve({ ...RERANK, ...withServer() });
    expect(cfg.rerank.decisionModel?.status).toBe("disabled_by_vault");
    expect(cfg.rerank.enabled).toBe(false);
  });

  test("an unknown rerank kind is still rejected, naming the new kind", () => {
    expect(() => resolve({ search_rerank_kind: "magic" })).toThrow(
      /search_rerank_kind must be 'openai-compat', 'local' or 'decision-model'/,
    );
    expect(() => resolve({ search_rerank_kind: "magic" })).toThrow(SearchError);
  });
});

describe("decision-model rerank: privacy, cache and hook surfaces", () => {
  test("a private region split across chunks never reaches the provider", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const paragraphs = Array.from(
      { length: 400 },
      (_, i) => `Paragraph ${i} about gardening in spring.`,
    );
    const secret = Array.from({ length: 900 }, (_, i) => `zebracode secret line ${i}`);
    writeMd(
      vault,
      "big.md",
      `# Big\n\n${paragraphs.join("\n\n")}\n\n<private>\n${secret.join("\n")}\n</private>\n`,
    );
    writeMd(vault, "open.md", "# Open\n\nzebracode is a public word in this note.");
    const cfg = resolve({ ...RERANK, ...withServer() });
    await indexVault(cfg);
    const out = await search(cfg, { query: "zebracode", limit: 10 });
    // The head holds chunks cut from inside the region, with no tag at all.
    expect(
      out.results.some(
        (r) =>
          r.path === "big.md" &&
          r.content.includes("zebracode secret line") &&
          !r.content.includes("<private"),
      ),
    ).toBe(true);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests.some((r) => r.bodyText.includes("public word"))).toBe(true);
    for (const r of server.requests) expect(r.bodyText).not.toContain("zebracode secret line");
  });

  test("a degraded enforce search is not cached as the enforced order", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const cfg = resolve({
      ...RERANK,
      ...withServer(),
      decision_model_uses: "rerank:enforce",
      search_cache_enabled: "true",
    });
    await indexVault(cfg);
    server.setReply(() => ({ status: 400 }));
    const degraded = await search(cfg, { query: "fox", limit: 10 });
    expect(degraded.results[0]!.path).not.toBe("weak.md");
    expect(server.requests).toHaveLength(1);

    server.setReply((req) => {
      const passages = (req.body["state"] as { passages: Record<string, { text: string }> })
        .passages;
      return {
        json: answerAll(req, (id) => {
          if (!id.startsWith("rel_")) return 0.01;
          return passages[`P${id.slice(4)}`]!.text.includes("cats") ? 0.99 : 0.05;
        }),
      };
    });
    // Not served from the cache: the request is made and the order applies.
    const applied = await search(cfg, { query: "fox", limit: 10 });
    expect(server.requests).toHaveLength(2);
    expect(applied.results[0]!.path).toBe("weak.md");
    // The applied order is cached: a repeat makes no request.
    const repeat = await search(cfg, { query: "fox", limit: 10 });
    expect(server.requests).toHaveLength(2);
    expect(repeat.results[0]!.path).toBe("weak.md");
  });

  test("the state budget and the answerable mode are part of the cache key", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const base = {
      ...RERANK,
      ...withServer(),
      decision_model_uses: "rerank:enforce",
      search_cache_enabled: "true",
    };
    const first = resolve(base);
    await indexVault(first);
    await search(first, { query: "fox", limit: 10 });
    await search(first, { query: "fox", limit: 10 });
    expect(server.requests).toHaveLength(1);
    await search(resolve({ ...base, decision_model_max_state_tokens: "16000" }), {
      query: "fox",
      limit: 10,
    });
    expect(server.requests).toHaveLength(2);
    await search(resolve({ ...base, decision_model_uses: "rerank:enforce,answerable:shadow" }), {
      query: "fox",
      limit: 10,
    });
    expect(server.requests).toHaveLength(3);
  });

  test("the recall-inject retriever skips the decision-model kind", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const entries = { ...RERANK, ...withServer(), decision_model_uses: "rerank:enforce" };
    const cfg = resolve(entries);
    await indexVault(cfg);
    // A provider that never answers would cost the hook its whole budget.
    server.setReply(() => ({ hang: true }));
    const started = Date.now();
    const found = await defaultRecallRetriever(configFile(entries), vault)("fox");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(found.candidates.length).toBeGreaterThan(0);
    expect(server.requests).toHaveLength(0);
    expect(decisionRecords()).toBe(0);
  });
});

describe("rerank eval gate with kind decision-model", () => {
  test("reports hit@k and MRR against rerank off", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    const cfg = resolve({ ...RERANK, ...withServer() });
    await indexVault(cfg);
    server.setReply((req) => {
      const passages = (req.body["state"] as { passages: Record<string, { text: string }> })
        .passages;
      return {
        json: answerAll(req, (id) => {
          if (!id.startsWith("rel_")) return 0.01;
          return passages[`P${id.slice(4)}`]!.text.includes("hound") ? 0.99 : 0.05;
        }),
      };
    });
    const gate = await runRerankEvalGate(
      cfg,
      { queries: [{ id: "q1", query: "fox", expected: ["mid.md"] }] },
      { kind: "decision-model", k: 1 },
    );
    expect(gate.baseline.hitAtK).toBe(0);
    expect(gate.reranked.hitAtK).toBe(1);
    expect(gate.deltas.mrr).toBeGreaterThan(0);
    expect(gate.recommendation).toBe("enable");
    // The ON arm ran in enforce although the config says shadow.
    expect(listDecisionModelCalls(vault).map((r) => r.payload["mode"])).toContain("enforce");
  });

  test("refuses when the decision model is not active", async () => {
    const cfg = resolve({ ...RERANK, ...withServer() });
    await indexVault(cfg);
    await expect(
      runRerankEvalGate(
        cfg,
        { queries: [{ id: "q", query: "fox", expected: ["x.md"] }] },
        {
          kind: "decision-model",
        },
      ),
    ).rejects.toThrow(/not active \(no_key\)/);
    expect(server.requests).toHaveLength(0);
  });
});

test("an inactive config writes nothing to the vault", async () => {
  const cfg = resolve({ ...RERANK, ...withServer() });
  await indexVault(cfg);
  const before = existsSync(join(vault, "Brain"))
    ? readdirSync(join(vault, "Brain")).toSorted()
    : [];
  await search(cfg, { query: "fox", limit: 10 });
  const after = existsSync(join(vault, "Brain"))
    ? readdirSync(join(vault, "Brain")).toSorted()
    : [];
  expect(after).toEqual(before);
});

describe("decision-model rerank under the hybrid deadline", () => {
  /** The decision request's own budget, far past the search deadline. */
  const DECISION_TIMEOUT_MS = 10_000;
  const DEADLINE_MS = 300;

  test("a stalled decision rerank is aborted at the deadline and the post-rank phases still run", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    writeMd(vault, "draft.md", "# Draft\n\nA draft fox note.");
    writeMd(vault, "quarantined.md", "---\nstatus: quarantine\n---\n\n# Bad\n\nfox fox unsafe.");
    const cfg = resolve({
      ...RERANK,
      ...withServer(),
      decision_model_uses: "rerank:enforce",
      decision_model_timeout_ms: String(DECISION_TIMEOUT_MS),
      search_hybrid_deadline_ms: String(DEADLINE_MS),
      search_trust_gate_enabled: "true",
    });
    await indexVault(cfg);
    server.setReply(() => ({ hang: true }));

    const started = Date.now();
    const out = await search(cfg, {
      query: "fox",
      structuredQuery: parseStructuredRecallQueryDocument("lex: fox -draft"),
      limit: 10,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    const paths = out.results.map((r) => r.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).not.toContain("draft.md");
    expect(paths).not.toContain("quarantined.md");
    expect(out.retrievalTrail?.degraded.map((d) => d.code)).toContain(
      RETRIEVAL_DEGRADATION.hybridDeadlineExceeded,
    );

    // The abandoned request was cut by the deadline's abort, not left to
    // run out its own 10 s budget: its record lands right after, with a
    // latency far below that budget.
    const pollRecords = async (
      attemptsLeft: number,
    ): Promise<ReturnType<typeof listDecisionModelCalls>> => {
      const found = listDecisionModelCalls(vault);
      if (found.length > 0 || attemptsLeft === 0) return found;
      await new Promise((r) => setTimeout(r, 50));
      return pollRecords(attemptsLeft - 1);
    };
    const records = await pollRecords(40);
    expect(records).toHaveLength(1);
    const latency = records[0]!.payload["latency_ms"] as number;
    expect(latency).toBeLessThan(DECISION_TIMEOUT_MS / 2);
  });
});

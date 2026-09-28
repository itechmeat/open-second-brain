/**
 * What a decision-model rerank passage carries: the note title and its declared `status` / `updated` beside
 * the clipped chunk text, frontmatter-only chunks left out, and injection
 * questions asked only where the tag is surfaced (`enforce`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyCrossEncoderRerank } from "../../../src/core/search/rerank/index.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { search } from "../../../src/core/search/search.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { RERANK_QUESTIONS } from "../../../src/core/decision-model/questions.ts";
import type { DecisionModelMode } from "../../../src/core/decision-model/contract.ts";
import type { BrainSearchResult, ResolvedRerankConfig } from "../../../src/core/search/types.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import {
  activeDecisionConfig,
  answerAll,
  FakeDecisionProvider,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../../helpers/fake-decision-provider.ts";
import { createTempVault, writeMd } from "../../helpers/search-fixtures.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempVault(): string {
  const v = mkdtempSync(join(tmpdir(), "osb-dm-passage-"));
  dirs.push(v);
  return v;
}

function result(id: number, overrides: Partial<BrainSearchResult> = {}): BrainSearchResult {
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path: `note-${id}.md`,
    title: `Note ${id}`,
    content: `content of note ${id}`,
    startLine: 5,
    endLine: 6,
    score: 1 - id * 0.1,
    keywordScore: 0.5,
    semanticScore: 0.5,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "hybrid" as const,
    reasons: Object.freeze(["fts5_bm25: 0.500"]),
    ...overrides,
  });
}

function config(
  mode: Exclude<DecisionModelMode, "off">,
  vault: string | null = null,
): ResolvedRerankConfig {
  const base = activeDecisionConfig({ vault });
  return {
    enabled: true,
    kind: "decision-model",
    baseUrl: null,
    model: null,
    envKey: null,
    apiKey: null,
    topK: 10,
    minScore: 0,
    decisionModel: { ...base, uses: { ...base.uses, rerank: mode } },
  };
}

const PUBLIC = (): ReadonlyArray<string> => [];
const NO_REGIONS = (): ReadonlyArray<string> => [];

type Passage = Record<string, string>;
function passagesOf(provider: FakeDecisionProvider): Record<string, Passage> {
  return (provider.requests[0]!.state as { passages: Record<string, Passage> }).passages;
}

describe("passage fields", () => {
  test("title, status and updated travel beside the text, clipped; nothing else", async () => {
    const provider = new FakeDecisionProvider();
    const longTitle = "T".repeat(400);
    const results = [result(0, { title: longTitle }), result(1)];
    await applyCrossEncoderRerank(results, "q", config("enforce"), {
      decisionProvider: provider,
      resolveVisibility: PUBLIC,
      resolvePrivateRegions: NO_REGIONS,
      resolveMeta: (path) =>
        path === "note-0.md" ? { status: "archived", updated: "2024-01-02" } : null,
    });
    const passages = passagesOf(provider);
    expect(passages["P0"]).toEqual({
      title: "T".repeat(RERANK_QUESTIONS.titleClipChars),
      status: "archived",
      updated: "2024-01-02",
      text: "content of note 0",
    });
    expect(passages["P1"]).toEqual({ title: "Note 1", text: "content of note 1" });
  });

  test("a title that repeats private-region text withholds the candidate", async () => {
    const provider = new FakeDecisionProvider();
    const results = [result(0, { title: "codename bluebird" }), result(1)];
    const out = await applyCrossEncoderRerank(results, "q", config("enforce"), {
      decisionProvider: provider,
      resolveVisibility: PUBLIC,
      resolvePrivateRegions: (path) =>
        path === "note-0.md" ? ["<private>\ncodename bluebird\n</private>"] : [],
    });
    expect(Object.values(passagesOf(provider)).map((p) => p["title"])).toEqual(["Note 1"]);
    expect(JSON.stringify(provider.requests[0]!.state)).not.toContain("bluebird");
    expect(out[0]).toBe(results[0]!);
  });

  test("a private page sends neither text nor title", async () => {
    const provider = new FakeDecisionProvider();
    const results = [result(0, { title: "Hidden plans" }), result(1)];
    await applyCrossEncoderRerank(results, "q", config("enforce"), {
      decisionProvider: provider,
      resolveVisibility: (path) => (path === "note-0.md" ? ["private"] : []),
      resolvePrivateRegions: NO_REGIONS,
      resolveMeta: () => ({ status: "draft" }),
    });
    const sent = JSON.stringify(provider.requests[0]!.state);
    expect(sent).not.toContain("Hidden plans");
    expect(Object.keys(passagesOf(provider))).toEqual(["P0"]);
  });
});

describe("frontmatter-only chunks", () => {
  test("is not sent and keeps its heuristic position", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider({
      answer: (id) => (id === "rel_0" ? 0.1 : id === "rel_1" ? 0.9 : undefined),
    });
    const results = [
      result(0),
      result(1, { content: "---\ntitle: x\nstatus: done\n---", startLine: 1 }),
      // A horizontal rule further down a page is body text, and is sent.
      result(2, { content: "---\ncontent of note 2" }),
    ];
    const out = await applyCrossEncoderRerank(results, "q", config("enforce", vault), {
      decisionProvider: provider,
      resolveVisibility: PUBLIC,
      resolvePrivateRegions: NO_REGIONS,
    });
    const passages = passagesOf(provider);
    expect(Object.values(passages).map((p) => p["text"])).toEqual([
      "content of note 0",
      "---\ncontent of note 2",
    ]);
    expect(out.map((r) => r.path)).toEqual(["note-2.md", "note-1.md", "note-0.md"]);
    expect(out[1]).toBe(results[1]!);
    expect(listDecisionModelCalls(vault)[0]!.payload["frontmatter_only_count"]).toBe(1);
  });
});

describe("injection questions", () => {
  test("shadow asks no injection question and records no injection count", async () => {
    const vault = tempVault();
    const provider = new FakeDecisionProvider();
    await applyCrossEncoderRerank([result(0), result(1)], "q", config("shadow", vault), {
      decisionProvider: provider,
      resolveVisibility: PUBLIC,
      resolvePrivateRegions: NO_REGIONS,
    });
    expect(Object.keys(provider.requests[0]!.questions).toSorted()).toEqual(["rel_0", "rel_1"]);
    expect(listDecisionModelCalls(vault)[0]!.payload["injection_suspected"]).toBeUndefined();
  });

  test("enforce asks them and surfaces the tag", async () => {
    const provider = new FakeDecisionProvider({
      answer: (id) => (id === "inj_1" ? 0.95 : undefined),
    });
    const out = await applyCrossEncoderRerank([result(0), result(1)], "q", config("enforce"), {
      decisionProvider: provider,
      resolveVisibility: PUBLIC,
      resolvePrivateRegions: NO_REGIONS,
    });
    expect(Object.keys(provider.requests[0]!.questions).toSorted()).toEqual([
      "inj_0",
      "inj_1",
      "rel_0",
      "rel_1",
    ]);
    const tagged = out.find((r) => r.path === "note-1.md")!;
    expect(tagged.reasons).toContain("decision_model_injection_suspected");
  });
});

describe("through search", () => {
  const KEY_VAR = "O2B_TEST_DECISION_PASSAGE_KEY";
  let server: FakeSystemOne;
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeAll(async () => {
    server = await startFakeSystemOne();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("dm-passage-search"));
    server.requests.length = 0;
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
  });
  afterEach(() => {
    delete process.env[KEY_VAR];
    cleanup();
  });

  test("the page's status and updated reach the state; its frontmatter chunk does not", async () => {
    writeMd(
      vault,
      "old.md",
      "---\nstatus: archived\nupdated: 2023-05-01\nsummary: heron notes kept by someone\n---\n# Deploy runbook (old)\n\nDeploy the heron service by hand.",
    );
    writeMd(vault, "new.md", "# Deploy runbook\n\nDeploy the heron service with the pipeline.");
    const configPath = join(vault, ".o2b-test-config.yaml");
    writeFileSync(
      configPath,
      [
        'search_recency_amplitude: "0"',
        'search_rerank_enabled: "true"',
        'search_rerank_kind: "decision-model"',
        'decision_model_enabled: "true"',
        'decision_model_provider: "compatible"',
        'decision_model_id: "fake-model-1"',
        `decision_model_env_key: "${KEY_VAR}"`,
        `decision_model_base_url: "${server.url}"`,
        'decision_model_uses: "rerank:shadow"',
      ].join("\n") + "\n",
    );
    const cfg = resolveSearchConfig({ vault, configPath, overrides: { dbPath } });
    await indexVault(cfg);
    server.setReply((req) => ({ json: answerAll(req, () => 0.5) }));
    const out = await search(cfg, { query: "heron", limit: 10 });
    // The frontmatter chunk is a search hit of its own...
    expect(out.results.some((r) => r.content.startsWith("---"))).toBe(true);
    expect(server.requests).toHaveLength(1);
    const passages = Object.values(
      (server.requests[0]!.body["state"] as { passages: Record<string, Passage> }).passages,
    );
    const old = passages.find((p) => p["text"]!.includes("by hand"));
    expect(old).toMatchObject({ status: "archived", updated: "2023-05-01" });
    // ...but it is never sent, and no other frontmatter field leaves.
    expect(server.requests[0]!.bodyText).not.toContain("kept by someone");
    expect(passages.some((p) => p["text"]!.startsWith("---"))).toBe(false);
  });
});

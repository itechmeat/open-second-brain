/**
 * Without decision-model configuration nothing reaches the network
 * (issue #213, Part 1). The surfaces the later uses will attach to - search
 * with rerank off, `skills_attach`, the `brain_extract_signals` plan and
 * `brain_recall_gate` - run under a `fetch` that throws, with and without a
 * key in the environment, and none of them calls it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planExtractSignals } from "../../../src/core/brain/extract-signals.ts";
import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { buildToolTable, findTool } from "../../../src/mcp/tools.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import type { ServerContext } from "../../../src/mcp/tool-contract.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";

const realFetch = globalThis.fetch;
let fetchCalls = 0;
let tmp: string;
let vault: string;
let configPath: string;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env["TYPESAFE_API_KEY"];
  delete process.env["TYPESAFE_API_KEY"];
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-no-config-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "fox.md"), "# Fox\n\nThe quick brown fox jumps over the dog.\n");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("network is not allowed in this test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env["TYPESAFE_API_KEY"];
  else process.env["TYPESAFE_API_KEY"] = savedKey;
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: null };
}

async function exerciseSurfaces(): Promise<void> {
  const table = buildToolTable("full");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  await findTool(table, "brain_search").handler(ctx(), { query: "fox" });
  await findTool(table, "skills_attach").handler(ctx(), { query: "cut a release" });
  await findTool(table, "brain_recall_gate").handler(ctx(), {
    prompt: "what does the fox do",
    scores: [0.9, 0.4],
    match_quality: 0.8,
  });
  importSessionRecall(vault, {
    sessionId: "sess-1",
    turns: [
      { turnId: "t1", timestamp: "2026-09-01T09:00:00Z", role: "user", text: "Always use tabs." },
    ],
    createdAt: "2026-09-01T09:00:00.000Z",
  });
  planExtractSignals(vault, "sess-1", { now: new Date("2026-09-01T10:00:00Z") });
}

test("no decision config: zero network calls across the surfaces", async () => {
  await exerciseSurfaces();
  expect(fetchCalls).toBe(0);
  expect(listDecisionModelCalls(vault)).toHaveLength(0);
});

test("a key in the environment alone changes nothing", async () => {
  process.env["TYPESAFE_API_KEY"] = FAKE_DECISION_KEY;
  await exerciseSurfaces();
  expect(fetchCalls).toBe(0);
  expect(listDecisionModelCalls(vault)).toHaveLength(0);
});

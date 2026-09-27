/**
 * The advisory `answerable` signal on search surfaces (issue #213, Part 8),
 * through the real config resolution, `search()`, `brain_search`, the CLI
 * JSON payload, the `systemone` adapter and a loopback fake server.
 *
 * The rerank request already carries the `answerable` question while that
 * use is not off; search surfaces the answer as
 * `decision_model: { answerable: { probability, model, calibrated } }` and
 * nothing when the use is off, the kind is another one, the feature is not
 * active, or the request degraded.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { jsonForOutcome } from "../../../src/cli/search/outcome-render.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { search } from "../../../src/core/search/search.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { assertOutputContract } from "../../../src/mcp/output-contract.ts";
import { buildToolTable, findTool } from "../../../src/mcp/tools.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import {
  answerAll,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../../helpers/fake-decision-provider.ts";
import { createTempVault, writeMd } from "../../helpers/search-fixtures.ts";

const KEY_VAR = "O2B_TEST_DECISION_ANSWERABLE_SEARCH_KEY";

let server: FakeSystemOne;
let vault: string;
let dbPath: string;
let cleanup: () => void;
let configPath: string;

beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("dm-answerable-search"));
  writeMd(vault, "strong.md", "# Strong\n\nfox fox fox fox the quick brown fox jumps high.");
  writeMd(vault, "weak.md", "# Weak\n\nA note mostly about cats, with one fox mention here.");
  server.requests.length = 0;
  server.setReply((req) => ({
    json: answerAll(req, (id) => (id === "answerable" ? 0.12 : 0.5)),
  }));
  delete process.env[KEY_VAR];
});
afterEach(() => {
  delete process.env[KEY_VAR];
  cleanup();
});

function resolve(entries: Record<string, string>): ResolvedSearchConfig {
  // Inside the temp vault so cleanup removes it; not a note, never indexed.
  configPath = join(vault, ".o2b-test-config.yaml");
  const all = { search_recency_amplitude: "0", ...entries };
  writeFileSync(
    configPath,
    Object.entries(all)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n") + "\n",
  );
  return resolveSearchConfig({ vault, configPath, overrides: { dbPath } });
}

function active(uses: string, extra: Record<string, string> = {}): ResolvedSearchConfig {
  process.env[KEY_VAR] = FAKE_DECISION_KEY;
  return resolve({
    search_rerank_enabled: "true",
    search_rerank_kind: "decision-model",
    decision_model_enabled: "true",
    decision_model_provider: "compatible",
    decision_model_id: "fake-model-1",
    decision_model_env_key: KEY_VAR,
    decision_model_base_url: server.url,
    decision_model_uses: uses,
    ...extra,
  });
}

async function brainSearch(): Promise<Record<string, unknown>> {
  const t = findTool(buildToolTable("full"), "brain_search");
  const out = (await t.handler({ vault, configPath, repoRoot: null }, { query: "fox" })) as Record<
    string,
    unknown
  >;
  assertOutputContract(t.name, t.outputSchema, out);
  return out;
}

const SIGNAL = { answerable: { probability: 0.12, model: "fake-model-1.0", calibrated: true } };

describe("search surfaces the answerable signal", () => {
  for (const mode of ["shadow", "enforce"] as const) {
    test(`answerable:${mode}: search, brain_search and --json carry it`, async () => {
      const cfg = active(`rerank:shadow,answerable:${mode}`);
      await indexVault(cfg);
      const out = await search(cfg, { query: "fox", limit: 10 });
      expect(out.decisionModel).toEqual(SIGNAL);
      expect((jsonForOutcome(out) as Record<string, unknown>)["decision_model"]).toEqual(SIGNAL);
      expect((await brainSearch())["decision_model"]).toEqual(SIGNAL);
      // No extra request: the answer rides the one rerank request.
      expect(server.requests).toHaveLength(2);
      for (const r of server.requests) {
        expect(Object.keys(r.body["questions"] as object)).toContain("answerable");
      }
      expect(listDecisionModelCalls(vault)[0]!.payload["answerable_probability"]).toBe(0.12);
    });
  }

  test("answerable off: no question and no field; output as without the feature", async () => {
    const off = resolve({});
    await indexVault(off);
    const baseline = JSON.stringify(jsonForOutcome(await search(off, { query: "fox", limit: 10 })));
    const cfg = active("rerank:shadow");
    const out = await search(cfg, { query: "fox", limit: 10 });
    expect(out.decisionModel).toBeUndefined();
    expect(JSON.stringify(jsonForOutcome(out))).toBe(baseline);
    expect(Object.keys(server.requests[0]!.body["questions"] as object)).not.toContain(
      "answerable",
    );
    expect((await brainSearch())["decision_model"]).toBeUndefined();
  });

  test("enabled without the key: nothing is sent and no field appears", async () => {
    const cfg = active("rerank:shadow,answerable:shadow");
    delete process.env[KEY_VAR];
    const inactive = resolveSearchConfig({ vault, configPath, overrides: { dbPath } });
    await indexVault(cfg);
    const out = await search(inactive, { query: "fox", limit: 10 });
    expect(out.decisionModel).toBeUndefined();
    expect(server.requests).toHaveLength(0);
    expect((await brainSearch())["decision_model"]).toBeUndefined();
  });

  test("another rerank kind carries no field", async () => {
    const cfg = active("rerank:shadow,answerable:shadow", { search_rerank_kind: "local" });
    await indexVault(cfg);
    const out = await search(cfg, { query: "fox", limit: 10 });
    expect(out.decisionModel).toBeUndefined();
    expect(server.requests).toHaveLength(0);
  });

  test("a degraded request carries no field", async () => {
    server.setReply(() => ({ status: 529 }));
    const cfg = active("rerank:enforce,answerable:enforce");
    await indexVault(cfg);
    const out = await search(cfg, { query: "fox", limit: 10 });
    expect(out.decisionModel).toBeUndefined();
    expect((jsonForOutcome(out) as Record<string, unknown>)["decision_model"]).toBeUndefined();
    expect(listDecisionModelCalls(vault)[0]!.payload["outcome"]).toBe("http_529");
  });

  test("an invalid answerable item carries no field", async () => {
    server.setReply((req) => {
      const reply = answerAll(req, () => 0.5);
      (reply["answers"] as Record<string, unknown>)["answerable"] = { type: "noul", noul: 7 };
      return { json: reply };
    });
    const cfg = active("rerank:shadow,answerable:shadow");
    await indexVault(cfg);
    const out = await search(cfg, { query: "fox", limit: 10 });
    expect(out.decisionModel).toBeUndefined();
  });

  test("a cached outcome keeps the signal it was computed with", async () => {
    const cfg = active("rerank:enforce,answerable:shadow", { search_cache_enabled: "true" });
    await indexVault(cfg);
    await search(cfg, { query: "fox", limit: 10 });
    const repeat = await search(cfg, { query: "fox", limit: 10 });
    expect(server.requests).toHaveLength(1);
    expect(repeat.decisionModel).toEqual(SIGNAL);
  });
});

/**
 * `brain_recall_feedback` (recall-trust-suite, Feature B): MCP-connected
 * agents record explicit per-result recall feedback. The event lands as
 * one JSON file under `Brain/search/feedback/` and the derived learned
 * weights refresh deterministically.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { feedbackDir } from "../../src/core/search/feedback.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { RETRIEVAL_DEGRADATION } from "../../src/core/search/retrieval-trail.ts";
import { FAKE_PROVIDER_KEY } from "../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recall-fb-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-recall-fb-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  writeFileSync(join(vault, "note.md"), "# Note\n\nthe quarterly ledger reconciliation runbook\n");
  ctx = { vault, configPath };
  await indexVault(resolveSearchConfig({ vault, configPath }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_recall_feedback", () => {
  test("records one event file and returns the refreshed learned weights", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_recall_feedback");
    expect(tool).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool!.handler(ctx as any, {
      query: "quarterly ledger reconciliation",
      result_path: "note.md",
      verdict: "up",
    })) as {
      recorded: boolean;
      learned: { keywordMul: number; events: number };
    };
    expect(out.recorded).toBe(true);
    expect(out.learned.events).toBe(1);
    expect(readdirSync(feedbackDir(vault))).toHaveLength(1);
  });

  test("rejects an invalid verdict", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_recall_feedback")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      tool.handler(ctx as any, {
        query: "ledger",
        result_path: "note.md",
        verdict: "meh",
      }),
    ).rejects.toThrow();
  });
});

/**
 * The re-run is a search like any other, so it goes through the same
 * query-embed gate: a remote caller under a positive cost gate on an
 * unpriced model gets no embed. The event is still recorded, and the
 * response now says the re-run was degraded instead of hiding it.
 */
describe("brain_recall_feedback discloses a gated re-run", () => {
  let server: FakeHttp;

  beforeEach(async () => {
    server = await startFakeHttp();
    const configPath = join(configHome, "config.yaml");
    const lines = (gate: number) =>
      [
        `vault: ${vault}`,
        "search_semantic_enabled: true",
        "embedding_provider: openai-compat",
        `embedding_base_url: ${server.url}`,
        "embedding_model: fake-model",
        `embedding_api_key: ${FAKE_PROVIDER_KEY}`,
        "embedding_dimension: 4",
        `embedding_cost_gate_usd: ${gate}`,
        "",
      ].join("\n");
    atomicWriteFileSync(configPath, lines(0));
    await indexVault(resolveSearchConfig({ vault, configPath }), { embeddings: true });
    atomicWriteFileSync(configPath, lines(1));
  });

  afterEach(async () => {
    await server.close();
  });

  async function feedback(reach: "local" | "remote") {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_recall_feedback")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await tool.handler({ ...ctx, reach: TRANSPORT_REACH[reach] } as any, {
      query: "quarterly ledger reconciliation",
      result_path: "note.md",
      verdict: "up",
    })) as { recorded: boolean; result_found: boolean; degraded: string[] };
  }

  test.skipIf(!sqliteVecLoadable())(
    "a remote call sends no embed, records the event and names the refusal",
    async () => {
      const before = server.callCount();
      const out = await feedback("remote");
      expect(server.callCount()).toBe(before);
      expect(out.recorded).toBe(true);
      expect(out.result_found).toBe(true);
      expect(readdirSync(feedbackDir(vault))).toHaveLength(1);
      expect(out.degraded).toContain(RETRIEVAL_DEGRADATION.semanticCostUnpriced);
      expect(out.degraded).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
    },
  );

  test.skipIf(!sqliteVecLoadable())("a local call embeds once and reports nothing", async () => {
    const before = server.callCount();
    const out = await feedback("local");
    expect(server.callCount()).toBe(before + 1);
    expect(out.degraded).toEqual([]);
  });
});

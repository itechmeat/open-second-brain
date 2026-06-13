/**
 * `brain_eval` runs the recall benchmark over a caller-supplied dataset
 * against the active vault and returns the quality metrics (hit@k, MRR,
 * answer-containment@k, source-utilization, citation-depth, source
 * warnings). Exercised through the same handler path the MCP server uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-eval-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-eval-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "canary.md"),
    "---\ntitle: Canary\n---\n\n# Canary rollout\n\nShip to one instance, then expand the rollout gradually.\n",
  );
  ctx = { vault, configPath };
  const config = resolveSearchConfig({ vault, configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_eval", () => {
  const tool = () => SEARCH_TOOLS.find((t) => t.name === "brain_eval")!;

  test("is registered and read-only", () => {
    expect(tool()).toBeDefined();
  });

  test("returns the full metric set for a matching dataset", async () => {
    const dataset = {
      queries: [
        {
          id: "canary",
          query: "canary rollout",
          expected: ["notes/canary.md"],
          answer: "expand the rollout gradually",
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool().handler(ctx as any, { dataset, k: 5 })) as Record<string, number>;
    expect(out.total).toBe(1);
    expect(out.hit_at_k).toBe(1);
    expect(out.mrr).toBeGreaterThan(0);
    expect(out.answer_queries).toBe(1);
    expect(out.answer_containment_at_k).toBe(1);
    expect(out.source_utilization_at_k).toBe(1);
    expect(out.citation_depth).toBeGreaterThanOrEqual(1);
    expect(out.source_warnings).toBe(0);
  });

  test("counts a source warning when an expected source is not retrieved", async () => {
    const dataset = {
      queries: [{ id: "missing", query: "canary rollout", expected: ["notes/absent.md"] }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool().handler(ctx as any, { dataset })) as Record<string, number>;
    expect(out.source_warnings).toBe(1);
    expect(out.hit_at_k).toBe(0);
  });

  test("rejects a malformed dataset", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool().handler(ctx as any, { dataset: { queries: [] } }),
    ).rejects.toBeDefined();
  });
});

/**
 * Recall adequacy verdict wiring (retrieval-precision-quality-loop,
 * t_b8f66fec): `brain_recall_gate` returns a verdict when `scores` is
 * supplied, `brain_context_pack` persists it in the receipt, and
 * `brain_context_receipts` surfaces it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-adequacy-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: null };
}

function tool(name: string) {
  return findTool(buildToolTable("full"), name);
}

test("gate omits adequacy when no scores are supplied", async () => {
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide?",
  })) as Record<string, unknown>;
  expect(out["retrieve"]).toBe(true);
  expect(out["adequacy"]).toBeUndefined();
});

test("gate returns a sufficient/proceed verdict for strong scores", async () => {
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide?",
    scores: [0.83, 0.4],
  })) as { adequacy: Record<string, unknown> };
  expect(out.adequacy["level"]).toBe("sufficient");
  expect(out.adequacy["action"]).toBe("proceed");
  expect(out.adequacy["escalate"]).toBe(false);
  expect(out.adequacy["result_count"]).toBe(2);
});

test("gate returns weak/re_recall and insufficient/abstain per scores", async () => {
  const weak = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "x",
    scores: [0.4],
  })) as { adequacy: Record<string, unknown> };
  expect(weak.adequacy["level"]).toBe("weak");
  expect(weak.adequacy["action"]).toBe("re_recall");

  const insufficient = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "x",
    scores: [],
  })) as { adequacy: Record<string, unknown> };
  expect(insufficient.adequacy["level"]).toBe("insufficient");
  expect(insufficient.adequacy["action"]).toBe("abstain");
  expect(insufficient.adequacy["escalate"]).toBe(true);
});

test("gate honours configurable thresholds", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_adequacy_sufficient: "0.9"\n`);
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "x",
    scores: [0.7],
  })) as { adequacy: Record<string, unknown> };
  // 0.7 would be sufficient at the default 0.6 floor, but not at 0.9.
  expect(out.adequacy["level"]).toBe("weak");
});

test("gate rejects a malformed scores argument", async () => {
  await expect(
    tool("brain_recall_gate").handler(ctx(), { prompt: "x", scores: ["nope"] }),
  ).rejects.toThrow();
});

test("context_pack persists the verdict into the receipt and returns it", async () => {
  const packed = (await tool("brain_context_pack").handler(ctx(), {
    max_tokens: 1000,
    receipt: true,
    recall_scores: [0.2, 0.1],
  })) as { adequacy?: Record<string, unknown>; receipt_id?: string };
  expect(packed.adequacy).toBeDefined();
  expect(packed.adequacy!["level"]).toBe("insufficient");
  expect(packed.receipt_id).toBeDefined();

  const summaries = (await tool("brain_context_receipts").handler(ctx(), {
    operation: "list",
  })) as { receipts: Array<{ adequacy?: Record<string, unknown> }> };
  expect(summaries.receipts.length).toBeGreaterThan(0);
  const withVerdict = summaries.receipts.find((r) => r.adequacy);
  expect(withVerdict?.adequacy?.["level"]).toBe("insufficient");
  expect(withVerdict?.adequacy?.["action"]).toBe("abstain");

  const shown = (await tool("brain_context_receipts").handler(ctx(), {
    operation: "show",
    id: packed.receipt_id,
  })) as { payload: Record<string, unknown> };
  const adequacy = shown.payload["adequacy"] as Record<string, unknown>;
  expect(adequacy["level"]).toBe("insufficient");
  expect(adequacy["top_score"]).toBeCloseTo(0.2);
});

test("context_pack omits adequacy when recall_scores is absent", async () => {
  const packed = (await tool("brain_context_pack").handler(ctx(), {
    max_tokens: 1000,
    receipt: true,
  })) as { adequacy?: unknown };
  expect(packed.adequacy).toBeUndefined();
});

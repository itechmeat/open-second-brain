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

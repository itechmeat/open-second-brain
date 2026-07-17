/**
 * MCP integration test for `brain_distill_source` (t_2e2e959f). The agent
 * supplies atomic claims with optional block ids; OSB writes an idempotent
 * distillation page. Handler exercised directly with a minimal context.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { DISTILL_TOOLS } from "../../src/mcp/brain/distill-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-distill-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, "Articles", "src.md"), "# Src\n\nBody.\n", "utf8");
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const handler = DISTILL_TOOLS[0]!.handler;

describe("brain_distill_source", () => {
  test("writes a distillation page and returns its path", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/src.md",
      claims: [{ text: "An atomic claim.", block: "^abc" }, { text: "Another claim." }],
    })) as { distillation_path: string; claim_count: number };
    expect(res.claim_count).toBe(2);
    const md = readFileSync(join(vault, res.distillation_path), "utf8");
    expect(md).toContain("kind: brain-distillation");
    expect(md).toContain("([[Articles/src.md#^abc]])");
  });

  test("a non-empty claims array is required", async () => {
    await expect(handler(ctx, { source_path: "Articles/src.md", claims: [] })).rejects.toThrow(
      MCPError,
    );
  });

  test("missing source_path is rejected", async () => {
    await expect(handler(ctx, { claims: [{ text: "x" }] })).rejects.toThrow(MCPError);
  });
});

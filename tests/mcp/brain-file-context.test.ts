/**
 * MCP integration test for `brain_file_context` (Recall & Working-Memory
 * Quality Suite, t_4f420aca). Given a file path, the tool surfaces prior
 * vault work that mentions it by querying the index, behind a size gate.
 * Read-only; handler exercised directly with a minimal context.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tools.ts";

let vault: string;
let configHome: string;
let configPath: string;
let ctx: ServerContext;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-file-context-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-file-context-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "notes", "auth-decision.md"),
    "# Auth decision\n\nWe refactored auth-token.ts to rotate keys hourly.\n",
  );
  await indexVault(resolveSearchConfig({ vault, configPath }));
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const tool = SEARCH_TOOLS.find((t) => t.name === "brain_file_context")!;
const handler = tool.handler;

describe("brain_file_context", () => {
  test("is registered requiring file_path", () => {
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain("file_path");
  });

  test("surfaces a note documenting prior work on the file", async () => {
    const res = (await handler(ctx, { file_path: "src/services/auth-token.ts" })) as {
      skipped: boolean;
      results: Array<{ path: string }>;
    };
    expect(res.skipped).toBe(false);
    expect(res.results.some((r) => r.path === "Brain/notes/auth-decision.md")).toBe(true);
  });

  test("skips a file below the size gate with an explicit reason", async () => {
    const small = join(vault, "small.ts");
    writeFileSync(small, "x\n");
    const res = (await handler(ctx, { file_path: small, min_bytes: 1500 })) as {
      skipped: boolean;
      reason: string | null;
    };
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("below_size_gate");
  });

  test("a missing file_path is rejected with INVALID_PARAMS", async () => {
    await expect(handler(ctx, {})).rejects.toThrow(MCPError);
  });
});

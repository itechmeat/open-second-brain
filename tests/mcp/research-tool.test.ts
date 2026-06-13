/**
 * MCP integration test for `brain_research_report` (Knowledge Provenance
 * suite). The agent supplies title + consulted sources + cited findings; OSB
 * validates the citation contract and writes a dated report page.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { RESEARCH_TOOLS } from "../../src/mcp/brain/research-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tools.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-research-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-research-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const handler = RESEARCH_TOOLS[0]!.handler;

describe("brain_research_report", () => {
  test("writes a cited report and returns its path and finding count", async () => {
    const res = await handler(ctx, {
      title: "Survey",
      sources: ["Articles/a.md", "Articles/b.md"],
      findings: [{ statement: "A point", sources: ["Articles/a.md"] }],
    });
    expect(res).toMatchObject({ created: true, finding_count: 1, report_path: expect.any(String) });
  });

  test("rejects an uncited finding with INVALID_PARAMS", async () => {
    await expect(
      handler(ctx, {
        title: "Survey",
        sources: ["Articles/a.md"],
        findings: [{ statement: "no citation", sources: [] }],
      }),
    ).rejects.toThrow(MCPError);
  });

  test("rejects an empty sources list", async () => {
    await expect(
      handler(ctx, {
        title: "Survey",
        sources: [],
        findings: [{ statement: "x", sources: ["Articles/a.md"] }],
      }),
    ).rejects.toThrow(MCPError);
  });
});

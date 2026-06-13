/**
 * MCP integration test for `brain_ingest_source` (Knowledge Provenance suite).
 * The agent supplies the extraction + summary; OSB writes entity pages and a
 * per-source summary page. Handler exercised directly with a minimal context.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listEntities } from "../../src/core/brain/entities/registry.ts";
import { INGEST_TOOLS } from "../../src/mcp/brain/ingest-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tools.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ingest-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ingest-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const handler = INGEST_TOOLS[0]!.handler;

describe("brain_ingest_source", () => {
  test("writes entity pages and a summary page, returns its vault path", async () => {
    const res = await handler(ctx, {
      source_path: "Articles/eth.md",
      summary: "Ethereum scaling overview.",
      entities: [
        { category: "concept", name: "Rollups" },
        { category: "concept", name: "Data Availability" },
      ],
      relations: [{ from: "Rollups", relation: "related", to: "Data Availability" }],
    });
    expect(res).toMatchObject({ created: true, summary_path: expect.any(String) });
    expect(listEntities(vault, { category: "concept" })).toHaveLength(2);
    // Summary page content is asserted in the core ingest test; here we read
    // the single summary file the ingest produced and confirm the backlink.
    const sourcesDir = join(vault, "Brain", "sources");
    const summaryFiles = readdirSync(sourcesDir).filter((n) => n.endsWith(".md"));
    expect(summaryFiles).toHaveLength(1);
    const md = readFileSync(join(sourcesDir, summaryFiles[0]!), "utf8");
    expect(md).toContain("[[Articles/eth.md]]");
    expect(md).toContain("Ethereum scaling overview.");
  });

  test("a malformed extraction is rejected with INVALID_PARAMS and writes nothing", async () => {
    await expect(
      handler(ctx, {
        source_path: "Articles/eth.md",
        summary: "x",
        entities: [{ category: "concept", name: "A" }],
        relations: [{ from: "A", relation: "causes", to: "A" }],
      }),
    ).rejects.toThrow(MCPError);
    expect(listEntities(vault)).toHaveLength(0);
  });

  test("missing required source_path is rejected", async () => {
    await expect(
      handler(ctx, { summary: "x", entities: [{ category: "concept", name: "A" }] }),
    ).rejects.toThrow(MCPError);
  });
});

/**
 * MCP integration tests for `brain_intake_entities` (model-based NER intake,
 * Knowledge Provenance suite). The calling agent owns the recognition; the
 * tool validates the typed payload and commits it through the shared
 * extraction-intake primitive. OSB never runs a model here.
 *
 * The handler is exercised directly with a minimal ServerContext - the arg
 * validation and the INVALID_PARAMS translation are the surface under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { getEntity, listEntities } from "../../src/core/brain/entities/registry.ts";
import { NER_TOOLS } from "../../src/mcp/brain/ner-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tools.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ner-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ner-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const handler = NER_TOOLS[0]!.handler;

describe("brain_intake_entities", () => {
  test("intakes agent-supplied entities into the registry", async () => {
    const res = await handler(ctx, {
      entities: [
        { category: "concept", name: "Layer 2s" },
        { category: "people", name: "Vitalik", aliases: ["V."] },
      ],
    });
    expect(res).toEqual({
      entities_created: [expect.any(String), expect.any(String)],
      entities_updated: [],
      relations_applied: 0,
    });
    expect(listEntities(vault)).toHaveLength(2);
    expect(getEntity(vault, { category: "concept", query: "Layer 2s" })?.name).toBe("Layer 2s");
  });

  test("applies typed relations between extracted entities", async () => {
    const res = await handler(ctx, {
      entities: [
        { category: "concept", name: "Restaking" },
        { category: "concept", name: "Validators" },
      ],
      relations: [{ from: "Restaking", relation: "related", to: "Validators" }],
    });
    expect(res).toMatchObject({ relations_applied: 1 });
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(restaking?.relations.some((r) => r.relation === "related")).toBe(true);
  });

  test("cites the source wikilink in a newly created entity body", async () => {
    await handler(ctx, {
      entities: [{ category: "concept", name: "Sharding" }],
      source: "[[Articles/eth-roadmap.md]]",
    });
    const sharding = getEntity(vault, { category: "concept", query: "Sharding" });
    expect(sharding?.body).toContain("## Sources");
    expect(sharding?.body).toContain("[[Articles/eth-roadmap.md]]");
  });

  test("rejects an empty entities array with INVALID_PARAMS and writes nothing", async () => {
    await expect(handler(ctx, { entities: [] })).rejects.toThrow(MCPError);
    expect(listEntities(vault)).toHaveLength(0);
  });

  test("translates an unknown relation into INVALID_PARAMS with no partial write", async () => {
    await expect(
      handler(ctx, {
        entities: [
          { category: "concept", name: "A" },
          { category: "concept", name: "B" },
        ],
        relations: [{ from: "A", relation: "causes", to: "B" }],
      }),
    ).rejects.toThrow(MCPError);
    expect(listEntities(vault)).toHaveLength(0);
  });
});

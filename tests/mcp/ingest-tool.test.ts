/**
 * MCP integration test for `brain_ingest_source` (Knowledge Provenance suite).
 * The agent supplies the extraction + summary; OSB writes entity pages and a
 * per-source summary page. Handler exercised directly with a minimal context.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { mkdirSync, writeFileSync } from "node:fs";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listEntities } from "../../src/core/brain/entities/registry.ts";
import { INGEST_TOOLS } from "../../src/mcp/brain/ingest-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

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

  test("pre_extract surfaces deterministic code-structure seeds (P4)", async () => {
    mkdirSync(join(vault, "Code"), { recursive: true });
    writeFileSync(
      join(vault, "Code", "widget.ts"),
      'import { h } from "./dom";\nexport class Widget extends Base {}\n',
      "utf8",
    );
    const res = (await handler(ctx, {
      source_path: "Code/widget.ts",
      summary: "A widget.",
      entities: [{ category: "concept", name: "Widget" }],
      pre_extract: true,
    })) as Record<string, unknown>;
    expect(res["pre_extract"]).toMatchObject({
      extracted: true,
      language: "typescript",
      entities: [{ kind: "class", name: "Widget" }],
    });
  });

  test("without pre_extract the response omits the seeds field (byte-identical)", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/eth.md",
      summary: "x",
      entities: [{ category: "concept", name: "A" }],
    })) as Record<string, unknown>;
    expect(res["pre_extract"]).toBeUndefined();
  });
});

describe("brain_ingest_batch_plan resume (t_ba1fa5f6)", () => {
  const batchPlan = INGEST_TOOLS.find((t) => t.name === "brain_ingest_batch_plan")!.handler;

  test("returns a plan_id and a resumed plan excludes ingested items", async () => {
    mkdirSync(join(vault, "Docs"), { recursive: true });
    writeFileSync(join(vault, "Docs", "a.md"), "alpha", "utf8");
    writeFileSync(join(vault, "Docs", "b.md"), "bravo", "utf8");

    const first = (await batchPlan(ctx, { source_dir: "Docs" })) as Record<string, unknown>;
    expect(first["plan_id"]).toMatch(/^[0-9a-f]{16}$/);
    expect(first["total_files"]).toBe(2);
    expect(first["resumed_completed"]).toBe(0);

    // Ingest one file through the source tool, carrying the plan id so the
    // checkpoint records it.
    await handler(ctx, {
      source_path: "Docs/a.md",
      summary: "Alpha.",
      entities: [{ category: "concept", name: "Alpha" }],
      plan_id: first["plan_id"],
    });

    const resumed = (await batchPlan(ctx, { source_dir: "Docs", resume: true })) as Record<
      string,
      unknown
    >;
    expect(resumed["plan_id"]).toBe(first["plan_id"]);
    expect(resumed["resumed_completed"]).toBe(1);
    const files = (resumed["batches"] as Array<{ files: Array<{ path: string }> }>).flatMap((b) =>
      b.files.map((f) => f.path),
    );
    expect(files).toEqual(["Docs/b.md"]);
  });
});

describe("brain_ingest_batch_plan reconcile (P5, t_d067a153)", () => {
  const batchPlan = INGEST_TOOLS.find((t) => t.name === "brain_ingest_batch_plan")!.handler;

  test("reconcile reports sources dispatched but never ingested", async () => {
    mkdirSync(join(vault, "Docs"), { recursive: true });
    writeFileSync(join(vault, "Docs", "a.md"), "alpha", "utf8");
    writeFileSync(join(vault, "Docs", "b.md"), "bravo", "utf8");

    const first = (await batchPlan(ctx, { source_dir: "Docs" })) as Record<string, unknown>;
    // Ingest only a; b is the lost source.
    await handler(ctx, {
      source_path: "Docs/a.md",
      summary: "Alpha.",
      entities: [{ category: "concept", name: "Alpha" }],
      plan_id: first["plan_id"],
    });

    const res = (await batchPlan(ctx, { source_dir: "Docs", reconcile: true })) as Record<
      string,
      unknown
    >;
    expect(res["reconcile"]).toMatchObject({
      plan_id: first["plan_id"],
      ingested: ["Docs/a.md"],
      missing: ["Docs/b.md"],
      complete: false,
    });
  });

  test("without the reconcile flag the response omits the report (byte-identical)", async () => {
    mkdirSync(join(vault, "Docs"), { recursive: true });
    writeFileSync(join(vault, "Docs", "a.md"), "alpha", "utf8");
    const res = (await batchPlan(ctx, { source_dir: "Docs" })) as Record<string, unknown>;
    expect(res["reconcile"]).toBeUndefined();
  });
});

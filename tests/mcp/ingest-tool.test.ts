/**
 * MCP integration test for `brain_ingest_source` (Knowledge Provenance suite).
 * The agent supplies the extraction + summary; OSB writes entity pages and a
 * per-source summary page. Handler exercised directly with a minimal context.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { mkdirSync, writeFileSync } from "node:fs";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { CAPTURE_SCOPE } from "../../src/core/brain/provenance/capture-scope.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listEntities } from "../../src/core/brain/entities/registry.ts";
import { readManifest } from "../../src/core/brain/ingest/content-manifest.ts";
import {
  SOURCE_CONTENT_HASH_FRONTMATTER_KEY,
  UNTRUSTED_SOURCE_FRONTMATTER_KEY,
} from "../../src/core/brain/trust/untrusted-provenance.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { INGEST_TOOLS } from "../../src/mcp/brain/ingest-tools.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { brainPageTexts } from "../helpers/brain-pages.ts";

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

/**
 * Seed the file a `source_path` names: an ingest whose source does not exist
 * is untrusted and quarantines its entities (GitHub #160), so a case that
 * reads them back from the canonical registry must give the source bytes.
 */
function seed(rel: string, contents = `bytes of ${rel}\n`): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

describe("brain_ingest_source", () => {
  test("writes entity pages and a summary page, returns its vault path", async () => {
    seed("Articles/eth.md");
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

  test("a plan_id outside the checkpoint grammar is the caller's fault, and named", async () => {
    seed("Articles/eth.md");
    // Swallowed, this took the whole batch: every call succeeded, no
    // checkpoint was ever written, and reconciliation reported all of it as
    // never ingested. INVALID_PARAMS, not INTERNAL_ERROR - the argument is
    // what is wrong and rephrasing it is the fix.
    let thrown: unknown;
    try {
      await handler(ctx, {
        source_path: "Articles/eth.md",
        summary: "x",
        entities: [{ category: "concept", name: "A" }],
        plan_id: "docs-migration",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).code).toBe(INVALID_PARAMS);
    expect((thrown as MCPError).message).toContain("plan id");
    expect(existsSync(join(vault, "Brain", "sources"))).toBe(false);
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

  test("pre_extract names a bound import target in snake_case, like every other key", async () => {
    mkdirSync(join(vault, "Code"), { recursive: true });
    writeFileSync(join(vault, "Code", "dom.ts"), "export const h = 1;\n", "utf8");
    writeFileSync(join(vault, "Code", "widget.ts"), 'import { h } from "./dom";\n', "utf8");
    // The imported file must already be in the content manifest to bind.
    await handler(ctx, {
      source_path: "Code/dom.ts",
      summary: "A dom module.",
      entities: [{ category: "concept", name: "Dom" }],
    });
    const res = (await handler(ctx, {
      source_path: "Code/widget.ts",
      summary: "A widget.",
      entities: [{ category: "concept", name: "Widget" }],
      pre_extract: true,
    })) as Record<string, unknown>;
    expect((res["pre_extract"] as { edges: unknown[] }).edges).toEqual([
      { kind: "imports", from: "Code/widget.ts", to: "./dom", resolved_to: "Code/dom.ts" },
    ]);
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

/**
 * The capture scope reaches the MCP caller (distilled provenance, D3): a
 * source the vault holds is `full-local`, a URL is `url-only`, and the key
 * is always present so a caller never infers it from absence.
 */
describe("brain_ingest_source - capture_scope", () => {
  test("a source the vault holds is full-local", async () => {
    seed("Articles/held.md");
    const res = (await handler(ctx, {
      source_path: "Articles/held.md",
      summary: "A held source.",
      entities: [{ category: "concept", name: "Held" }],
    })) as Record<string, unknown>;
    expect(res["capture_scope"]).toBe(CAPTURE_SCOPE.fullLocal);
  });

  test("a url source is url-only", async () => {
    const res = (await handler(ctx, {
      source_path: "https://example.test/post",
      summary: "A remote source.",
      entities: [{ category: "concept", name: "Remote" }],
    })) as Record<string, unknown>;
    expect(res["capture_scope"]).toBe(CAPTURE_SCOPE.urlOnly);
  });
});

/**
 * A page the caller cannot read at its reach is ingested exactly like an
 * absent one: untrusted lane, `url-only`, and no digest on any page.
 */
describe("brain_ingest_source - a page withheld at the caller's reach", () => {
  const PRIVATE_PATH = "Notes/secret.md";

  beforeEach(() => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(
      join(vault, PRIVATE_PATH),
      "---\nvisibility: private\n---\nThe code is ZX8.\n",
      "utf8",
    );
  });

  const ingest = (source: string, reachCtx: ServerContext = ctx) =>
    handler(reachCtx, {
      source_path: source,
      summary: "Codes.",
      entities: [{ category: "concept", name: "Codes" }],
    }) as Promise<{ capture_scope: string; summary_path: string }>;

  test("answers like an absent source and writes no digest", async () => {
    const hidden = await ingest(PRIVATE_PATH);
    const absent = await ingest("Notes/absent.md");
    expect(hidden.capture_scope).toBe(CAPTURE_SCOPE.urlOnly);
    expect(hidden.capture_scope).toBe(absent.capture_scope);
    const summary = readFileSync(join(vault, hidden.summary_path), "utf8");
    expect(summary).toContain(UNTRUSTED_SOURCE_FRONTMATTER_KEY);
    for (const page of brainPageTexts(vault))
      expect(page).not.toContain(SOURCE_CONTENT_HASH_FRONTMATTER_KEY);
  });

  test("at local reach the same page is full-local", async () => {
    const res = await ingest(PRIVATE_PATH, { ...ctx, reach: TRANSPORT_REACH.local });
    expect(res.capture_scope).toBe(CAPTURE_SCOPE.fullLocal);
  });

  test("records no content manifest entry for it, as for an absent source", async () => {
    await ingest(PRIVATE_PATH);
    expect(Object.keys(readManifest(vault).entries)).not.toContain(PRIVATE_PATH);
    await ingest(PRIVATE_PATH, { ...ctx, reach: TRANSPORT_REACH.local });
    expect(Object.keys(readManifest(vault).entries)).toContain(PRIVATE_PATH);
  });
});

/**
 * A file the caller cannot read at its reach is planned exactly like an
 * absent one: in no batch, no total, no skip list and no reconcile list.
 */
describe("brain_ingest_batch_plan - a page withheld at the caller's reach", () => {
  const batchPlan = INGEST_TOOLS.find((t) => t.name === "brain_ingest_batch_plan")!.handler;
  const OPEN = "Notes/open.md";
  const PRIVATE_PATH = "Notes/secret.md";

  beforeEach(() => {
    seed(OPEN, "open\n");
    seed(PRIVATE_PATH, "---\nvisibility: private\n---\nThe code is ZX8.\n");
  });

  type Plan = {
    plan_id: string;
    total_files: number;
    total_bytes: number;
    batches: Array<{ files: Array<{ path: string }> }>;
    reconcile?: { dispatched: string[]; ingested: string[]; missing: string[] };
  };
  const plan = (reachCtx: ServerContext, args: Record<string, unknown> = {}) =>
    batchPlan(reachCtx, { source_dir: "Notes", ...args }) as Promise<Plan>;
  const planned = (p: Plan) => p.batches.flatMap((b) => b.files.map((f) => f.path));

  test("plans the vault as if the page were absent", async () => {
    const remote = await plan(ctx);
    expect(planned(remote)).toEqual([OPEN]);
    expect(remote.total_files).toBe(1);

    rmSync(join(vault, PRIVATE_PATH));
    const absent = await plan(ctx);
    expect(remote).toEqual(absent);
  });

  test("at local reach the page is planned", async () => {
    const local = await plan({ ...ctx, reach: TRANSPORT_REACH.local });
    expect(planned(local)).toEqual([OPEN, PRIVATE_PATH]);
  });

  test("a checkpoint entry for the page stays out of the reconcile lists", async () => {
    const localCtx = { ...ctx, reach: TRANSPORT_REACH.local };
    const local = await plan(localCtx);
    await handler(localCtx, {
      source_path: PRIVATE_PATH,
      summary: "Codes.",
      entities: [{ category: "concept", name: "Codes" }],
      plan_id: local.plan_id,
    });
    const remote = await plan(ctx, { reconcile: true });
    expect(remote.reconcile?.dispatched).toEqual([OPEN]);
    expect(remote.reconcile?.ingested).toEqual([]);
  });
});

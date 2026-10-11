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

  test("pre_extract on a .tf source surfaces Terraform seeds", async () => {
    mkdirSync(join(vault, "Infra"), { recursive: true });
    writeFileSync(
      join(vault, "Infra", "main.tf"),
      'variable "region" {}\nresource "aws_s3_bucket" "logs" {\n  bucket = var.region\n}\n',
      "utf8",
    );
    const res = (await handler(ctx, {
      source_path: "Infra/main.tf",
      summary: "The infrastructure root module.",
      entities: [{ category: "concept", name: "Logs bucket" }],
      pre_extract: true,
    })) as Record<string, unknown>;
    expect(res["pre_extract"]).toEqual({
      extracted: true,
      language: "hcl",
      entities: [
        { kind: "resource", name: "aws_s3_bucket.logs" },
        { kind: "variable", name: "var.region" },
      ],
      edges: [{ kind: "references", from: "aws_s3_bucket.logs", to: "var.region" }],
    });
  });

  test("the pre_extract description is one line and names the Terraform seeds", () => {
    const schema = INGEST_TOOLS[0]!.inputSchema as {
      properties: Record<string, { description: string }>;
    };
    const description = schema.properties["pre_extract"]!.description;
    expect(description).not.toContain("\n");
    expect(description).toContain("Terraform");
  });

  test("pre_extract surfaces deterministic code-structure seeds", async () => {
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
 * The durable-archive result fields (answer trust, Task C4), following the
 * capture_scope pattern: `source_archive_hash` is always present, null when
 * the source was not archived, and the named refusal rides only when an
 * ELIGIBLE source could not be.
 */
describe("brain_ingest_source - source_archive_hash", () => {
  interface ArchiveResult {
    readonly source_archive_hash: string | null;
    readonly source_archive_bytes?: number;
    readonly source_archive_refusal?: string;
  }
  const ingest = (sourcePath: string, extra: Record<string, unknown> = {}) =>
    handler(ctx, {
      source_path: sourcePath,
      summary: "Archived?",
      entities: [{ category: "concept", name: "Archived" }],
      ...extra,
    }) as Promise<ArchiveResult>;

  test("a trusted source reports the entry digest and byte count", async () => {
    seed("Articles/held.md");
    const res = await ingest("Articles/held.md");
    expect(res.source_archive_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.source_archive_bytes).toBe(Buffer.byteLength("bytes of Articles/held.md\n", "utf8"));
    expect(res.source_archive_refusal).toBeUndefined();
  });

  test("a url source reports a null hash, never a missing key", async () => {
    const res = await ingest("https://example.test/post");
    expect(res.source_archive_hash).toBeNull();
    expect(res.source_archive_bytes).toBeUndefined();
    expect(res.source_archive_refusal).toBeUndefined();
  });

  test("an oversized trusted source reports a null hash and the named refusal", async () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, "Articles", "big.md"), "y".repeat(1_048_577), "utf8");
    const res = await ingest("Articles/big.md");
    expect(res.source_archive_hash).toBeNull();
    expect(res.source_archive_bytes).toBeUndefined();
    expect(res.source_archive_refusal).toContain("1048576-byte ceiling");
  });

  test("a source withheld at the caller's reach reports a null hash and no refusal", async () => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(
      join(vault, "Notes", "quiet.md"),
      "---\nvisibility: private\n---\nThe code is ZX8.\n",
      "utf8",
    );
    const res = await ingest("Notes/quiet.md");
    // The caller's reach makes it untrusted: not capture-eligible, so no
    // stamp, no refusal, and nothing on disk.
    expect(res.source_archive_hash).toBeNull();
    expect(res.source_archive_refusal).toBeUndefined();
    expect(existsSync(join(vault, "Brain", ".archives"))).toBe(false);
  });
});

/**
 * Delete-by-source takes the source's archive entry with it once the last
 * citing page goes (answer trust, Task C4), reported as its own kind. Two
 * sources with identical bytes share one content-addressed entry, so the
 * first deletion must leave it standing.
 */
describe("brain_delete_by_source - archive entry cleanup", () => {
  const deleteTool = INGEST_TOOLS.find((t) => t.name === "brain_delete_by_source")!.handler;
  const TWIN_A = "Articles/twin-a.md";
  const TWIN_B = "Articles/twin-b.md";

  interface CleanupResult {
    readonly archive_entries?: ReadonlyArray<{ hash: string; path: string }>;
    readonly deleted: ReadonlyArray<string>;
  }
  const cleanup = (source: string, confirm: boolean) =>
    deleteTool(ctx, { source_file: source, confirm }) as Promise<CleanupResult>;

  beforeEach(async () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, TWIN_A), "twin bytes\n", "utf8");
    writeFileSync(join(vault, TWIN_B), "twin bytes\n", "utf8");
    const a = (await handler(ctx, {
      source_path: TWIN_A,
      summary: "Twin A.",
      entities: [{ category: "concept", name: "TwinA" }],
    })) as { source_archive_hash: string };
    const b = (await handler(ctx, {
      source_path: TWIN_B,
      summary: "Twin B.",
      entities: [{ category: "concept", name: "TwinB" }],
    })) as { source_archive_hash: string };
    expect(b.source_archive_hash).toBe(a.source_archive_hash);
  });

  test("a dry run over one of two citing sources names no archive entry", async () => {
    const res = await cleanup(TWIN_A, false);
    expect(res.archive_entries).toBeUndefined();
  });

  test("removing the first citing source leaves the shared entry on disk", async () => {
    const res = await cleanup(TWIN_A, true);
    expect(res.archive_entries).toBeUndefined();
    expect(readdirSync(join(vault, "Brain", ".archives"))).toHaveLength(1);
  });

  test("removing the LAST citing source removes the entry, reported as its own kind", async () => {
    await cleanup(TWIN_A, true);
    const dry = await cleanup(TWIN_B, false);
    // readdirSync names the file WITH its extension; the entry hash is the stem.
    const file = readdirSync(join(vault, "Brain", ".archives"))[0]!;
    const hash = file.replace(/\.txt$/, "");
    expect(dry.archive_entries).toEqual([{ hash, path: `Brain/.archives/${file}` }]);

    const res = await cleanup(TWIN_B, true);
    expect(res.archive_entries).toEqual([{ hash, path: `Brain/.archives/${file}` }]);
    // The entry file is gone; the (now empty) store directory may remain.
    expect(existsSync(join(vault, "Brain", ".archives", file))).toBe(false);
    expect(readdirSync(join(vault, "Brain", ".archives"))).toEqual([]);
  });

  test("an undeletable entry is omitted from archive_entries and the confirmed deletion still succeeds", async () => {
    // Down to one citing page, so the confirmed deletion below orphans the
    // shared entry - then the entry itself is replaced by a non-empty
    // DIRECTORY of the same name: a deterministic, root-proof stand-in for
    // an undeletable entry (rmSync raises ERR_FS_EISDIR on it).
    await cleanup(TWIN_A, true);
    const file = readdirSync(join(vault, "Brain", ".archives"))[0]!;
    const entryPath = join(vault, "Brain", ".archives", file);
    rmSync(entryPath);
    mkdirSync(join(entryPath, "junk"), { recursive: true });

    const res = await cleanup(TWIN_B, true);
    // The tool succeeds: the page deletion completed, the failed cleanup
    // neither fails it nor leaks the host path, and the entry is simply
    // omitted from the reported kinds (the doctor's uncited count names
    // the leftover).
    expect(res.archive_entries).toBeUndefined();
    expect(res.deleted.length).toBeGreaterThan(0);
    expect(existsSync(entryPath)).toBe(true);
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

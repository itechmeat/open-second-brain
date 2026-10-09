/**
 * `brain_ingest_batch_plan` names format skips the same way whatever the
 * caller may read.
 *
 * Format routing runs before the reach predicate (visibility is a Markdown
 * rule, and asking it about a binary would read the binary whole), so the
 * format-skip list of a tree holding a page the caller cannot read must equal
 * the list of the same tree without that page. Through the real MCPServer
 * with no reach minted, which fails closed to remote.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { hashFile, manifestPath } from "../../src/core/brain/ingest/content-manifest.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PRIVATE_PATH = "Clips/private.md";
const PRIVATE_BODY = "---\nvisibility: private\n---\n# Private plan\nThe code is 4711.\n";
/**
 * Hidden pages of the non-Markdown planned formats: HTML and CSV are now
 * planned by default and pass the same reach predicate as Markdown, whose
 * A/B is the first test below.
 */
const PRIVATE_PAGES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["Clips/private.csv", "---\nvisibility: private\n---\nname,code\nvault,4711\n"],
  ["Clips/private.html", "---\nvisibility: private\n---\n<h1>Private plan</h1><p>4711</p>\n"],
]);

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly server: MCPServer;
}

function fixture(
  withPrivate: boolean,
  reach?: typeof TRANSPORT_REACH.local,
  privatePage: readonly [string, string] = [PRIVATE_PATH, PRIVATE_BODY],
): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-plan-format-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Clips"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, "Clips/open.md"), "# Open\n");
  writeFileSync(join(vault, "Clips/page.html"), "<h1>Overview</h1>");
  writeFileSync(join(vault, "Clips/report.pdf"), "%PDF-1.7\n");
  writeFileSync(join(vault, "Clips/scan.png"), "png");
  writeFileSync(join(vault, "Clips/blob.bin"), "abc");
  if (withPrivate) writeFileSync(join(vault, privatePage[0]), privatePage[1]);
  const server = new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : undefined);
  return { vault, server };
}

async function plan(f: Fixture): Promise<Record<string, unknown>> {
  return (await f.server.callTool("brain_ingest_batch_plan", {
    source_dir: "Clips",
  })) as Record<string, unknown>;
}

function structured(result: Record<string, unknown>): Record<string, unknown> {
  const inner = result["structuredContent"];
  return (inner !== undefined ? inner : result) as Record<string, unknown>;
}

describe("format skips at remote reach", () => {
  test("a tree with a hidden page and one without give identical plans", async () => {
    const hidden = structured(await plan(fixture(true)));
    const absent = structured(await plan(fixture(false)));
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(absent));
    expect(hidden["skipped_non_extractable"]).toEqual([
      { path: "Clips/report.pdf", reason: "format-not-extractable", detail: "pdf" },
      { path: "Clips/scan.png", reason: "format-not-extractable", detail: "image" },
    ]);
    expect(hidden["unclassifiable"]).toEqual({ total: 1, by_extension: { ".bin": 1 } });
  });

  for (const page of PRIVATE_PAGES) {
    test(`a hidden ${page[0]} leaves the remote plan identical to the tree without it`, async () => {
      const hidden = structured(await plan(fixture(true, undefined, page)));
      const absent = structured(await plan(fixture(false)));
      expect(JSON.stringify(hidden)).toBe(JSON.stringify(absent));
      const local = structured(await plan(fixture(true, TRANSPORT_REACH.local, page)));
      expect(JSON.stringify(local["batches"])).toContain(page[0]);
    });
  }

  test("at local reach the private page is planned and the format skips are the same", async () => {
    const local = structured(await plan(fixture(true, TRANSPORT_REACH.local)));
    const remote = structured(await plan(fixture(true)));
    expect(local["skipped_non_extractable"]).toEqual(remote["skipped_non_extractable"]);
    expect(JSON.stringify(local["batches"])).toContain(PRIVATE_PATH);
    expect(JSON.stringify(remote["batches"])).not.toContain(PRIVATE_PATH);
  });
});

describe("wire emission of the extraction contract (t_586d5d8b)", () => {
  test("an unchanged contract emits no contract keys", async () => {
    // No manifest on disk reads back as current-shaped under the live
    // contract, so nothing about the contract may reach the wire.
    const result = structured(await plan(fixture(false)));
    expect(result["contract_changed"]).toBeUndefined();
    expect(result["contract_changed_files"]).toBeUndefined();
  });

  test("a v1 manifest surfaces contract_changed with the reprocess count", async () => {
    const f = fixture(false, TRANSPORT_REACH.local);
    const path = manifestPath(f.vault);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        entries: { "Clips/open.md": hashFile(join(f.vault, "Clips", "open.md")) },
      }),
      "utf8",
    );
    // readFileSync pins that the fixture really wrote the bytes it hashes.
    expect(readFileSync(join(f.vault, "Clips", "open.md"), "utf8")).toContain("Open");

    const result = structured(await plan(f));
    expect(result["contract_changed"]).toBe(true);
    expect(result["contract_changed_files"]).toBe(1);
  });
});

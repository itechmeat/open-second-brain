/**
 * `brain_ingest_source` on a CSV or TSV vault file renders its table note
 * onto the summary page and reports it on the wire, counts and tokens only.
 *
 * The table renderer reads source bytes, so it answers at the caller's
 * reach: through the real MCPServer with no reach minted (which fails
 * closed to remote), a vault holding a `.csv`-named source the caller may
 * not read and a vault without that file give identical normalised results
 * and pages - no table, no digest, `source-not-local`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { hashBytes } from "../../src/core/brain/ingest/content-manifest.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const CSV_PATH = "Clips/parts.csv";
const TSV_PATH = "Clips/parts.tsv";
const PARTS_CSV = "name,qty\nbolt,4\nnut,7\n";
const PRIVATE_BODY = "---\nvisibility: private\n---\nname,code\nvault,4711\n";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly server: MCPServer;
}

function fixture(
  files: Readonly<Record<string, string>>,
  reach?: typeof TRANSPORT_REACH.local,
): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-ingest-table-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Clips"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(vault, rel), text);
  const server = new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : undefined);
  return { vault, server };
}

function structured(result: Record<string, unknown>): Record<string, unknown> {
  const inner = result["structuredContent"];
  return (inner !== undefined ? inner : result) as Record<string, unknown>;
}

async function ingest(f: Fixture, sourcePath: string): Promise<Record<string, unknown>> {
  return structured(
    await f.server.callTool("brain_ingest_source", {
      source_path: sourcePath,
      summary: "Parts list.",
      entities: [{ category: "concept", name: "Fasteners" }],
    }),
  );
}

function pageOf(f: Fixture, result: Record<string, unknown>): string {
  return readFileSync(join(f.vault, String(result["summary_path"])), "utf8");
}

/** The frontmatter keys of a page, in order. */
function frontmatterKeys(page: string): string[] {
  const head = page.split("\n---\n")[0]!;
  return head
    .split("\n")
    .slice(1)
    .filter((line) => /^[a-z_]+:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
}

const TIMESTAMP_RE = /^(created_at|updated_at): .*$/gm;

/** Every Brain page outside the dated log, by forward-slash path, timestamps blanked. */
function normalisedPages(vault: string): Record<string, string> {
  const root = join(vault, "Brain");
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const rel = relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
    if (rel.startsWith("log/")) continue;
    out[rel] = readFileSync(join(entry.parentPath, entry.name), "utf8").replace(
      TIMESTAMP_RE,
      "$1: T",
    );
  }
  return Object.fromEntries(Object.entries(out).toSorted(([a], [b]) => a.localeCompare(b)));
}

describe("brain_ingest_source on a table source", () => {
  test("the table wire field, the five page keys and the section last", async () => {
    const f = fixture({ [CSV_PATH]: PARTS_CSV });
    const result = await ingest(f, CSV_PATH);
    expect(result["table"]).toEqual({
      rendered: true,
      format: "csv",
      delimiter: "comma",
      columns: 2,
      rows: 2,
      rows_rendered: 2,
      redacted_cells: 0,
    });
    const keys = Object.keys(result);
    expect(keys.indexOf("table")).toBe(keys.indexOf("capture_scope") + 1);

    const page = pageOf(f, result);
    const fm = frontmatterKeys(page);
    const derived = [
      "source_format",
      "source_content_hash",
      "table_delimiter",
      "table_columns",
      "table_rows",
      "table_rows_rendered",
    ];
    expect(fm.filter((key) => derived.includes(key))).toEqual(derived);
    expect(fm).not.toContain("table_truncated");
    expect(page).toContain("\nsource_format: csv\n");
    expect(page).toContain(
      `\nsource_content_hash: ${hashBytes(new TextEncoder().encode(PARTS_CSV))}\n`,
    );
    expect(page).toContain("\ntable_delimiter: comma\n");
    expect(page).toContain("\ntable_rows_rendered: 2\n");
    expect(
      page
        .trimEnd()
        .endsWith("## Table\n\n### Rows 1-2\n\n```table\nname | qty\nbolt | 4\nnut | 7\n```"),
    ).toBe(true);
  });

  test("a TSV source and a truncated table name what they are", async () => {
    const rows = Array.from({ length: 1_001 }, (_row, i) => `${i}\tx`).join("\n");
    const f = fixture({ [TSV_PATH]: `id\tv\n${rows}\n` });
    const result = await ingest(f, TSV_PATH);
    expect(result["table"]).toMatchObject({
      rendered: true,
      format: "tsv",
      delimiter: "tab",
      rows: 1_001,
      rows_rendered: 1_000,
      truncated: ["rows"],
    });
    const page = pageOf(f, result);
    expect(frontmatterKeys(page)).toContain("table_truncated");
    expect(page.trimEnd().endsWith("Rendered 1000 of 1001 rows.")).toBe(true);
  });

  test("a refused table is data: the page and entities are still written", async () => {
    const f = fixture({ [CSV_PATH]: 'name,qty\n"open,4\n' });
    const result = await ingest(f, CSV_PATH);
    expect(result["table"]).toEqual({
      rendered: false,
      format: "csv",
      reason: "malformed-quoting",
      detail: "2",
    });
    expect(result["entities_created"]).toHaveLength(1);
    expect(pageOf(f, result)).not.toContain("## Table");
  });

  test("a text source carries no table key", async () => {
    const f = fixture({ "Clips/notes.md": "# Notes\n" });
    const result = await ingest(f, "Clips/notes.md");
    expect("table" in result).toBe(false);
    expect("parts" in result).toBe(false);
    expect(pageOf(f, result)).not.toContain("source_format");
  });
});

describe("reach", () => {
  test("a hidden .csv-named source and an absent one answer identically at remote reach", async () => {
    const hidden = fixture({ [CSV_PATH]: PRIVATE_BODY });
    const absent = fixture({});
    const hiddenResult = await ingest(hidden, CSV_PATH);
    const absentResult = await ingest(absent, CSV_PATH);

    expect(JSON.stringify(hiddenResult)).toBe(JSON.stringify(absentResult));
    expect(hiddenResult["table"]).toEqual({
      rendered: false,
      format: "csv",
      reason: "source-not-local",
    });
    expect(normalisedPages(hidden.vault)).toEqual(normalisedPages(absent.vault));
    const page = pageOf(hidden, hiddenResult);
    expect(page).not.toContain("source_content_hash");
    expect(page).not.toContain("source_format");
    expect(page).not.toContain("## Table");
    expect(page).not.toContain("4711");
  });

  test("a URL source answers source-not-local without a digest", async () => {
    const f = fixture({});
    const result = await ingest(f, "https://example.com/parts.csv");
    expect(result["table"]).toEqual({ rendered: false, format: "csv", reason: "source-not-local" });
    expect(pageOf(f, result)).not.toContain("source_content_hash");
  });

  test("at local reach the same file is read and rendered", async () => {
    const f = fixture({ [CSV_PATH]: PRIVATE_BODY }, TRANSPORT_REACH.local);
    const result = await ingest(f, CSV_PATH);
    expect(result["table"]).toMatchObject({ rendered: true, format: "csv" });
    expect(pageOf(f, result)).toContain("source_content_hash");
  });
});

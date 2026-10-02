/**
 * `brain_ingest_source` on an HTML vault file writes the heading-derived
 * `## Parts` section onto the summary page and reports the part count on
 * the wire, counts only.
 *
 * The parts reader reads source bytes, so it answers at the caller's reach:
 * through the real MCPServer with no reach minted (which fails closed to
 * remote), a vault holding an HTML-named source the caller may not read and
 * a vault without that file give identical normalised results and pages -
 * no parts, no digest, `source-not-local`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { hashBytes } from "../../src/core/brain/ingest/content-manifest.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const HTML_PATH = "Clips/page.html";
const PAGE_HTML =
  "<html><head><title>Release notes</title></head><body><h1>Overview</h1>" +
  "<p>Fish &amp; chips</p><h2>Install</h2><p>Run it.</p></body></html>";
const PARTS_SECTION =
  "## Parts\n\n```parts\nh1 Overview | lines 1-2\nh2 Overview > Install | lines 3-4\n```";
/** An HTML-named file holding a Markdown page its owner keeps private. */
const PRIVATE_BODY = "---\nvisibility: private\n---\n<h1>Vault plan</h1><p>4711</p>\n";

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
  const base = mkdtempSync(join(tmpdir(), "o2b-ingest-parts-"));
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
      summary: "Release notes of the widget.",
      entities: [{ category: "concept", name: "Widget" }],
    }),
  );
}

function pageOf(f: Fixture, result: Record<string, unknown>): string {
  return readFileSync(join(f.vault, String(result["summary_path"])), "utf8");
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

describe("brain_ingest_source on an HTML source", () => {
  test("reports the part count and ends the page with the Parts section", async () => {
    const f = fixture({ [HTML_PATH]: PAGE_HTML });
    const result = await ingest(f, HTML_PATH);
    expect(result["parts"]).toEqual({ extracted: true, count: 2 });
    const keys = Object.keys(result);
    expect(keys.indexOf("parts")).toBe(keys.indexOf("capture_scope") + 1);
    expect("table" in result).toBe(false);

    const page = pageOf(f, result);
    expect(page).toContain("\nsource_format: html\n");
    expect(page).toContain(
      `\nsource_content_hash: ${hashBytes(new TextEncoder().encode(PAGE_HTML))}\n`,
    );
    expect(page.trimEnd().endsWith(PARTS_SECTION)).toBe(true);
    // Headings and line spans only: no body text of the source reaches the page.
    expect(page).not.toContain("Fish");
  });

  test("an HTML file that is not UTF-8 is data: the page is written without parts", async () => {
    const f = fixture({});
    writeFileSync(join(f.vault, HTML_PATH), new Uint8Array([0x3c, 0x68, 0x31, 0x3e, 0xff]));
    const result = await ingest(f, HTML_PATH);
    expect(result["parts"]).toEqual({ extracted: false, reason: "not-utf8" });
    expect(result["entities_created"]).toHaveLength(1);
    expect(pageOf(f, result)).not.toContain("## Parts");
  });

  test("a Markdown source carries no parts key", async () => {
    const f = fixture({ "Clips/notes.md": "# Notes\n" });
    const result = await ingest(f, "Clips/notes.md");
    expect("parts" in result).toBe(false);
    expect(pageOf(f, result)).not.toContain("source_format");
  });
});

describe("reach", () => {
  test("a hidden HTML-named source and an absent one answer identically at remote reach", async () => {
    const hidden = fixture({ [HTML_PATH]: PRIVATE_BODY });
    const absent = fixture({});
    const hiddenResult = await ingest(hidden, HTML_PATH);
    const absentResult = await ingest(absent, HTML_PATH);

    expect(JSON.stringify(hiddenResult)).toBe(JSON.stringify(absentResult));
    expect(hiddenResult["parts"]).toEqual({ extracted: false, reason: "source-not-local" });
    expect(normalisedPages(hidden.vault)).toEqual(normalisedPages(absent.vault));
    const page = pageOf(hidden, hiddenResult);
    expect(page).not.toContain("source_content_hash");
    expect(page).not.toContain("source_format");
    expect(page).not.toContain("## Parts");
    expect(page).not.toContain("Vault plan");
  });

  test("at local reach the same file is read and its parts written", async () => {
    const f = fixture({ [HTML_PATH]: PRIVATE_BODY }, TRANSPORT_REACH.local);
    const result = await ingest(f, HTML_PATH);
    expect(result["parts"]).toMatchObject({ extracted: true });
    const page = pageOf(f, result);
    expect(page).toContain("source_content_hash");
    expect(page).toContain("h1 Vault plan | lines");
  });
});

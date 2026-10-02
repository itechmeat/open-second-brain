/**
 * The derived section: an in-vault HTML, CSV or TSV source the caller may
 * read gets `source_format`, `source_content_hash` and its own section
 * (`## Parts` or `## Table`) on its summary page, last; every other source
 * - text, a URL, an absent file, a file hidden from the caller - is written
 * exactly as before, with the outcome named on the result. An operator's
 * `visibility` on a summary page survives a re-ingest.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { hashBytes } from "../../../../src/core/brain/ingest/content-manifest.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { INGEST_TOOLS } from "../../../../src/mcp/brain/ingest-tools.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";

const NOW = new Date("2026-06-13T12:00:00Z");
const LATER = new Date("2026-06-14T09:00:00Z");

const PAGE_HTML =
  "<html><head><title>Release notes</title></head><body><h1>Overview</h1><p>Fish &amp; chips</p><h2>Install</h2><p>Run it.</p></body></html>\n";
const PARTS_CSV = "name,qty\nbolt,4\nnut,7\n";

const PARTS_SECTION = [
  "## Parts",
  "",
  "```parts",
  "h1 Overview | lines 1-2",
  "h2 Overview > Install | lines 3-4",
  "```",
].join("\n");

const TABLE_SECTION = [
  "## Table",
  "",
  "### Rows 1-2",
  "",
  "```table",
  "name | qty",
  "bolt | 4",
  "nut | 7",
  "```",
].join("\n");

const bases: string[] = [];

function makeVault(): string {
  const base = mkdtempSync(join(tmpdir(), "o2b-derived-section-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(vault, { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  return vault;
}

let vault: string;

beforeEach(() => {
  vault = makeVault();
});

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function seed(root: string, rel: string, content: string | Uint8Array): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function input(sourcePath: string) {
  return {
    sourcePath,
    summary: "A clipped source.",
    extraction: { entities: [{ category: "concept", name: "Bolts" }], relations: [] },
  };
}

function page(root: string, summaryPath: string): string {
  return readFileSync(join(root, summaryPath), "utf8");
}

/** The frontmatter block of a page, as lines. */
function frontmatterLines(text: string): string[] {
  const end = text.indexOf("\n---\n", 4);
  return text.slice(4, end).split("\n");
}

/** Ingest the CSV, give its page `pageValue`, then re-ingest with `sourceValue`. */
function reingestWith(pageValue: string | undefined, sourceValue: string): string[] {
  seed(vault, "Clips/parts.csv", PARTS_CSV);
  const res = ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
  const abs = join(vault, res.summaryPath);
  if (pageValue !== undefined) {
    writeFileSync(
      abs,
      readFileSync(abs, "utf8").replace("\n---\n", `\nvisibility: ${pageValue}\n---\n`),
    );
  }
  seed(vault, "Clips/parts.csv", `---\nvisibility: ${sourceValue}\n---\n${PARTS_CSV}`);
  ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: LATER });
  return frontmatterLines(readFileSync(abs, "utf8"));
}

describe("an HTML source in the vault", () => {
  test("gets its format, its content hash and the Parts section last", () => {
    seed(vault, "Clips/page.html", PAGE_HTML);
    const res = ingestSource(vault, input("Clips/page.html"), { agent: "claude", now: NOW });
    expect(res.parts).toEqual({ extracted: true, count: 2 });
    expect(res.table).toBeUndefined();

    const text = page(vault, res.summaryPath);
    const fm = frontmatterLines(text);
    expect(fm).toContain("source_format: html");
    expect(fm).toContain(`source_content_hash: ${hashBytes(new TextEncoder().encode(PAGE_HTML))}`);
    expect(fm.indexOf("source_format: html")).toBe(
      fm.findIndex((l) => l.startsWith("source_content_hash:")) - 1,
    );
    expect(text.trimEnd().endsWith(PARTS_SECTION)).toBe(true);
    expect(text.indexOf("## Entities")).toBeLessThan(text.indexOf("## Parts"));
  });

  test("invalid UTF-8 names not-utf8, records the hash and writes no section", () => {
    const bytes = new Uint8Array([0x3c, 0x68, 0x31, 0x3e, 0xff, 0xfe]);
    seed(vault, "Clips/broken.html", bytes);
    const res = ingestSource(vault, input("Clips/broken.html"), { agent: "claude", now: NOW });
    expect(res.parts).toEqual({ extracted: false, reason: "not-utf8" });
    const text = page(vault, res.summaryPath);
    expect(frontmatterLines(text)).toContain(`source_content_hash: ${hashBytes(bytes)}`);
    expect(text).not.toContain("## Parts");
  });

  test("an HTML file the caller cannot read answers source-not-local", () => {
    seed(vault, "Clips/page.html", PAGE_HTML);
    const res = ingestSource(vault, input("Clips/page.html"), {
      agent: "claude",
      now: NOW,
      readable: () => false,
    });
    expect(res.parts).toEqual({ extracted: false, reason: "source-not-local" });
    const text = page(vault, res.summaryPath);
    expect(text).not.toContain("source_format");
    expect(text).not.toContain("source_content_hash");
    expect(text).not.toContain("## Parts");
  });
});

describe("a CSV source in the vault", () => {
  test("gets its format, its hash, the five table keys in order and the Table section last", () => {
    seed(vault, "Clips/parts.csv", PARTS_CSV);
    const res = ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
    expect(res.table).toEqual({
      rendered: true,
      format: "csv",
      delimiter: "comma",
      columns: 2,
      rows: 2,
      rowsRendered: 2,
      truncated: [],
      redactedCells: 0,
    });
    expect(res.parts).toBeUndefined();

    const text = page(vault, res.summaryPath);
    const fm = frontmatterLines(text);
    const at = fm.indexOf("source_format: csv");
    expect(at).toBeGreaterThan(-1);
    expect(fm.slice(at, at + 6)).toEqual([
      "source_format: csv",
      `source_content_hash: ${hashBytes(new TextEncoder().encode(PARTS_CSV))}`,
      "table_delimiter: comma",
      "table_columns: 2",
      "table_rows: 2",
      "table_rows_rendered: 2",
    ]);
    expect(fm.some((l) => l.startsWith("table_truncated"))).toBe(false);
    expect(text.trimEnd().endsWith(TABLE_SECTION)).toBe(true);
  });

  test("an unchanged re-ingest is inert and a changed file rewrites the section", () => {
    seed(vault, "Clips/parts.csv", PARTS_CSV);
    // The second ingest reaches the stable state (its entity now pre-exists
    // and is listed as a connection); a third with the same bytes is inert.
    ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
    const first = ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
    const before = page(vault, first.summaryPath);
    const abs = join(vault, first.summaryPath);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(abs, past, past);
    ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
    expect(page(vault, first.summaryPath)).toBe(before);
    // Inert means not rewritten at all: the mtime is the one set above.
    expect(statSync(abs).mtimeMs).toBe(past.getTime());

    seed(vault, "Clips/parts.csv", `${PARTS_CSV}washer,9\n`);
    const changed = ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: LATER });
    expect(changed.table).toMatchObject({ rendered: true, rows: 3 });
    expect(page(vault, first.summaryPath)).toContain("washer | 9");
  });
});

/** A page with no derived keys and no table section. */
function assertNoDerivation(text: string): void {
  expect(text).not.toContain("source_format");
  expect(text).not.toContain("source_content_hash");
  expect(text).not.toContain("table_");
  expect(text).not.toContain("## Table");
}

describe("a CSV source that is not local answers like an absent one", () => {
  const NOT_LOCAL = { rendered: false, format: "csv", reason: "source-not-local" } as const;

  test("a URL", () => {
    const res = ingestSource(vault, input("https://example.com/export/parts.csv"), {
      agent: "claude",
      now: NOW,
    });
    expect(res.table).toEqual(NOT_LOCAL);
    assertNoDerivation(page(vault, res.summaryPath));
  });

  test("an absent file", () => {
    const res = ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
    expect(res.table).toEqual(NOT_LOCAL);
    assertNoDerivation(page(vault, res.summaryPath));
  });

  test.skipIf(IS_WINDOWS)(
    "a FIFO named .csv answers like an absent file and does not block",
    () => {
      mkdirSync(join(vault, "Clips"), { recursive: true });
      expect(spawnSync("mkfifo", [join(vault, "Clips/parts.csv")]).status).toBe(0);
      const res = ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
      expect(res.table).toEqual(NOT_LOCAL);
      assertNoDerivation(page(vault, res.summaryPath));
    },
  );

  test("a hidden file answers exactly as an absent one: same result, same page", () => {
    seed(vault, "Clips/parts.csv", PARTS_CSV);
    const hidden = ingestSource(vault, input("Clips/parts.csv"), {
      agent: "claude",
      now: NOW,
      readable: (rel) => rel !== "Clips/parts.csv",
    });
    const other = makeVault();
    const absent = ingestSource(other, input("Clips/parts.csv"), {
      agent: "claude",
      now: NOW,
      readable: (rel) => rel !== "Clips/parts.csv",
    });
    expect(hidden).toEqual(absent);
    expect(hidden.table).toEqual(NOT_LOCAL);
    expect(page(vault, hidden.summaryPath)).toBe(page(other, absent.summaryPath));
    assertNoDerivation(page(vault, hidden.summaryPath));
  });
});

describe("a text source", () => {
  test("is written byte-identically to before, with no parts or table on the result", () => {
    seed(vault, "Notes/a.md", "# A\n\nBody.\n");
    const res = ingestSource(vault, input("Notes/a.md"), { agent: "claude", now: NOW });
    expect("parts" in res).toBe(false);
    expect("table" in res).toBe(false);
    expect(page(vault, res.summaryPath)).toBe(
      [
        "---",
        "kind: brain-source",
        "source_path: Notes/a.md",
        "source_hash: 4764013adda2ade4813ac7dddb5f4deb453cff19f705e137c07e0beddb9ef7c2",
        "provenance: stated",
        'created_at: "2026-06-13T12:00:00Z"',
        'updated_at: "2026-06-13T12:00:00Z"',
        "tags: [brain, brain/source]",
        "---",
        "",
        "A clipped source.",
        "",
        "## Sources",
        "",
        "- [[Notes/a.md]]",
        "",
        "## Entities",
        "",
        "- [[ent-concept-bolts]]",
        "",
      ].join("\n"),
    );
  });
});

describe("visibility on a summary page", () => {
  test("an operator-set visibility survives a re-ingest", () => {
    seed(vault, "Notes/a.md", "# A\n");
    const res = ingestSource(vault, input("Notes/a.md"), { agent: "claude", now: NOW });
    const abs = join(vault, res.summaryPath);
    const text = readFileSync(abs, "utf8");
    writeFileSync(abs, text.replace("\n---\n", "\nvisibility: private\n---\n"));

    ingestSource(vault, input("Notes/a.md"), { agent: "claude", now: LATER });
    const after = readFileSync(abs, "utf8");
    expect(frontmatterLines(after)).toContain("visibility: private");
    expect(after).toContain('updated_at: "2026-06-14T09:00:00Z"');
  });

  test("a summary page carrying a derived section is at most as visible as its source", () => {
    seed(vault, "Clips/parts.csv", `---\nvisibility: [private]\n---\n${PARTS_CSV}`);
    const res = ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
    expect(res.table).toMatchObject({ rendered: true, rows: 2 });
    expect(frontmatterLines(page(vault, res.summaryPath))).toContain("visibility: [private]");
  });

  test("a source moved to another audience withholds the page rather than widening it", () => {
    seed(vault, "Clips/parts.csv", `---\nvisibility: team-a\n---\n${PARTS_CSV}`);
    const res = ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: NOW });
    const abs = join(vault, res.summaryPath);
    expect(frontmatterLines(readFileSync(abs, "utf8"))).toContain("visibility: [team-a]");

    seed(vault, "Clips/parts.csv", `---\nvisibility: team-b\n---\n${PARTS_CSV}`);
    ingestSource(vault, input("Clips/parts.csv"), { agent: "claude", now: LATER });
    const after = frontmatterLines(readFileSync(abs, "utf8"));
    expect(after).toContain("visibility: [private]");
    expect(after.join("\n")).not.toContain("team-a");
  });

  test("an operator audience the source does not share withholds the page", () => {
    expect(reingestWith("team", "team-a")).toContain("visibility: [private]");
  });

  test("the reserved token on the source keeps the page reserved", () => {
    expect(reingestWith("[team, private]", "private")).toContain("visibility: [private]");
  });

  test("an audience both the operator and the source allow is kept", () => {
    expect(reingestWith("[team, ops]", "[team, team-b]")).toContain("visibility: [team]");
  });

  test("the source's tokens are written when the page declares none", () => {
    expect(reingestWith(undefined, "team-a")).toContain("visibility: [team-a]");
  });

  test("a page with no visibility gains none", () => {
    seed(vault, "Notes/a.md", "# A\n");
    const res = ingestSource(vault, input("Notes/a.md"), { agent: "claude", now: NOW });
    ingestSource(vault, input("Notes/a.md"), { agent: "claude", now: LATER });
    expect(page(vault, res.summaryPath)).not.toContain("visibility");
  });
});

/** The arguments `brain_ingest_source` took before the derived section existed. */
const PRE_DERIVATION_ARGUMENTS = Object.freeze([
  "source_path",
  "summary",
  "entities",
  "relations",
  "agent",
  "plan_id",
  "pre_extract",
]);

describe("brain_ingest_source arguments", () => {
  test("are unchanged: the derived section needs no new argument", () => {
    const tool = INGEST_TOOLS.find((t) => t.name === "brain_ingest_source")!;
    const schema = tool.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual([...PRE_DERIVATION_ARGUMENTS]);
  });
});

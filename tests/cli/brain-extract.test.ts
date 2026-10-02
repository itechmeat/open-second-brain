/**
 * `o2b brain extract <file> [--json]`: the read-only preview of what ingest
 * derives from one source file, for every registered format. The text and
 * JSON shapes are pinned against `docs/brainstorm/non-markdown-ingest/
 * cli-output/expected-output.md`; "could not extract" is data, so every
 * answer exits 0.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_COMMAND_MANIFEST, type CliCommandManifest } from "../../src/cli/command-manifest.ts";
import { HTML_EXTRACT_MAX_SOURCE_BYTES } from "../../src/core/brain/ingest/extract-html.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";

/** The fixture files of the expected-output document. */
const PAGE_HTML =
  "<html><head><title>Release notes</title></head><body><h1>Overview</h1>" +
  "<p>Fish &amp; chips</p><h2>Install</h2><p>Run it.</p></body></html>";
const PARTS_CSV = "name,qty\nbolt,4\nnut,7\n";
const TABLE_SECTION = "## Table\n\n### Rows 1-2\n\n```table\nname | qty\nbolt | 4\nnut | 7\n```";

/** The manifest entry of `o2b brain extract`. */
function extractManifest(): CliCommandManifest | undefined {
  const brain = CLI_COMMAND_MANIFEST.commands.find((c) => c.name === "brain");
  return brain?.commands?.find((c) => c.name === "extract");
}

let work: string;

/** Write `content` to `name` in the work folder and answer its path. */
function fixture(name: string, content: string): string {
  const path = join(work, name);
  writeFileSync(path, content, "utf8");
  return path;
}

/** Run the verb with `--json` on `path`, expecting exit 0, and parse its output. */
async function extractJson(path: string): Promise<Record<string, unknown>> {
  const res = await runCli(["brain", "extract", path, "--json"]);
  expect(res.returncode).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

/** Run the verb in text mode on `path`, expecting exit 0, and answer stdout. */
async function extractText(path: string): Promise<string> {
  const res = await runCli(["brain", "extract", path]);
  expect(res.returncode).toBe(0);
  return res.stdout;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "o2b-extract-cli-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("o2b brain extract", () => {
  test("is in the CLI manifest with a --json flag", () => {
    expect(extractManifest()?.flags).toEqual([{ name: "json", type: "boolean" }]);
  });

  test("an HTML file prints its title and parts", async () => {
    const path = fixture("page.html", PAGE_HTML);
    expect(await extractText(path)).toBe(
      [
        `extract: ${path} (html)`,
        "  title: Release notes",
        "  2 part(s):",
        "    h1 Overview | lines 1-2",
        "    h2 Overview > Install | lines 3-4",
        "",
      ].join("\n"),
    );
  });

  test("an HTML file as JSON gives the text and every part", async () => {
    const path = fixture("page.html", PAGE_HTML);
    expect(await extractJson(path)).toEqual({
      ok: true,
      path,
      extracted: true,
      format: "html",
      title: "Release notes",
      text: "Overview\nFish & chips\nInstall\nRun it.",
      parts: [
        {
          index: 0,
          level: 1,
          heading: "Overview",
          trail: "Overview",
          line_start: 1,
          line_end: 2,
          source_offset: 53,
        },
        {
          index: 1,
          level: 2,
          heading: "Install",
          trail: "Overview > Install",
          line_start: 3,
          line_end: 4,
          source_offset: 93,
        },
      ],
    });
  });

  test("an HTML file whose bytes are not UTF-8 is not extracted, by name", async () => {
    const path = join(work, "bad.html");
    writeFileSync(path, new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe]));
    expect(await extractJson(path)).toEqual({
      ok: true,
      path,
      extracted: false,
      format: "html",
      reason: "not-utf8",
    });
  });

  test("a CSV file prints its counts and the table section", async () => {
    const path = fixture("parts.csv", PARTS_CSV);
    expect(await extractText(path)).toBe(
      [
        `extract: ${path} (csv)`,
        "  comma-delimited, 2 column(s), 2 row(s), 2 rendered, 0 redacted cell(s)",
        TABLE_SECTION,
        "",
      ].join("\n"),
    );
  });

  test("a CSV file as JSON gives the counts and the section", async () => {
    const path = fixture("parts.csv", PARTS_CSV);
    const out = await extractJson(path);
    expect(out).toEqual({
      ok: true,
      path,
      extracted: true,
      format: "csv",
      delimiter: "comma",
      columns: 2,
      rows: 2,
      rows_rendered: 2,
      redacted_cells: 0,
      section: TABLE_SECTION,
    });
    expect(Object.keys(out)).toEqual([
      "ok",
      "path",
      "extracted",
      "format",
      "delimiter",
      "columns",
      "rows",
      "rows_rendered",
      "redacted_cells",
      "section",
    ]);
  });

  test("a CSV with an unterminated quote is not extracted and names the record", async () => {
    const path = fixture("broken.csv", 'a,b\n"open,1\n');
    const out = await extractJson(path);
    expect(out).toMatchObject({
      ok: true,
      path,
      extracted: false,
      format: "csv",
      reason: "malformed-quoting",
    });
    expect(typeof out["detail"]).toBe("string");
    expect(await extractText(path)).toStartWith(
      `extract: ${path} (csv)\n  not extracted: malformed-quoting (`,
    );
  });

  test("a PDF and a Markdown file are named, not extracted", async () => {
    const pdf = fixture("report.pdf", "%PDF-1.7");
    const md = fixture("notes.md", "# Notes\n\nbody\n");
    expect(await extractJson(pdf)).toEqual({
      ok: true,
      path: pdf,
      extracted: false,
      format: "pdf",
      reason: "format-not-extractable",
    });
    expect(await extractJson(md)).toEqual({
      ok: true,
      path: md,
      extracted: false,
      format: "text",
      reason: "format-read-verbatim",
    });
    expect(await extractText(pdf)).toBe(
      `extract: ${pdf} (pdf)\n  not extracted: format-not-extractable\n`,
    );
  });

  test("an unknown extension answers a null format", async () => {
    const path = fixture("blob.xyz", "abc");
    expect(await extractJson(path)).toEqual({
      ok: true,
      path,
      extracted: false,
      format: null,
      reason: "format-unknown",
    });
    expect(await extractText(path)).toBe(
      `extract: ${path} (unknown)\n  not extracted: format-unknown\n`,
    );
  });

  test.skipIf(IS_WINDOWS)("a FIFO is answered as not a regular file without blocking", async () => {
    const path = join(work, "pipe.html");
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    expect(await extractJson(path)).toEqual({
      ok: true,
      path,
      extracted: false,
      format: "html",
      reason: "not-a-regular-file",
    });
  });

  test("a file over the read cap is named source-too-large, as data", async () => {
    const path = fixture("huge.csv", "a,b\n");
    truncateSync(path, HTML_EXTRACT_MAX_SOURCE_BYTES + 1);
    expect(await extractJson(path)).toEqual({
      ok: true,
      path,
      extracted: false,
      format: "csv",
      reason: "source-too-large",
    });
    expect(await extractText(path)).toBe(
      `extract: ${path} (csv)\n  not extracted: source-too-large\n`,
    );
  });

  test("a format with no extractor is named before the file is read", async () => {
    const path = fixture("scan.pdf", "%PDF-1.7\n");
    truncateSync(path, HTML_EXTRACT_MAX_SOURCE_BYTES + 1);
    expect(await extractJson(path)).toEqual({
      ok: true,
      path,
      extracted: false,
      format: "pdf",
      reason: "format-not-extractable",
    });
  });

  test.each(["absent.html", "absent.pdf"])(
    "a missing file is an error, not data (%s)",
    async (name) => {
      const res = await runCli(["brain", "extract", join(work, name)]);
      expect(res.returncode).toBe(1);
      expect(res.stderr).toContain(name);
    },
  );

  test.skipIf(IS_WINDOWS).each([".html", ".md"])(
    "a symbolic link is an error, not data (%s)",
    async (ext) => {
      const real = fixture(`real${ext}`, PAGE_HTML);
      const link = join(work, `link${ext}`);
      symlinkSync(real, link);
      const res = await runCli(["brain", "extract", link]);
      expect(res.returncode).toBe(1);
      expect(res.stderr).toContain(`link${ext}`);
    },
  );

  test("no file argument is a usage error", async () => {
    const res = await runCli(["brain", "extract"]);
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("usage: o2b brain extract <file> [--json]");
  });
});

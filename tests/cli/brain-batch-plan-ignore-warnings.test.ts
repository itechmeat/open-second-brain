/**
 * t_4b2bd8f7 follow-through: `o2b brain batch-plan` renders the planner's
 * `ignoreWarnings` on both the `--json` payload (structured, same key as the
 * MCP surface) and the human-readable surface (naming the offending file), in
 * the same non-fatal-reporting style the verb already uses for
 * `skippedNonExtractable`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { INGEST_TOOLS } from "../../src/mcp/brain/ingest-tools.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-batchplan-warn-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-batchplan-warn-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function write(rel: string, content = "content\n"): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const ENV = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b brain batch-plan ignore_warnings (t_4b2bd8f7 follow-through)", () => {
  test("--json surfaces the warning with its structured fields", async () => {
    write("mono/keep.md");
    write("mono/.gitignore", "[unterminated\n");

    const res = await runCli(["brain", "batch-plan", "mono", "--json"], { env: ENV() });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    expect(plan.ignore_warnings).toEqual([
      {
        source: "mono/.gitignore",
        line: 1,
        pattern: "[unterminated",
        reason: expect.stringContaining("unterminated"),
      },
    ]);
    // Still succeeds; the file it could not filter is still discovered.
    expect(plan.total_files).toBe(1);
  });

  test("the human-readable surface names the file the bad pattern came from", async () => {
    write("mono/keep.md");
    write("mono/.gitignore", "[unterminated\n");

    const res = await runCli(["brain", "batch-plan", "mono"], { env: ENV() });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("mono/.gitignore");
    expect(res.stdout).toContain("[unterminated");
  });

  test("a clean tree's --json output omits the key entirely", async () => {
    write("mono/a.md");

    const res = await runCli(["brain", "batch-plan", "mono", "--json"], { env: ENV() });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    expect("ignore_warnings" in plan).toBe(false);
  });

  test("a clean tree's human-readable output carries no warning line", async () => {
    write("mono/a.md");

    const res = await runCli(["brain", "batch-plan", "mono"], { env: ENV() });
    expect(res.returncode).toBe(0);
    expect(res.stdout).not.toMatch(/malformed/i);
  });

  // chmod 000 denies nothing to root or on Windows (tests/helpers/platform.ts).
  test.skipIf(CHMOD_CANNOT_DENY)("an unreadable .gitignore reaches both CLI surfaces", async () => {
    write("mono/secret.md");
    write("mono/.gitignore", "secret.md\n");
    chmodSync(join(vault, "mono", ".gitignore"), 0o000);

    const json = await runCli(["brain", "batch-plan", "mono", "--json"], { env: ENV() });
    expect(json.returncode).toBe(0);
    const plan = JSON.parse(json.stdout);
    expect(plan.ignore_warnings).toEqual([
      {
        source: "mono/.gitignore",
        line: 0,
        pattern: "",
        reason: expect.stringContaining("EACCES"),
      },
    ]);
    // The file the repository declared excluded is queued - but never silently.
    expect(plan.total_files).toBe(1);

    const human = await runCli(["brain", "batch-plan", "mono"], { env: ENV() });
    expect(human.returncode).toBe(0);
    expect(human.stdout).toContain("mono/.gitignore");
    expect(human.stdout).toContain("EACCES");
  });

  test("a subpath into an ignored subtree reports the override on both surfaces", async () => {
    write("mono/pkg/a/keep.md");
    write("mono/.gitignore", "pkg/\n");

    const json = await runCli(["brain", "batch-plan", "mono", "--src-subpath", "pkg/a", "--json"], {
      env: ENV(),
    });
    expect(json.returncode).toBe(0);
    const plan = JSON.parse(json.stdout);
    expect(plan.total_files).toBe(0);
    expect(plan.ignore_warnings).toHaveLength(1);
    expect(plan.ignore_warnings[0].source).toBe("--src-subpath");

    const human = await runCli(["brain", "batch-plan", "mono", "--src-subpath", "pkg/a"], {
      env: ENV(),
    });
    expect(human.returncode).toBe(0);
    expect(human.stdout).toContain("--src-subpath");
    expect(human.stdout).toContain("mono/pkg");
  });

  test("a subpath crossing a submodule boundary fails loudly", async () => {
    write("mono/sub/inner/x.md");
    write("mono/sub/.git", "gitdir: ../.git/modules/sub\n");

    const res = await runCli(["brain", "batch-plan", "mono", "--src-subpath", "sub/inner"], {
      env: ENV(),
    });
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("nested repository boundary");
  });
});

describe("the CLI and MCP batch-plan payloads come from one serializer", () => {
  test("--json equals the MCP payload for the same plan", async () => {
    write("mono/a.md");
    write("mono/pkg/b.md");
    write("mono/.gitignore", "[unterminated\n");

    const res = await runCli(["brain", "batch-plan", "mono", "--json"], { env: ENV() });
    expect(res.returncode).toBe(0);
    const { ok, ...cli } = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(ok).toBe(true);

    const handler = INGEST_TOOLS.find((t) => t.name === "brain_ingest_batch_plan")!.handler;
    const mcp = (await handler(
      { vault, configPath, repoRoot: null },
      { source_dir: "mono" },
    )) as Record<string, unknown>;

    // Same keys in the same order, same values: one serializer, two surfaces.
    expect(Object.keys(cli)).toEqual(Object.keys(mcp));
    expect(cli).toEqual(mcp);
  });
});

/** A vault whose schema pack gates ingest to `paper` pages only. */
function gateToPaper(): void {
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    "schema_version: 1\nschema:\n  page_types:\n    - paper\n    - memo\n  extractable:\n    - paper\n",
    "utf8",
  );
}

describe("o2b brain batch-plan skip-reason counts (P4)", () => {
  test("the human surface renders the per-reason counts", async () => {
    write("mono/a.md", "---\nschema_type: paper\n---\nbody\n");
    write("mono/b.md", "---\nschema_type: memo\n---\nbody\n");
    gateToPaper();

    const res = await runCli(["brain", "batch-plan", "mono"], { env: ENV() });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("schema-type-not-extractable=1");
    expect(res.stdout).toContain("memo");
  });

  test("the --json payload carries the typed token and the counts", async () => {
    write("mono/a.md", "---\nschema_type: paper\n---\nbody\n");
    write("mono/b.md", "---\nschema_type: memo\n---\nbody\n");
    gateToPaper();

    const res = await runCli(["brain", "batch-plan", "mono", "--json"], { env: ENV() });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    expect(plan.skipped_non_extractable).toEqual([
      { path: "mono/b.md", reason: "schema-type-not-extractable", detail: "memo" },
    ]);
    expect(plan.skip_reason_counts).toEqual({ "schema-type-not-extractable": 1 });
  });
});

describe("o2b brain batch-plan unclassifiable counts (P4)", () => {
  test("the human surface renders the per-extension counts", async () => {
    write("mono/a.md");
    write("mono/pic.bin", "binary");
    write("mono/data.dat", "a,b\n");

    const res = await runCli(["brain", "batch-plan", "mono"], { env: ENV() });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("2 unclassifiable file(s)");
    expect(res.stdout).toContain(".bin: 1");
    expect(res.stdout).toContain(".dat: 1");
  });

  test("a tree with no unclassifiable files renders no count and carries no key on the wire", async () => {
    write("mono/a.md");

    const human = await runCli(["brain", "batch-plan", "mono"], { env: ENV() });
    expect(human.returncode).toBe(0);
    expect(human.stdout).not.toContain("unclassifiable");

    const json = await runCli(["brain", "batch-plan", "mono", "--json"], { env: ENV() });
    expect(json.returncode).toBe(0);
    const plan = JSON.parse(json.stdout);
    expect("unclassifiable" in plan).toBe(false);
  });

  test("the --json payload carries the total and per-extension counts", async () => {
    write("mono/a.md");
    write("mono/pic.bin", "binary");
    write("mono/data.dat", "a,b\n");

    const res = await runCli(["brain", "batch-plan", "mono", "--json"], { env: ENV() });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    expect(plan.unclassifiable).toEqual({ total: 2, by_extension: { ".bin": 1, ".dat": 1 } });
  });
});

describe("o2b brain batch-plan source formats", () => {
  const PAGE_HTML =
    "<html><head><title>Release notes</title></head><body><h1>Overview</h1><p>Fish &amp; chips</p><h2>Install</h2><p>Run it.</p></body></html>\n";

  function clips(): void {
    write("Clips/page.html", PAGE_HTML);
    write("Clips/parts.csv", "name,qty\nbolt,4\nnut,7\n");
    write("Clips/report.pdf", "%PDF-1.7\n");
    write("Clips/blob.bin", "abc");
    write("Clips/notes.md", "# Notes\n\nHello\n");
  }

  test("the text surface lists the planned format and names the format skip", async () => {
    clips();
    const res = await runCli(["brain", "batch-plan", "Clips"], { env: ENV() });
    expect(res.returncode).toBe(0);
    const body = res.stdout.replace(/\(plan [0-9a-f]+\)/, "(plan <plan id>)");
    expect(body).toContain(
      [
        "batch-plan: Clips (plan <plan id>)",
        "  3 file(s) to ingest in 1 batch(es); 0 unchanged skipped",
        "  batch 0: 3 file(s), 175 byte(s)",
        "    - Clips/notes.md (new, 15B)",
        "    - Clips/page.html (new, 138B, html)",
        "    - Clips/parts.csv (new, 22B, csv)",
        "  1 non-extractable page(s) skipped:",
        "    - Clips/report.pdf (format-not-extractable: pdf)",
        "    by reason: format-not-extractable=1",
        "  1 unclassifiable file(s) not planned, by extension:",
        "    - .bin: 1",
      ].join("\n"),
    );
  });

  test("--json carries format on the planned file and the format skip", async () => {
    clips();
    const res = await runCli(["brain", "batch-plan", "Clips", "--json"], { env: ENV() });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    expect(plan.total_files).toBe(3);
    expect(plan.total_bytes).toBe(175);
    expect(plan.skipped_non_extractable).toEqual([
      { path: "Clips/report.pdf", reason: "format-not-extractable", detail: "pdf" },
    ]);
    expect(plan.skip_reason_counts).toEqual({ "format-not-extractable": 1 });
    expect(plan.unclassifiable).toEqual({ total: 1, by_extension: { ".bin": 1 } });
    expect(plan.batches[0].files).toEqual([
      { path: "Clips/notes.md", bytes: 15, status: "new" },
      { path: "Clips/page.html", bytes: 138, status: "new", format: "html" },
      { path: "Clips/parts.csv", bytes: 22, status: "new", format: "csv" },
    ]);
  });
});

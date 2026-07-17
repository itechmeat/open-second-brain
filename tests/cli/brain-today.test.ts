/**
 * CLI tests for the today-operator-surface verbs (Task 7):
 *   - `o2b brain today` renders the read-only dashboard (text + --json)
 *     and fails closed on a malformed numeric flag.
 *   - `o2b brain apply-markers` reports pending `@osb set` write-backs by
 *     default (no writes), refuses --apply when the guardrail is off, and
 *     mutates + consumes the marker when the guardrail is on.
 *
 * Each verb runs end-to-end through `runCli` (in-process fast path). The
 * apply-markers cases overwrite `_brain.yaml` with a schema-pack + notes
 * read-path + guardrail block, mirroring the fixture in
 * tests/core/brain/marker-writeback.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-today-test-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "Test"], { env: env() });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], { env: env() });
  expect(brainInit.returncode).toBe(0);
}

/** Overwrite `_brain.yaml` with a schema-pack + notes + guardrail block. */
function writeMarkerConfig(markerWriteback: boolean): void {
  const lines = [
    "schema_version: 1",
    "primary_agent: null",
    "",
    "schema:",
    "  page_types: [paper]",
    "  attributes:",
    "    - paper.status=reading status",
    "    - paper.year=publication year",
    "",
    "notes:",
    "  read_paths:",
    "    - Notes",
    "",
    "guardrails:",
    `  marker_writeback: ${markerWriteback ? "true" : "false"}`,
    "",
  ];
  writeFileSync(join(vault, "Brain", "_brain.yaml"), lines.join("\n"), "utf8");
}

function writePaper(rel: string): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    ["---", "type: paper", "title: A Paper", "---", "", "# A Paper", "", "body", ""].join("\n"),
    "utf8",
  );
}

function writeSource(rel: string, marker: string): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `# Journal\n\n${marker}\n`, "utf8");
}

describe("brain today", () => {
  test("renders the four-section dashboard", async () => {
    await bootstrap();
    const add = await runCli(
      [
        "brain",
        "obligation",
        "add",
        "--vault",
        vault,
        "--title",
        "Water plants",
        "--cadence",
        "weekly",
      ],
      { env: env() },
    );
    expect(add.returncode).toBe(0);

    const r = await runCli(["brain", "today", "--vault", vault], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("## Obligations");
    expect(r.stdout).toContain("## Open loops");
    expect(r.stdout).toContain("## Recent activity");
    expect(r.stdout).toContain("## Totals");
    expect(r.stdout).toContain("Water plants");
  });

  test("--json emits a structured envelope", async () => {
    await bootstrap();
    const r = await runCli(["brain", "today", "--vault", vault, "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.totals).toBeDefined();
    expect(parsed.obligations).toBeDefined();
    expect(typeof parsed.text).toBe("string");
  });

  test("malformed numeric flag fails closed with exit 2", async () => {
    await bootstrap();
    const r = await runCli(["brain", "today", "--vault", vault, "--limit", "abc"], { env: env() });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toMatch(/--limit/);
  });
});

describe("brain apply-markers", () => {
  test("report mode lists pending markers and writes nothing", async () => {
    await bootstrap();
    writeMarkerConfig(false);
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=status value=queued");

    const r = await runCli(["brain", "apply-markers", "--vault", vault], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("would-apply");
    expect(r.stdout).toMatch(/pending: 1/);

    // Nothing written: target frontmatter untouched, source unconsumed.
    expect(readFileSync(join(vault, "Notes/paper.md"), "utf8")).not.toContain("status: queued");
    expect(readFileSync(join(vault, "Notes/journal.md"), "utf8")).not.toContain("@osb✓");
  });

  test("--apply with the guardrail off refuses and writes nothing", async () => {
    await bootstrap();
    writeMarkerConfig(false);
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=status value=queued");

    const r = await runCli(["brain", "apply-markers", "--vault", vault, "--apply"], {
      env: env(),
    });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toMatch(/marker_writeback/);

    expect(readFileSync(join(vault, "Notes/paper.md"), "utf8")).not.toContain("status: queued");
    expect(readFileSync(join(vault, "Notes/journal.md"), "utf8")).not.toContain("@osb✓");
  });

  test("--apply with the guardrail on mutates frontmatter and consumes the marker", async () => {
    await bootstrap();
    writeMarkerConfig(true);
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=status value=queued");

    const r = await runCli(["brain", "apply-markers", "--vault", vault, "--apply"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("applied");
    expect(r.stdout).toMatch(/applied: 1/);

    expect(readFileSync(join(vault, "Notes/paper.md"), "utf8")).toContain("status=queued");
    expect(readFileSync(join(vault, "Notes/journal.md"), "utf8")).toContain("@osb✓");
  });
});

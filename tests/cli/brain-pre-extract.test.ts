/**
 * P4 (t_ef786747): the `o2b brain pre-extract` CLI runs the deterministic
 * no-LLM code-structure pass over one source file and prints its JSON seeds.
 * The extraction itself is covered at the core level; this asserts the verb is
 * wired, emits deterministic JSON, and reports unknown languages as unextracted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCli } from "../helpers/run-cli.ts";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "o2b-pre-extract-cli-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("o2b brain pre-extract", () => {
  test("emits deterministic JSON seeds for a code source", async () => {
    const file = join(work, "widget.ts");
    writeFileSync(
      file,
      'import { h } from "./dom";\nexport class Widget extends Base {}\n',
      "utf8",
    );
    const res = await runCli(["brain", "pre-extract", file, "--json"]);
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.extracted).toBe(true);
    expect(out.language).toBe("typescript");
    expect(out.entities).toEqual([{ kind: "class", name: "Widget" }]);
    expect(out.edges).toEqual([
      { kind: "imports", from: file, to: "./dom" },
      { kind: "inherits", from: "Widget", to: "Base" },
    ]);
  });

  test("reports an unsupported extension as unextracted rather than empty success", async () => {
    const file = join(work, "notes.txt");
    writeFileSync(file, "class NotCode {}\n", "utf8");
    const res = await runCli(["brain", "pre-extract", file, "--json"]);
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.extracted).toBe(false);
    expect(out.reason).toContain(".txt");
  });

  test("a missing file fails with a nonzero exit", async () => {
    const res = await runCli(["brain", "pre-extract", join(work, "nope.ts"), "--json"]);
    expect(res.returncode).not.toBe(0);
  });

  test("without a file argument prints usage and exits nonzero", async () => {
    const res = await runCli(["brain", "pre-extract"]);
    expect(res.returncode).not.toBe(0);
    expect(res.stderr).toContain("usage:");
  });
});

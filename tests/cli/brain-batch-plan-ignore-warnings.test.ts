/**
 * t_4b2bd8f7 follow-through: `o2b brain batch-plan` renders the planner's
 * `ignoreWarnings` on both the `--json` payload (structured, same key as the
 * MCP surface) and the human-readable surface (naming the offending file), in
 * the same non-fatal-reporting style the verb already uses for
 * `skippedNonExtractable`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
});

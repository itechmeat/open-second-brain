/**
 * `o2b brain links normalize` (Workspace Insight Suite, t_5f31b5f1):
 * CLI surface over the wikilink format kernel.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-links-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "notes", "deep"), { recursive: true });
  writeFileSync(join(vault, "Brain", "notes", "alpha.md"), "# Alpha\n");
  writeFileSync(join(vault, "Brain", "notes", "deep", "beta.md"), "# Beta deep\n");
  writeFileSync(join(vault, "Brain", "beta.md"), "# Beta top\n");
  writeFileSync(
    join(vault, "Brain", "notes", "index.md"),
    "Links: [[alpha]], [[beta]], [[Brain/notes/deep/beta]].\n",
  );
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

test("dry-run reports rewrites and ambiguities without touching files", async () => {
  const before = readFileSync(join(vault, "Brain", "notes", "index.md"), "utf8");
  const r = await runCli(["brain", "links", "normalize", "--mode", "full", "--json"], {
    env: env(),
  });
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as {
    applied: boolean;
    total_changed: number;
    files: Array<{ path: string; ambiguous: string[] }>;
  };
  expect(parsed.applied).toBe(false);
  expect(parsed.total_changed).toBe(1); // [[alpha]] -> full; [[beta]] ambiguous; deep/beta already full
  expect(parsed.files[0]!.ambiguous).toEqual(["beta"]);
  expect(readFileSync(join(vault, "Brain", "notes", "index.md"), "utf8")).toBe(before);
});

test("--write applies the full-path rewrite", async () => {
  const r = await runCli(["brain", "links", "normalize", "--mode", "full", "--write"], {
    env: env(),
  });
  expect(r.returncode).toBe(0);
  const after = readFileSync(join(vault, "Brain", "notes", "index.md"), "utf8");
  expect(after).toContain("[[Brain/notes/alpha]]");
  expect(after).toContain("[[beta]]"); // ambiguous, untouched
});

test("config key supplies the default mode; unknown --mode fails", async () => {
  writeFileSync(config, `vault: "${vault}"\nwiki_link_format: "short"\n`);
  const r = await runCli(["brain", "links", "normalize", "--write", "--json"], { env: env() });
  expect(r.returncode).toBe(0);
  const after = readFileSync(join(vault, "Brain", "notes", "index.md"), "utf8");
  expect(after).toContain("[[deep/beta]]");

  const bad = await runCli(["brain", "links", "normalize", "--mode", "fancy"], { env: env() });
  expect(bad.returncode).not.toBe(0);
});

test("preserve mode (default) changes nothing", async () => {
  const r = await runCli(["brain", "links", "normalize", "--write", "--json"], { env: env() });
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { mode: string; total_changed: number };
  expect(parsed.mode).toBe("preserve");
  expect(parsed.total_changed).toBe(0);
});

/**
 * CLI `--match-mode` on `o2b search query` (t_c5326ece): the flag mirrors
 * the MCP `match_mode` argument - `any` genuinely widens the query, and a
 * value outside the pair is refused by name rather than read as the default.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { FTS_MATCH_MODES } from "../../src/core/search/fts-match-mode.ts";

let tmp: string;
let vault: string;
let configPath: string;

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-match-mode-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  writeFileSync(
    join(vault, "notes", "both.md"),
    "# Both\n\nchimera basilisk together in one lair.\n",
    "utf8",
  );
  writeFileSync(join(vault, "notes", "one.md"), "# One\n\nA lone chimera wanders here.\n", "utf8");
  const indexed = await runCli(["search", "index"], { env: env() });
  if (indexed.returncode !== 0) throw new Error(`search index failed: ${indexed.stderr}`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface QueryJson {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runQuery(extra: ReadonlyArray<string>): Promise<QueryJson> {
  const r = await runCli(
    ["search", "query", "chimera basilisk", "--json", "--limit", "20", ...extra],
    {
      env: env(),
    },
  );
  return { returncode: r.returncode, stdout: r.stdout, stderr: r.stderr };
}

const pathsIn = (stdout: string): string[] =>
  JSON.parse(stdout).results.map((h: { path: string }) => h.path);

describe("o2b search query --match-mode", () => {
  test("--match-mode any reaches the search and keeps the single-term document", async () => {
    const r = await runQuery(["--match-mode", "any"]);
    expect(r.returncode).toBe(0);
    expect(pathsIn(r.stdout).some((p) => p.includes("one.md"))).toBe(true);
  });

  test("a value outside all|any is refused", async () => {
    const r = await runQuery(["--match-mode", "sometimes"]);
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain(`--match-mode must be one of ${FTS_MATCH_MODES.join(", ")}`);
  });
});

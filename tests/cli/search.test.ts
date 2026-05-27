/**
 * CLI tests for `o2b search *`.
 *
 * Each test forks the actual `bun src/cli/main.ts` binary via `runCli`,
 * the same harness `tests/cli/brain.test.ts` uses. We assert exit codes,
 * canonical text patterns, and the JSON shape produced by `--json`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

function writeVaultFile(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-search-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("search index creates the index file under <vault>/.open-second-brain/", async () => {
  writeVaultFile("a.md", "# A\n\nhello world");
  const out = await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(existsSync(join(vault, ".open-second-brain", "brain.sqlite"))).toBe(true);
});

test("search status without an index reports 'not initialised' and exits 0", async () => {
  const out = await runCli(["search", "status"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain("not initialised");
});

test("search status --json after an index returns documents count", async () => {
  writeVaultFile("a.md", "# A\n\nbody");
  writeVaultFile("b.md", "# B\n\nbody");
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  const out = await runCli(["search", "status", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  const obj = JSON.parse(out.stdout);
  expect(obj.exists).toBe(true);
  expect(obj.documents).toBe(2);
  expect(obj.schema_version).toBe(2);
});

test("search query returns a human-readable hit for indexed content", async () => {
  writeVaultFile("notes/foo.md", "# Foo\n\nthe quick brown fox jumps over the lazy dog");
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  const out = await runCli(["search", "fox"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain("notes/foo.md");
});

test("search query --json returns structured results", async () => {
  writeVaultFile("notes/foo.md", "# Foo\n\nfox content");
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  const out = await runCli(["search", "fox", "--json", "--limit", "5"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  const obj = JSON.parse(out.stdout);
  expect(Array.isArray(obj.results)).toBe(true);
  expect(obj.results.length).toBeGreaterThan(0);
  expect(obj.results[0].path).toBe("notes/foo.md");
});

test("search query on missing index fails with exit 1", async () => {
  const out = await runCli(["search", "nothing-here"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(1);
  expect(out.stderr).toContain("INDEX_MISSING");
});

test("search check reports vault_readable and sqlite_ok on a fresh vault", async () => {
  const out = await runCli(["search", "check", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  const obj = JSON.parse(out.stdout);
  expect(obj.vault_readable).toBe(true);
  expect(obj.sqlite_ok).toBe(true);
  expect(obj.fts5_ok).toBe(true);
});

test("search reindex rebuilds the index atomically", async () => {
  writeVaultFile("a.md", "# A");
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  writeVaultFile("b.md", "# B");
  const out = await runCli(["search", "reindex"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(existsSync(join(vault, ".open-second-brain", "brain.sqlite"))).toBe(true);
  expect(existsSync(join(vault, ".open-second-brain", "brain.sqlite.bak"))).toBe(true);
});

test("unknown flag exits with code 2", async () => {
  const out = await runCli(["search", "index", "--bogus"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(2);
});

test("invalid numeric search flags exit with code 2 before touching the index", async () => {
  let out = await runCli(["search", "fox", "--keyword-weight", "nan"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(2);
  expect(out.stderr).toContain("search_keyword_weight");

  out = await runCli(["search", "index", "--concurrency", "0"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(2);
  expect(out.stderr).toContain("embedding_concurrency");
});

test("path-prefix escaping returns exit 2 with INVALID_INPUT", async () => {
  writeVaultFile("a.md", "# A");
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  const out = await runCli(["search", "A", "--path", "../etc/"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(2);
  expect(out.stderr).toContain("INVALID_INPUT");
});

test("the default verb is `query` when first positional is unknown", async () => {
  writeVaultFile("a.md", "# A\n\nalpha word");
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  // No explicit verb, just a query token:
  const out = await runCli(["search", "alpha"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain("a.md");
});

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
import { LATEST_SCHEMA_VERSION } from "../../src/core/search/schema.ts";

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
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  const out = await runCli(["search", "status", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  const obj = JSON.parse(out.stdout);
  expect(obj.exists).toBe(true);
  expect(obj.documents).toBe(2);
  expect(obj.schema_version).toBe(LATEST_SCHEMA_VERSION);
});

test("search query returns a human-readable hit for indexed content", async () => {
  writeVaultFile("notes/foo.md", "# Foo\n\nthe quick brown fox jumps over the lazy dog");
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  const out = await runCli(["search", "fox"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain("notes/foo.md");
});

test("search query --json returns structured results", async () => {
  writeVaultFile("notes/foo.md", "# Foo\n\nfox content");
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  const out = await runCli(["search", "fox", "--json", "--limit", "5"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  const obj = JSON.parse(out.stdout);
  expect(Array.isArray(obj.results)).toBe(true);
  expect(obj.results.length).toBeGreaterThan(0);
  expect(obj.results[0].path).toBe("notes/foo.md");
});

test("search query --query-doc accepts structured recall documents", async () => {
  writeVaultFile("notes/final.md", "# Final\n\nrelease notes mention recall diagnostics.");
  writeVaultFile("notes/draft.md", "# Draft\n\ndraft release notes mention recall diagnostics.");
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });

  const out = await runCli(
    ["search", "--query-doc", 'lex: "release notes" -draft', "--json", "--limit", "10"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );

  expect(out.returncode).toBe(0);
  const obj = JSON.parse(out.stdout);
  expect(obj.results.map((r: { path: string }) => r.path)).toContain("notes/final.md");
  expect(obj.results.map((r: { path: string }) => r.path)).not.toContain("notes/draft.md");
  expect(obj.results[0].reasons.some((reason: string) => reason.includes("lane:lex/fts5"))).toBe(
    true,
  );
});

test("search query --evidence-pack returns missing terms and why_retrieved", async () => {
  writeVaultFile("notes/foo.md", "# Foo\n\nalpha beta current support.");
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });

  const out = await runCli(
    ["search", "alpha gamma", "--query-doc", "lex: alpha", "--json", "--evidence-pack"],
    {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    },
  );

  expect(out.returncode).toBe(0);
  const obj = JSON.parse(out.stdout);
  expect(obj.evidence_pack.missing_terms).toContain("gamma");
  expect(Array.isArray(obj.results[0].why_retrieved)).toBe(true);
});

test("search focus set/status/clear steers only the focused query window", async () => {
  writeVaultFile("archive/other.md", "# Other\n\nshared recall topic.");
  writeVaultFile("sessions/focus.md", "# Focus\n\nshared recall topic.");
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });

  const set = await runCli(
    ["search", "focus", "set", "--path", "sessions/", "--ttl-minutes", "60", "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(set.returncode).toBe(0);
  expect(JSON.parse(set.stdout).active).toBe(true);

  const focused = await runCli(["search", "shared", "--json", "--limit", "2"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(focused.returncode).toBe(0);
  const focusedJson = JSON.parse(focused.stdout);
  expect(focusedJson.results[0].path).toBe("sessions/focus.md");
  expect(
    focusedJson.results[0].reasons.some((reason: string) => reason.startsWith("session_focus:")),
  ).toBe(true);

  const clear = await runCli(["search", "focus", "clear", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(clear.returncode).toBe(0);
  expect(JSON.parse(clear.stdout).active).toBe(false);
});

test("search query on a missing index self-heals (builds it) and exits 0", async () => {
  // A query used to fail with INDEX_MISSING; the read path now builds the index
  // on first use so an upgrade never needs a manual `o2b search index`.
  const out = await runCli(["search", "nothing-here"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(existsSync(join(vault, ".open-second-brain", "brain.sqlite"))).toBe(true);
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
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
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
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  const out = await runCli(["search", "A", "--path", "../etc/"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(2);
  expect(out.stderr).toContain("INVALID_INPUT");
});

test("the default verb is `query` when first positional is unknown", async () => {
  writeVaultFile("a.md", "# A\n\nalpha word");
  await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  // No explicit verb, just a query token:
  const out = await runCli(["search", "alpha"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain("a.md");
});

test("search --evidence-pack --json exposes verification fields (union, completeness)", async () => {
  writeVaultFile("alpha-note.md", "# Alpha\n\nthe alpha subsystem owns the export pipeline");
  writeVaultFile("zephyr-note.md", "# Zephyr\n\nthe zephyr daemon owns the import pipeline");
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });

  // Two-pass recall would now recover results for this AND dead end;
  // disable it - this test exercises the zero-result union/completeness
  // verification fields themselves.
  const out = await runCli(["search", "alpha zephyr", "--evidence-pack", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config, OPEN_SECOND_BRAIN_SEARCH_TWO_PASS: "false" },
  });
  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout) as {
    evidence_pack: {
      idf_weighted_coverage: number;
      rare_terms: string[];
      uncovered_rare_terms: string[];
      union_records: Array<{ term: string; path: string }>;
      completeness: { verdict: string; uncovered_but_present_in_corpus: string[] };
    };
  };
  const pack = json.evidence_pack;
  expect(typeof pack.idf_weighted_coverage).toBe("number");
  expect(pack.union_records.map((r) => r.term).toSorted()).toEqual(["alpha", "zephyr"]);
  expect(pack.completeness.verdict).toBe("sparse");
  expect(pack.completeness.uncovered_but_present_in_corpus.toSorted()).toEqual(["alpha", "zephyr"]);
});

test("search query --json surfaces authored_at when present, omits it otherwise", async () => {
  writeVaultFile(
    "Brain/inbox/sig-dated.md",
    "---\nkind: brain-signal\nsource_type: session\nauthored_at: 2026-05-20T10:00:00Z\n---\n\n# Turn\n\nchronology alpha token discussed here.",
  );
  writeVaultFile(
    "Brain/inbox/sig-plain.md",
    "---\nkind: brain-signal\nsource_type: session\n---\n\n# Turn\n\nchronology alpha token discussed here.",
  );
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });

  const out = await runCli(["search", "chronology alpha token", "--json", "--limit", "10"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  const obj = JSON.parse(out.stdout);
  const dated = obj.results.find((r: { path: string }) => r.path === "Brain/inbox/sig-dated.md");
  const plain = obj.results.find((r: { path: string }) => r.path === "Brain/inbox/sig-plain.md");
  expect(dated).toBeDefined();
  expect(plain).toBeDefined();
  expect(dated.authored_at).toBe(Math.floor(Date.parse("2026-05-20T10:00:00Z") / 1000));
  expect("authored_at" in plain).toBe(false);
});

test("search query --verbose prints an authored line only when present", async () => {
  writeVaultFile(
    "Brain/inbox/sig-dated.md",
    "---\nkind: brain-signal\nsource_type: session\nauthored_at: 2026-05-20T10:00:00Z\n---\n\n# Turn\n\nchronology alpha token discussed here.",
  );
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });

  const out = await runCli(["search", "chronology alpha token", "--verbose"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain("authored 2026-05-20T10:00:00.000Z");
});

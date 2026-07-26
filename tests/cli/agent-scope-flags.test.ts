/**
 * CLI `--agent-scope` flags (context-integrity-gates, Unit A).
 *
 * Owner-scope isolation is well covered at the library level, and the
 * MCP `agent_scope` argument has its own regression matrix. The three
 * CLI flags that reach the same rule - `o2b search query`,
 * `o2b search expand` and `o2b brain sgrep` - had none: nothing
 * exercised the argument parsing or the flag-to-`SearchOptions.agentScope`
 * wiring, so the release would have claimed a user-facing capability
 * nobody had run.
 *
 * Every case here proves the flag NARROWS - a scoped invocation must
 * drop another owner's page while an unscoped one keeps it - rather than
 * merely parsing without error.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
const QUERY = "lattice widgets";
const OWNED_A = "notes/owned-a.md";
const OWNED_B = "notes/owned-b.md";
const SHARED = "notes/shared.md";

let tmp: string;
let vault: string;
let configPath: string;

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-agent-scope-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, OWNED_A),
    `---\nowner: ${OWNER_A}\n---\n\n# A\n\n${QUERY} owned by a\n`,
  );
  writeFileSync(
    join(vault, OWNED_B),
    `---\nowner: ${OWNER_B}\n---\n\n# B\n\n${QUERY} owned by b\n`,
  );
  writeFileSync(join(vault, SHARED), `# Shared\n\n${QUERY} shared with everyone\n`);
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: ${OWNER_A}\n`);

  const indexed = await runCli(["search", "index"], { env: env() });
  expect(indexed.returncode).toBe(0);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface QueryJson {
  readonly results: ReadonlyArray<{ readonly path: string; readonly chunk_id: number }>;
}

/** `o2b search query --json`, with whatever extra flags the case needs. */
async function query(extra: ReadonlyArray<string> = []): Promise<QueryJson> {
  const r = await runCli(["search", "query", QUERY, "--json", "--limit", "20", ...extra], {
    env: env(),
  });
  expect(r.returncode).toBe(0);
  return JSON.parse(r.stdout) as QueryJson;
}

async function queryPaths(extra: ReadonlyArray<string> = []): Promise<string[]> {
  return (await query(extra)).results.map((x) => x.path);
}

async function chunkIdFor(path: string): Promise<number> {
  const hit = (await query()).results.find((r) => r.path === path);
  expect(hit).toBeDefined();
  return hit!.chunk_id;
}

// ─── o2b search query ────────────────────────────────────────────────────────

test("`search query --agent-scope` drops another owner's page and keeps the shared one", async () => {
  const unscoped = await queryPaths();
  expect(unscoped).toContain(OWNED_A);
  expect(unscoped).toContain(OWNED_B);

  const scoped = await queryPaths(["--agent-scope", OWNER_A]);
  expect(scoped).not.toContain(OWNED_B);
  expect(scoped).toContain(OWNED_A);
  expect(scoped).toContain(SHARED);
});

test("`search query --agent-scope` reads the same page from the other side", async () => {
  const scoped = await queryPaths(["--agent-scope", OWNER_B]);
  expect(scoped).toContain(OWNED_B);
  expect(scoped).not.toContain(OWNED_A);
});

test("`search query --agent-scope` normalizes the token it was given", async () => {
  // The flag value goes through the same NFC + trim + lower-case
  // normalization as the frontmatter token, so an operator typing the
  // agent name with capitals is not silently isolated from their own
  // pages.
  const scoped = await queryPaths(["--agent-scope", "  Agent-A  "]);
  expect(scoped).toContain(OWNED_A);
  expect(scoped).not.toContain(OWNED_B);
});

test("`search query --agent-scope=` (blank) requests no scope and filters nothing", async () => {
  // Blank is "no scope requested", not "the empty owner": the documented
  // `normalizeAgentScope` contract, shared with every other surface. A
  // blank value that narrowed to nothing would be a far worse surprise.
  const scoped = await queryPaths(["--agent-scope="]);
  expect(scoped).toContain(OWNED_A);
  expect(scoped).toContain(OWNED_B);
});

test("`search query --agent-scope` with no value is a usage error", async () => {
  const r = await runCli(["search", "query", QUERY, "--json", "--agent-scope"], { env: env() });
  expect(r.returncode).toBe(2);
  expect(r.stderr).toContain("--agent-scope requires a value");
});

// ─── o2b search expand ───────────────────────────────────────────────────────

test("`search expand --agent-scope` refuses another owner's chunk indistinguishably", async () => {
  const chunkId = await chunkIdFor(OWNED_B);

  const unscoped = await runCli(["search", "expand", "--chunk", String(chunkId), "--json"], {
    env: env(),
  });
  expect(unscoped.returncode).toBe(0);
  expect(unscoped.stdout).toContain(OWNED_B);

  const scoped = await runCli(
    ["search", "expand", "--chunk", String(chunkId), "--json", "--agent-scope", OWNER_A],
    { env: env() },
  );
  expect(scoped.returncode).toBe(2);
  // Byte-identical to the absent-chunk error: a distinguishable refusal
  // would confirm the chunk exists and belongs to someone else, which is
  // exactly what walking the sequential ids is looking for.
  expect(scoped.stderr).toContain(`chunk not found: ${chunkId}`);
  expect(scoped.stdout).toBe("");
});

test("`search expand --agent-scope` still serves the owner their own chunk", async () => {
  const chunkId = await chunkIdFor(OWNED_A);
  const scoped = await runCli(
    ["search", "expand", "--chunk", String(chunkId), "--json", "--agent-scope", OWNER_A],
    { env: env() },
  );
  expect(scoped.returncode).toBe(0);
  expect(scoped.stdout).toContain(OWNED_A);
});

test("`search expand --agent-scope` leaves a shared chunk reachable", async () => {
  const chunkId = await chunkIdFor(SHARED);
  const scoped = await runCli(
    ["search", "expand", "--chunk", String(chunkId), "--json", "--agent-scope", OWNER_B],
    { env: env() },
  );
  expect(scoped.returncode).toBe(0);
  expect(scoped.stdout).toContain(SHARED);
});

// ─── o2b brain sgrep ─────────────────────────────────────────────────────────

interface SgrepJson {
  readonly results: ReadonlyArray<{ readonly path: string }>;
}

async function sgrepPaths(extra: ReadonlyArray<string> = []): Promise<string[]> {
  const r = await runCli(["brain", "sgrep", QUERY, "--json", "--limit", "20", ...extra], {
    env: env(),
  });
  // Grep-like contract: 0 with matches, 1 without. Either way the JSON
  // body is what the assertion reads.
  expect([0, 1]).toContain(r.returncode);
  return (JSON.parse(r.stdout) as SgrepJson).results.map((x) => x.path);
}

test("`brain sgrep --agent-scope` drops another owner's page and keeps the shared one", async () => {
  const unscoped = await sgrepPaths();
  expect(unscoped).toContain(OWNED_A);
  expect(unscoped).toContain(OWNED_B);

  const scoped = await sgrepPaths(["--agent-scope", OWNER_A]);
  expect(scoped).not.toContain(OWNED_B);
  expect(scoped).toContain(OWNED_A);
  expect(scoped).toContain(SHARED);
});

test("`brain sgrep --agent-scope` with no value is a usage error", async () => {
  const r = await runCli(["brain", "sgrep", QUERY, "--json", "--agent-scope"], { env: env() });
  // 1, not the 2 the `search` group returns: the `brain` dispatcher owns
  // its own CliError catch and has always mapped usage errors to 1. That
  // divergence predates this flag and belongs to the dispatcher, not to
  // `--agent-scope`; pinned here so the flag's behaviour is recorded as
  // it actually is.
  expect(r.returncode).toBe(1);
  expect(r.stderr).toContain("--agent-scope requires a value");
});

/**
 * Terminal states that used to print nothing forward (no-dead-ends,
 * task 5).
 *
 * A verb that exits zero in silence is a dead end for an agent whose
 * whole world is the last command's stdout. This file pins the states
 * this task covered, the two it deliberately did NOT, and the pinned
 * self-heal it must not regress.
 *
 * Every covered state resolves its command through the diagnostics
 * registry and prints it through the advisory rail, so the four
 * hand-written `(run: ...)` parentheticals that used to live inside
 * `ok()` strings are gone: one mechanism, one line format, one place
 * that knows whether stdout is a machine payload.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../src/core/brain/diagnostics.ts";
import { runCli } from "../helpers/run-cli.ts";

const BRAIN_EMPTY_COMMAND = DIAGNOSTIC_SIGNALS.get("brain-empty")!.nextCommand;
const CLUSTERS_ABSENT_COMMAND = DIAGNOSTIC_SIGNALS.get("signal-clusters-absent")!.nextCommand;
const INTENTIONS_ABSENT_COMMAND = DIAGNOSTIC_SIGNALS.get("intentions-absent")!.nextCommand;
const INDEX_BUILT_COMMAND = DIAGNOSTIC_SIGNALS.get("search-index-built")!.nextCommand;
const GIT_HISTORY_COMMAND = DIAGNOSTIC_SIGNALS.get("git-history-absent")!.nextCommand;
const BRIDGE_PROPOSALS_COMMAND = DIAGNOSTIC_SIGNALS.get("bridge-proposals-absent")!.nextCommand;

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-terminal-states-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\nagent_name: test-agent\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Every `next:` line in `stdout`, in order. */
function nextLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("next: "));
}

/**
 * Run one verb under `--json` and assert the payload is uncontaminated.
 * Sequential by construction: the in-process CLI harness swaps
 * `process.stdout.write`, so two concurrent runs would interleave.
 */
async function expectCleanJson(argv: ReadonlyArray<string>): Promise<void> {
  const label = argv.join(" ");
  const r = await runCli(argv, { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  expect(`${label}: ${r.returncode}`).toBe(`${label}: 0`);
  expect(`${label}: ${r.stdout.includes("next: ")}`).toBe(`${label}: false`);
  expect(() => JSON.parse(r.stdout)).not.toThrow();
}

async function brainInit(): Promise<void> {
  await runCli(["init", "--vault", vault, "--name", "Test"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
}

describe("brain init - the command that creates the empty Brain", () => {
  test("names what fills the Brain it just created", async () => {
    await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(["brain", "init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("brain initialized:");
    expect(nextLines(r.stdout)).toEqual([`next: ${BRAIN_EMPTY_COMMAND}`]);
  });

  test("--json stays a clean payload", async () => {
    await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(["brain", "init", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("next: ");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe("search index - the index exists, now what", () => {
  test("a successful index names the read verb", async () => {
    writeFileSync(join(vault, "a.md"), "# A\n\nhello world\n");
    const r = await runCli(["search", "index"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("done in ");
    expect(nextLines(r.stdout)).toEqual([`next: ${INDEX_BUILT_COMMAND}`]);
  });

  test("reindex reaches the same terminal state and says the same thing", async () => {
    writeFileSync(join(vault, "a.md"), "# A\n\nhello world\n");
    const r = await runCli(["search", "reindex"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(nextLines(r.stdout)).toEqual([`next: ${INDEX_BUILT_COMMAND}`]);
  });

  test("--json stays a clean payload", async () => {
    writeFileSync(join(vault, "a.md"), "# A\n\nhello world\n");
    const r = await runCli(["search", "index", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("next: ");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe("empty-state brain verbs", () => {
  test("intent-review with no clusters names the signal writer", async () => {
    await brainInit();
    const r = await runCli(["brain", "intent-review", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no active signal clusters");
    expect(nextLines(r.stdout)).toEqual([`next: ${CLUSTERS_ABSENT_COMMAND}`]);
  });

  test("intention list with no chains names its own setter", async () => {
    await brainInit();
    const r = await runCli(["brain", "intention", "list", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no active intentions");
    expect(nextLines(r.stdout)).toEqual([`next: ${INTENTIONS_ABSENT_COMMAND}`]);
  });

  test("both stay clean under --json", async () => {
    await brainInit();
    await expectCleanJson(["brain", "intent-review", "--vault", vault, "--json"]);
    await expectCleanJson(["brain", "intention", "list", "--vault", vault, "--json"]);
  });
});

describe("the hand-written pointers are gone, not duplicated", () => {
  test("git status with no ingested history routes through the rail", async () => {
    await brainInit();
    const r = await runCli(["brain", "git", "status", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no git history ingested yet");
    // The parenthetical `(run: ...)` was the second mechanism.
    expect(r.stdout).not.toContain("(run:");
    expect(nextLines(r.stdout)).toEqual([`next: ${GIT_HISTORY_COMMAND}`]);
  });

  test("git mine with no ingested history routes through the rail", async () => {
    await brainInit();
    const r = await runCli(["brain", "git", "mine", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("(run:");
    expect(nextLines(r.stdout)).toEqual([`next: ${GIT_HISTORY_COMMAND}`]);
  });

  test("bridges list with no artifact routes through the rail", async () => {
    await brainInit();
    const r = await runCli(["brain", "bridges", "list", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no proposals artifact yet");
    expect(r.stdout).not.toContain("- run:");
    expect(nextLines(r.stdout)).toEqual([`next: ${BRIDGE_PROPOSALS_COMMAND}`]);
  });

  test("git and bridges stay clean under --json", async () => {
    await brainInit();
    await expectCleanJson(["brain", "git", "status", "--vault", vault, "--json"]);
    await expectCleanJson(["brain", "bridges", "list", "--vault", vault, "--json"]);
  });
});

describe("states this task deliberately leaves silent", () => {
  test("an empty approval queue names nothing, because nothing names it", async () => {
    // `Brain/pending/` fills only as a side effect of session capture
    // and session import, and only while the opt-in `write_approval`
    // toggle is on. An empty queue is the healthy steady state, and no
    // single command is its exit - naming one would be the invention
    // this release exists to remove. See the census for the record.
    await brainInit();
    const r = await runCli(["brain", "pending", "list", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe("no pending signals\n");
  });

  test("a query that matched nothing on a healthy index names nothing", async () => {
    // An empty result set is a correct answer to the question asked,
    // not a degraded state. The only forward move is a different query,
    // which the system cannot derive from the one that missed.
    writeFileSync(join(vault, "a.md"), "# A\n\nhello world\n");
    await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
    const r = await runCli(["search", "zzz-no-such-term-zzz"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(nextLines(r.stdout)).toEqual([]);
  });

  test("the self-healing read path is untouched", async () => {
    // Pinned independently by tests/cli/search.test.ts; asserted here
    // too because a "run the indexer" hint would regress a deliberate
    // feature, and this file is where that temptation lives.
    const r = await runCli(["search", "nothing-here"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(nextLines(r.stdout)).toEqual([]);
  });
});

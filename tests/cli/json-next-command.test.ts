/**
 * The machine-readable promise is actually delivered (no-dead-ends,
 * phase 3, item 4).
 *
 * `emitNextStep` returns the resolved step even when it suppresses the
 * line on a machine stream, and `advisory-rail.ts` says why in as many
 * words: "Suppression is not a drop. A suppressed emission still returns
 * the resolved `NextStep`, so a JSON verb carries it as a field in its
 * own payload - which is where it belongs on that stream."
 *
 * No CLI caller used that return value. On every verb below the next step
 * was computed and silently discarded under `--json`, so the agent-facing
 * stream - the one this release exists for - was the only stream that got
 * nothing. Each payload now carries the exit under the shared
 * `NEXT_COMMAND_KEY`, and omits the key entirely where no step resolves.
 *
 * Both halves are asserted per verb. A field that is always present is a
 * different bug from a field that is never present, and only the first
 * one looks like success.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NEXT_COMMAND_KEY, resolveNextStep } from "../../src/core/brain/next-step.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeCaptureNote } from "../../src/core/brain/capture/capture-note.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-json-next-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of ["VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG", "VAULT_AGENT_NAME"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

/** The command a code resolves to, read from the registry, never retyped. */
function commandFor(code: string): string {
  const step = resolveNextStep(code);
  expect(`${code} is registered: ${step !== null}`).toBe(`${code} is registered: true`);
  return step!.nextCommand;
}

/** Parse a `--json` payload and return it, failing loudly if it does not. */
async function payload(argv: ReadonlyArray<string>): Promise<Record<string, unknown>> {
  const r = await runCli([...argv], { env: env() });
  expect(`${argv.join(" ")} exit: ${r.returncode}`).toBe(`${argv.join(" ")} exit: 0`);
  // The advisory line must never reach a stream a caller parses.
  expect(`${argv.join(" ")} has no chrome: ${!r.stdout.includes("next: ")}`).toBe(
    `${argv.join(" ")} has no chrome: true`,
  );
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe("each JSON payload carries the exit its human twin prints", () => {
  test("brain init", async () => {
    const empty = await payload([
      "brain",
      "init",
      "--vault",
      vault,
      "--config",
      configPath,
      "--json",
    ]);
    expect(empty[NEXT_COMMAND_KEY]).toBe(commandFor("brain-empty"));

    writeSignal(vault, {
      topic: "recorded",
      signal: "positive",
      agent: "claude",
      principle: "Recorded.",
      created_at: "2026-05-20T10:00:00Z",
      date: "2026-05-20",
      slug: "recorded-1",
      scope: "writing",
    });
    const full = await payload([
      "brain",
      "init",
      "--vault",
      vault,
      "--config",
      configPath,
      "--json",
    ]);
    expect(full).not.toHaveProperty(NEXT_COMMAND_KEY);
  });

  test("brain bridges list and discover", async () => {
    const list = await payload(["brain", "bridges", "list", "--json"]);
    expect(list[NEXT_COMMAND_KEY]).toBe(commandFor("bridge-proposals-absent"));

    const discover = await payload(["brain", "bridges", "discover", "--json"]);
    expect(discover[NEXT_COMMAND_KEY]).toBe(commandFor("search-index-missing"));
  });

  test("brain clusters list and run", async () => {
    const missing = await payload(["brain", "clusters", "list", "--json"]);
    expect(missing[NEXT_COMMAND_KEY]).toBe(commandFor("cluster-notes-absent"));

    // Same state, other branch: the directory exists but is empty.
    mkdirSync(join(vault, "Brain", "clusters"), { recursive: true });
    const empty = await payload(["brain", "clusters", "list", "--json"]);
    expect(empty[NEXT_COMMAND_KEY]).toBe(commandFor("cluster-notes-absent"));

    const run = await payload(["brain", "clusters", "run", "--json"]);
    expect(run[NEXT_COMMAND_KEY]).toBe(commandFor("search-index-missing"));
  });

  test("brain git status and mine", async () => {
    const status = await payload(["brain", "git", "status", "--json"]);
    expect(status[NEXT_COMMAND_KEY]).toBe(commandFor("git-history-absent"));

    const mine = await payload(["brain", "git", "mine", "--json"]);
    expect(mine[NEXT_COMMAND_KEY]).toBe(commandFor("git-history-absent"));
  });

  test("brain intention list", async () => {
    const empty = await payload(["brain", "intention", "list", "--json"]);
    expect(empty[NEXT_COMMAND_KEY]).toBe(commandFor("intentions-absent"));

    const set = await runCli(
      ["brain", "intention", "set", "--scope", "writing", "--text", "Ship it."],
      { env: env() },
    );
    expect(set.returncode).toBe(0);
    const listed = await payload(["brain", "intention", "list", "--json"]);
    expect(listed).not.toHaveProperty(NEXT_COMMAND_KEY);
  });

  test("brain intent-review", async () => {
    const empty = await payload(["brain", "intent-review", "--json"]);
    expect(empty[NEXT_COMMAND_KEY]).toBe(commandFor("signal-clusters-absent"));
  });

  test("brain inbox-drain", async () => {
    const nothing = await payload(["brain", "inbox-drain", "--json"]);
    expect(nothing).not.toHaveProperty(NEXT_COMMAND_KEY);

    writeCaptureNote(vault, {
      body: "an atomic idea to keep",
      provenance: { source: "telegram", sender: "100", capturedAt: "2026-07-19T12:00:02Z" },
    });
    const staged = await payload(["brain", "inbox-drain", "--json"]);
    expect(staged[NEXT_COMMAND_KEY]).toBe(commandFor("staged-captures-pending"));

    // With --apply the captures are routed, so nothing is pending.
    const applied = await payload(["brain", "inbox-drain", "--apply", "--json"]);
    expect(applied).not.toHaveProperty(NEXT_COMMAND_KEY);
  });

  test("brain dream list", async () => {
    const empty = await payload(["brain", "dream", "list", "--vault", vault, "--json"]);
    expect(empty[NEXT_COMMAND_KEY]).toBe(commandFor("dream-bundles-absent"));
  });

  test("brain tune status", async () => {
    const empty = await payload(["brain", "tune", "status", "--vault", vault, "--json"]);
    expect(empty[NEXT_COMMAND_KEY]).toBe(commandFor("recall-tuning-absent"));
  });

  test("search index and reindex", async () => {
    writeFileSync(join(vault, "good.md"), "---\ntitle: Good\n---\n\nBody text.\n", "utf8");
    const db = join(tmp, "index.db");

    const indexed = await payload(["search", "index", "--vault", vault, "--db", db, "--json"]);
    expect(indexed[NEXT_COMMAND_KEY]).toBe(commandFor("search-index-built"));

    const reindexed = await payload(["search", "reindex", "--vault", vault, "--db", db, "--json"]);
    expect(reindexed[NEXT_COMMAND_KEY]).toBe(commandFor("search-index-built"));

    // A run that could not index every file claims nothing.
    writeFileSync(join(vault, "broken.md"), "---\ntitle: Broken\n\nNo fence.\n", "utf8");
    const broken = await payload(["search", "index", "--vault", vault, "--db", db, "--json"]);
    expect(broken).not.toHaveProperty(NEXT_COMMAND_KEY);
  });

  test("search status", async () => {
    const missing = await payload([
      "search",
      "status",
      "--vault",
      vault,
      "--db",
      join(tmp, "none.db"),
      "--json",
    ]);
    expect(missing[NEXT_COMMAND_KEY]).toBe(commandFor("search-index-missing"));
  });

  test("status", async () => {
    const absent = join(tmp, "__no-such-config__.yaml");
    const missing = await runCli(["status", "--config", absent, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: absent },
    });
    expect(missing.returncode).toBe(0);
    const parsed = JSON.parse(missing.stdout) as Record<string, unknown>;
    expect(parsed[NEXT_COMMAND_KEY]).toBe(commandFor("cli-config-absent"));

    const present = await runCli(["status", "--config", configPath, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(JSON.parse(present.stdout)).not.toHaveProperty(NEXT_COMMAND_KEY);
  });
});

describe("human output is unchanged by the field", () => {
  test("the same states still print exactly one rail line each", async () => {
    const r = await runCli(["brain", "intention", "list"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe(`no active intentions\nnext: ${commandFor("intentions-absent")}\n`);
  });

  test("a state with no exit still prints none", async () => {
    const r = await runCli(["brain", "git", "find", "nothing"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("next: ");
  });
});

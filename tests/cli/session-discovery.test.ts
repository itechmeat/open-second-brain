/**
 * `o2b brain import-session --status | --discover [--all]`.
 *
 * The verb used to accept only an explicit path, so the operator had to
 * already know where five harnesses keep their logs and import them one
 * at a time. These three flags are the machine-wide half: what is here,
 * what has never been imported, and - only when asked twice - importing
 * exactly that gap.
 *
 * The privacy posture is not re-implemented and is not re-tested from
 * first principles here. It is asserted the only way that can stay true:
 * the discovered import and the explicit-path import must leave
 * byte-identical vault output, so redaction and the tool-payload
 * exclusion cannot be relaxed on one path without failing on the other.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { sessionLedgerPath } from "../../src/core/brain/sessions/discover.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let home: string;

interface CoverageRow {
  readonly runtime: string;
  readonly found: number;
  readonly imported: number;
  readonly gap: number;
  readonly unparsable: number;
  readonly roots: ReadonlyArray<{ readonly path: string; readonly present: boolean }>;
}

interface DiscoveryJson {
  readonly found: number;
  readonly imported: number;
  readonly gap: number;
  readonly by_runtime: ReadonlyArray<CoverageRow>;
  readonly would_import?: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<{ readonly file: string }>;
}

function claudeLine(topic: string, uuid: string): string {
  return (
    JSON.stringify({
      parentUuid: null,
      sessionId: "s",
      entrypoint: "sdk-cli",
      type: "user",
      message: {
        role: "user",
        content: `@osb feedback positive topic=${topic} principle="Declare the roots exactly once."`,
      },
      uuid,
      timestamp: "2026-08-16T09:00:00.000Z",
    }) + "\n"
  );
}

function bootstrapVault(at: string): void {
  const dirs = brainDirs(at);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
}

function claudeLog(name: string, topic: string): string {
  const dir = join(home, ".claude", "projects", "-srv-projects-example");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, claudeLine(topic, `u-${topic}`));
  return path;
}

/** Signal files in the inbox, ignoring the `processed/` subdirectory. */
function inboxSignals(at: string): ReadonlyArray<string> {
  return readdirSync(brainDirs(at).inbox)
    .filter((name) => name.endsWith(".md"))
    .toSorted();
}

/** Every inbox signal's bytes, keyed by basename, for a byte-identity claim. */
function inboxBytes(at: string): Record<string, string> {
  const dir = brainDirs(at).inbox;
  const out: Record<string, string> = {};
  for (const name of inboxSignals(at)) out[name] = readFileSync(join(dir, name), "utf8");
  return out;
}

async function run(
  args: string[],
): Promise<{ stdout: string; stderr: string; returncode: number }> {
  return runCli(["brain", "import-session", ...args, "--vault", vault], { env: { HOME: home } });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-session-discovery-"));
  vault = join(tmp, "vault");
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  bootstrapVault(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("--status reports coverage without touching anything", () => {
  test("per runtime it names found, imported and the gap between them", async () => {
    claudeLog("one.jsonl", "alpha");
    claudeLog("two.jsonl", "beta");
    const res = await run(["--status", "--json"]);
    expect(res.returncode).toBe(0);
    const body = JSON.parse(res.stdout) as DiscoveryJson;
    expect(body.found).toBe(2);
    expect(body.imported).toBe(0);
    expect(body.gap).toBe(2);
    const claude = body.by_runtime.find((r) => r.runtime === "claude-code");
    expect({ found: claude?.found, imported: claude?.imported, gap: claude?.gap }).toEqual({
      found: 2,
      imported: 0,
      gap: 2,
    });
    // Where it looked, not only what it found: "found: 0" against an
    // unnamed root is an answer nobody can act on.
    expect(claude?.roots.map((r) => r.path)).toEqual([join(home, ".claude", "projects")]);
    expect(claude?.roots[0]?.present).toBe(true);
  });

  test("it writes no signal and no ledger", async () => {
    claudeLog("one.jsonl", "alpha");
    expect((await run(["--status"])).returncode).toBe(0);
    expect(inboxSignals(vault)).toEqual([]);
    expect(existsSync(sessionLedgerPath(vault))).toBe(false);
  });

  test("the human rendering names every runtime and its three counts", async () => {
    claudeLog("one.jsonl", "alpha");
    const res = await run(["--status"]);
    expect(res.returncode).toBe(0);
    for (const id of ["claude-code", "codex", "cursor", "grok", "opencode"]) {
      expect(`${id} named: ${res.stdout.includes(id)}`).toBe(`${id} named: true`);
    }
    expect(res.stdout).toContain("found: 1");
    expect(res.stdout).toContain("gap: 1");
  });
});

describe("--discover reports what would import and imports nothing", () => {
  test("it lists the gap and leaves the inbox empty", async () => {
    const path = claudeLog("one.jsonl", "alpha");
    const res = await run(["--discover", "--json"]);
    expect(res.returncode).toBe(0);
    const body = JSON.parse(res.stdout) as DiscoveryJson;
    expect(body.would_import).toEqual([path]);
    expect(body.files).toBeUndefined();
    expect(inboxSignals(vault)).toEqual([]);
  });

  test("--discover --all imports the gap and the next status reports it closed", async () => {
    claudeLog("one.jsonl", "alpha");
    const imported = await run(["--discover", "--all", "--json"]);
    expect(imported.returncode).toBe(0);
    const body = JSON.parse(imported.stdout) as DiscoveryJson;
    expect(body.files?.length).toBe(1);
    expect(inboxSignals(vault).length).toBe(1);

    const after = JSON.parse((await run(["--status", "--json"])).stdout) as DiscoveryJson;
    expect(after.found).toBe(1);
    expect(after.imported).toBe(1);
    expect(after.gap).toBe(0);
  });

  test("a second --discover --all imports nothing, because nothing changed", async () => {
    claudeLog("one.jsonl", "alpha");
    expect((await run(["--discover", "--all"])).returncode).toBe(0);
    const before = inboxSignals(vault).length;
    const again = JSON.parse(
      (await run(["--discover", "--all", "--json"])).stdout,
    ) as DiscoveryJson;
    expect(again.files).toEqual([]);
    expect(inboxSignals(vault).length).toBe(before);
  });

  test("an explicit-path import is recorded, so discovery stops offering it", async () => {
    const path = claudeLog("one.jsonl", "alpha");
    expect((await run([path])).returncode).toBe(0);
    const body = JSON.parse((await run(["--status", "--json"])).stdout) as DiscoveryJson;
    expect(body.imported).toBe(1);
    expect(body.gap).toBe(0);
  });

  test("a dry run is not an import, and does not close the gap", async () => {
    const path = claudeLog("one.jsonl", "alpha");
    expect((await run([path, "--dry-run"])).returncode).toBe(0);
    const body = JSON.parse((await run(["--status", "--json"])).stdout) as DiscoveryJson;
    expect(body.gap).toBe(1);
  });
});

describe("the privacy posture is the one importSession already holds", () => {
  test("the discovered import and the explicit-path import write identical bytes", async () => {
    const path = claudeLog("one.jsonl", "alpha");

    const explicit = join(tmp, "explicit-vault");
    bootstrapVault(explicit);
    const direct = await runCli(["brain", "import-session", path, "--vault", explicit], {
      env: { HOME: home },
    });
    expect(direct.returncode).toBe(0);

    expect((await run(["--discover", "--all"])).returncode).toBe(0);
    expect(inboxBytes(vault)).toEqual(inboxBytes(explicit));
  });
});

describe("the refusals name what they refuse", () => {
  // Exit 1, not 2: `o2b brain` maps every `CliError` to 1, and the two
  // exit codes this verb reserves for 2 are the adapter ones
  // (`DETECT_FAIL`, `UNKNOWN_FORMAT`). A usage refusal that exited 2 here
  // would be the only brain verb that did.
  test("a path and --discover cannot both be given", async () => {
    const path = claudeLog("one.jsonl", "alpha");
    const res = await run([path, "--discover"]);
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("--discover");
    expect(res.stderr).toContain(path);
  });

  test("a path and --status cannot both be given", async () => {
    const path = claudeLog("one.jsonl", "alpha");
    const res = await run([path, "--status"]);
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("--status");
  });

  test("--all is refused on its own, naming the flag that gives it meaning", async () => {
    const res = await run(["--all"]);
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("--discover");
  });

  test("--discover and --status together are refused rather than silently ranked", async () => {
    const res = await run(["--discover", "--status"]);
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("--status");
  });

  test("no path and no sweep flag still names the missing argument", async () => {
    const res = await run([]);
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("--discover");
  });
});

describe("the surface is advertised where an operator looks", () => {
  test("the manifest declares every flag the parser accepts", async () => {
    const res = await runCli(["help", "--json"]);
    expect(res.returncode).toBe(0);
    const root = JSON.parse(res.stdout) as {
      commands: Array<{
        name: string;
        commands?: Array<{ name: string; flags?: Array<{ name: string }> }>;
      }>;
    };
    const brain = root.commands.find((c) => c.name === "brain");
    const verb = brain?.commands?.find((c) => c.name === "import-session");
    const declared = (verb?.flags ?? []).map((f) => f.name).toSorted();
    expect(declared).toEqual(
      [
        "agent",
        "all",
        "discover",
        "dry-run",
        "filter-role",
        "filter-text",
        "format",
        "ingest-scope",
        "json",
        "preserve-event-time",
        "progress",
        "recall",
        "recall-session-id",
        "recall-summary-group-size",
        "since",
        "status",
        "vault",
      ].toSorted(),
    );
  });
});

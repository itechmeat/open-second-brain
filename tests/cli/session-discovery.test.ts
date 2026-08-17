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
 * byte-identical vault output - every file, not only the inbox - so
 * redaction and the tool-payload exclusion cannot be relaxed on one path
 * without failing on the other. The one thing subtracted from that
 * comparison is the wall clock, which two CLI runs cannot share; see
 * {@link WALL_CLOCK_STAMP} for why that is a subtraction and not a
 * loosening.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

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

/**
 * A credential in the shape the redactor's `key: value` pass catches, so
 * the byte-identity claim below is about a fixture that actually carries
 * one. The parity test asserted a structural property against a fixture
 * with no secret and no tool call in it, which made its own docstring -
 * "redaction and the tool-payload exclusion cannot be relaxed on one path
 * without failing on the other" - true only by construction.
 */
const FIXTURE_SECRET = "sk-live-9f2ba7c1d4e8";

/** A tool INPUT, which no signal may ever carry: a host path. */
const FIXTURE_TOOL_INPUT = "/etc/shadow";

function claudeLine(topic: string, uuid: string): string {
  return (
    [
      JSON.stringify({
        parentUuid: null,
        sessionId: "s",
        entrypoint: "sdk-cli",
        type: "user",
        message: {
          role: "user",
          content:
            `@osb feedback positive topic=${topic} principle="Declare the roots exactly once. ` +
            `Never paste the token: ${FIXTURE_SECRET} into a prompt."`,
        },
        uuid,
        timestamp: "2026-08-16T09:00:00.000Z",
      }),
      JSON.stringify({
        parentUuid: uuid,
        sessionId: "s",
        entrypoint: "sdk-cli",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "noted" },
            {
              type: "tool_use",
              name: "Read",
              id: `call-${uuid}`,
              input: { path: FIXTURE_TOOL_INPUT },
            },
          ],
        },
        uuid: `a-${uuid}`,
        timestamp: "2026-08-16T09:00:01.000Z",
      }),
    ].join("\n") + "\n"
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

/**
 * EVERY file a run left in a vault, keyed by its path relative to the
 * vault root.
 *
 * The parity claim used to be made over `Brain/inbox/` alone, which is
 * the one place a redactor is most likely to have been applied: the log,
 * the processed store and the ledger were all outside the comparison, and
 * a leak on the discovered path would most plausibly land in the log,
 * which records the transcript that was read. Walking the whole vault
 * costs nothing here and cannot be outgrown by a surface added later.
 */
function vaultTree(at: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(at, full)] = readFileSync(full, "utf8");
    }
  };
  walk(at);
  return out;
}

/**
 * A wall-clock stamp: `2026-08-16T11:31:51Z` in frontmatter and in the
 * log's JSONL, `11:31:51Z` in the log's markdown heading.
 *
 * The two runs being compared are two CLI invocations, so a stamp taken
 * by each can differ by a second - measured at roughly 7% of runs, which
 * made this test flaky. The repair is NOT to loosen the byte comparison:
 * that would trade a real assertion for a vacuous one. Only the clock is
 * neutralised, and only where its VALUE is the whole match, so any other
 * difference - a leaked token, a path, a field one path writes and the
 * other does not - still survives into the comparison and still fails it.
 *
 * The transcript's own event times (`...T09:00:00.000Z`, with
 * milliseconds) are deliberately NOT matched: they come from the fixture,
 * they are identical on both paths by construction, and normalising them
 * would hide a path that lost them.
 */
const WALL_CLOCK_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z|(?<![.\d])\d{2}:\d{2}:\d{2}Z/g;

/**
 * Today in UTC, which is the date both writers stamp: storage timestamps
 * are canonical UTC everywhere and `present-time.ts` converts only at the
 * presentation boundary, so the signal filename and the daily log carry
 * this date and not the fixture's event date.
 *
 * Derived, not pinned. The literal that stood here was the day the test
 * was written, so the assertion held for one day and failed on every day
 * after it - and it failed on the byte-identity test, whose job is to
 * catch a redactor difference between two import paths.
 *
 * Read at the moment of use rather than at module load, which is as tight
 * as this can be closed: the date is stamped by two CLI SUBPROCESSES and
 * nothing here can hand them a clock. A run that straddles 00:00 UTC is
 * already unsound whatever the expectation says - the two runs would
 * stamp two different dates and the byte-identity comparison would fail
 * on the log filename - so the residual window is the two runs' own
 * span, not this file's.
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function withoutWallClock(tree: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(tree)) {
    out[name] = body.replace(WALL_CLOCK_STAMP, "<clock>");
  }
  return out;
}

async function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; returncode: number }> {
  return runCli(["brain", "import-session", ...args, "--vault", vault], {
    env: { HOME: home, ...env },
  });
}

/**
 * The log shard both runs must write into.
 *
 * `appendLogEvent` names its files `<date>.<device-id>.md`, and a device
 * id is generated per config home - which `runCli` isolates per
 * invocation. So two runs otherwise identical land in two DIFFERENTLY
 * NAMED log files, and a comparison over the vault tree would report
 * every log as missing on both sides rather than comparing them. Pinned
 * explicitly rather than relying on the suite preload's `O2B_DEVICE_ID=""`,
 * so what this test compares does not depend on a setting made elsewhere.
 */
const PARITY_DEVICE_ID = "parity-device";

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

describe("the ledger records what happened, and only what happened", () => {
  test("a directory import records the files it imported, not the files it found", async () => {
    // `importSessionPath` collects a per-file failure into `warnings` and
    // carries on, while the verb recorded every `*.jsonl` under the path
    // as imported. So an unrecognised transcript left the ledger at its
    // current bytes and vanished from `--status` and `--discover` - the
    // "silently report everything as imported" direction this surface
    // exists to rule out - and would stay invisible even after a later
    // release shipped an adapter that could read it.
    const dir = join(home, ".claude", "projects", "-srv-projects-example");
    claudeLog("good.jsonl", "alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.jsonl"), JSON.stringify({ not: "a transcript" }) + "\n");

    const res = await run([dir]);
    expect(res.returncode).toBe(0);
    expect(res.stderr + res.stdout).toContain("bad.jsonl");

    const status = JSON.parse((await run(["--status", "--json"])).stdout) as DiscoveryJson;
    expect(status.found).toBe(2);
    expect(status.imported).toBe(1);
    expect(status.gap).toBe(1);

    const ledger = JSON.parse(readFileSync(sessionLedgerPath(vault), "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(ledger.entries)).toEqual([join(dir, "good.jsonl")]);
  });

  test("a ledger failure after a successful import is reported as itself", async () => {
    // The ledger write sat inside the verb's big `try`, ahead of the
    // report. A corrupt ledger therefore printed `import-session failed`,
    // exited 1 and emitted no JSON - for a run whose signal was already on
    // disk and whose log event was already appended.
    const path = claudeLog("one.jsonl", "alpha");
    mkdirSync(dirname(sessionLedgerPath(vault)), { recursive: true });
    writeFileSync(sessionLedgerPath(vault), "{ this is not json", "utf8");

    const res = await run([path, "--json"]);
    expect(res.returncode).toBe(1);
    // The report is emitted, because the import is what it reports on.
    const body = JSON.parse(res.stdout) as DiscoveryJson;
    expect(body.files?.length).toBe(1);
    // And the signal really is there.
    expect(inboxSignals(vault).length).toBe(1);
    // The failure names itself rather than the import.
    expect(res.stderr).toContain("the import completed");
    expect(res.stderr).toContain("ledger");
    expect(res.stderr).not.toContain("import-session failed");
  });

  test("a sweep whose ledger write fails still reports what it imported", async () => {
    // The same defect one function over, and it was not even in a `try`:
    // `--discover --all` imported the gap and then took the whole run's
    // report down with the ledger write. A read-only derived store is the
    // cheapest real cause - the ledger's lock file cannot be created -
    // and stands in for the lock timeout and the read-only vault.
    if (process.getuid?.() === 0) return; // root writes a 0o500 directory anyway
    claudeLog("one.jsonl", "alpha");
    const derived = dirname(sessionLedgerPath(vault));
    mkdirSync(derived, { recursive: true });
    chmodSync(derived, 0o500);
    try {
      const res = await run(["--discover", "--all", "--json"]);
      expect(res.returncode).toBe(1);
      const body = JSON.parse(res.stdout) as DiscoveryJson;
      expect(body.files?.length).toBe(1);
      expect(inboxSignals(vault).length).toBe(1);
      expect(res.stderr).toContain("the import completed");
    } finally {
      chmodSync(derived, 0o700);
    }
  });

  test("an entry whose file has been renamed away is pruned on the next write", async () => {
    // Entries were dropped only when the vanished path was re-submitted,
    // which is the one moment a ledger never hears about a renamed file.
    // So a rotated transcript left a dead key in the ledger forever.
    const first = claudeLog("one.jsonl", "alpha");
    expect((await run([first])).returncode).toBe(0);
    renameSync(first, join(dirname(first), "rotated.jsonl"));

    const second = claudeLog("two.jsonl", "beta");
    expect((await run([second])).returncode).toBe(0);

    const ledger = JSON.parse(readFileSync(sessionLedgerPath(vault), "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(ledger.entries)).toEqual([second]);
  });
});

describe("the privacy posture is the one importSession already holds", () => {
  test("the discovered import and the explicit-path import write identical bytes everywhere but the clock", async () => {
    const path = claudeLog("one.jsonl", "alpha");
    const today = todayUtc();

    const explicit = join(tmp, "explicit-vault");
    bootstrapVault(explicit);
    const direct = await runCli(["brain", "import-session", path, "--vault", explicit], {
      env: { HOME: home, O2B_DEVICE_ID: PARITY_DEVICE_ID },
    });
    expect(direct.returncode).toBe(0);

    expect(
      (await run(["--discover", "--all"], { O2B_DEVICE_ID: PARITY_DEVICE_ID })).returncode,
    ).toBe(0);

    // The floor. Two imports that wrote nothing are byte-identical, and
    // an equality with nothing on either side of it proves nothing about
    // a redactor - so what each run produced is pinned before the two are
    // compared.
    expect(inboxSignals(vault)).toEqual([`sig-${today}-alpha.md`]);
    expect(inboxSignals(explicit)).toEqual(inboxSignals(vault));
    const sweptTree = vaultTree(vault);
    const explicitTree = vaultTree(explicit);
    const namesOf = (tree: Record<string, string>): ReadonlyArray<string> =>
      Object.keys(tree).toSorted();
    expect(namesOf(sweptTree)).toEqual(namesOf(explicitTree));
    // Named rather than counted: each of these is a surface the earlier
    // inbox-only comparison could not see, and the log is where a leak on
    // the discovered path would most plausibly land, because the log is
    // what records the transcript that was read.
    for (const required of [
      `Brain/inbox/sig-${today}-alpha.md`,
      `Brain/log/${today}.${PARITY_DEVICE_ID}.md`,
      `Brain/log/${today}.${PARITY_DEVICE_ID}.jsonl`,
      relative(vault, sessionLedgerPath(vault)),
    ]) {
      expect(`${required} written: ${namesOf(sweptTree).includes(required)}`).toBe(
        `${required} written: true`,
      );
    }

    // The whole vault, byte for byte, with the wall clock - and only the
    // wall clock - neutralised. See WALL_CLOCK_STAMP.
    expect(withoutWallClock(sweptTree)).toEqual(withoutWallClock(explicitTree));

    // And the bytes both paths wrote are bytes the posture actually acted
    // on. Byte-identity between two paths that both leaked would pass just
    // as happily, so the fixture carries a credential and a tool payload
    // and both are checked over everything either path wrote.
    for (const tree of [sweptTree, explicitTree]) {
      const all = Object.values(tree).join("");
      expect(all.length).toBeGreaterThan(0);
      expect(all).not.toContain(FIXTURE_SECRET);
      expect(all).toContain("***REDACTED***");
      expect(all).not.toContain(FIXTURE_TOOL_INPUT);
    }
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

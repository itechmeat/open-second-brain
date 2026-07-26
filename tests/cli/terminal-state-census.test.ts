/**
 * Terminal-state census (no-dead-ends, task 7) - the enforcement
 * artifact for this release.
 *
 * Every `o2b` invocation ends somewhere. This test enumerates those
 * endings FROM THE DISPATCHERS - the switch in `main.ts`, the switch in
 * `brain.ts`, the switch in `search.ts` - and requires each to fall into
 * exactly one of three classes:
 *
 *   names an exit      the reachable code emits a next step through the
 *                      advisory rail;
 *   names a refusal    it can fail by name, with a specific message and
 *                      a non-zero code;
 *   deliberately silent it says nothing forward AND an entry below says
 *                      why that is right.
 *
 * The direction matters. A verb cannot vouch for itself, so the census
 * reads each handler's transitive call graph WITHIN its own module and
 * classifies from what is actually reachable. Adding a verb that can
 * only exit zero in silence fails here, by name, until someone either
 * gives it an exit or writes down why it has none.
 *
 * Modelled on `tests/core/brain/vault-guard-census.test.ts`: detect the
 * property syntactically, keep one explicit inventory of exceptions, one
 * entry one reason, and pin the measurement so a regex that stopped
 * matching cannot report a clean sweep over an empty set.
 *
 * Two limits, stated rather than discovered. Sub-verbs (`brain git
 * ingest`, `search focus clear`) are parsed by each handler from its own
 * positionals and are covered through their parent's call graph, not
 * individually. And a delegating case (`o2b brain`, `o2b search`) takes
 * the classification of everything it can reach, which is the right
 * answer to "can this invocation leave me with nothing".
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI_ROOT = join(REPO_ROOT, "src", "cli");

/** The rail is the only sanctioned way to print a forward pointer. */
const NAMES_EXIT_RE = /emitNextSteps?\(/;

/**
 * A named refusal: the shared failure helpers, a typed CLI error, any
 * thrown error, or a direct write to stderr. All four end in a specific
 * message and a non-zero code; none of them is a silent success.
 */
const NAMES_REFUSAL_RE =
  /\bfail\(|\bfailWith\(|usageError\(|CliError|throw new |process\.stderr\.write\(/;

/** The three classes a terminal state may hold, and only these three. */
const STATE_CLASS = Object.freeze({
  exit: "names-an-exit",
  refusal: "names-a-refusal",
  silent: "deliberately-silent",
} as const);

type StateClass = (typeof STATE_CLASS)[keyof typeof STATE_CLASS];

interface HandClassification {
  readonly cls: StateClass;
  readonly reason: string;
}

/**
 * States the syntactic detector cannot place, each classified by hand
 * with the reason it belongs where it does. An entry may only be here
 * because the detector genuinely cannot see the truth, never because
 * covering the state was inconvenient - the two states this census
 * found and COVERED (`o2b status`, `o2b brain inbox-drain`) are absent
 * from this table for exactly that reason.
 */
const CLASSIFIED_BY_HAND: Readonly<Record<string, HandClassification>> = Object.freeze({
  "o2b onboarding": {
    cls: STATE_CLASS.exit,
    reason:
      "already names a command per unfinished step: `renderOnboardingChecklist` prints " +
      "`run: <command>` beside every incomplete item. The rail carries a SINGLE exit per " +
      "call; routing a whole checklist through it would drop the step-to-command pairing " +
      "that is the entire value of the checklist.",
  },
  "o2b uninstall": {
    cls: STATE_CLASS.exit,
    reason:
      "names its exits inside the rendered plan - the Hermes section lists, verbatim, the " +
      "commands this tool refuses to run on the operator's behalf. They are commands for " +
      "another tool and vary with the installation, so they are not a structural `o2b` " +
      "string the diagnostics registry could hold.",
  },
  "o2b install-cli": {
    cls: STATE_CLASS.refusal,
    reason:
      "refuses per symlink: `renderInstallResult` names each failed outcome and the verb " +
      "returns a non-zero code when any error is present. The refusal does not travel " +
      "through the shared `fail()` helper this census matches on, which is more specific, " +
      "not less.",
  },
  "o2b brain semantics-backfill": {
    cls: STATE_CLASS.silent,
    reason:
      "dry-run only by design - this verb has no apply path, so there is no command to " +
      "name. An empty proposal list means the inverse-edge invariant it previews already " +
      "holds, which is an answer, not a degraded state.",
  },
  "o2b brain mcp-landscape": {
    cls: STATE_CLASS.silent,
    reason:
      "lists the MCP servers declared in runtime configuration files this tool never " +
      "writes. An empty landscape changes by editing another runtime's config, so no " +
      "`o2b` command is its exit and naming one would be an invention.",
  },
  "o2b brain stale": {
    cls: STATE_CLASS.silent,
    reason:
      "is itself the exit other surfaces name: the `stale-notes` registry entry resolves " +
      "to `o2b brain stale`. What to do with a stale entry - pin it, retire it, refresh " +
      "its evidence - is a judgement over content, and naming any one of the three would " +
      "be a guess dressed as an instruction.",
  },
});

/** A reason has to say something; a placeholder cannot reach this. */
const MIN_REASON_LENGTH = 60;

const readSource = (path: string): string => readFileSync(path, "utf8");

function cliFiles(dir: string = CLI_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cliFiles(abs));
    else if (entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/**
 * Top-level function bodies in `text`, keyed by name. A body runs from
 * its declaration to the first line beginning with `}` at column zero,
 * which is where a top-level function closes in this codebase - a brace
 * counter would be fooled by a lone brace inside a string literal.
 */
function topLevelBodies(text: string): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  for (const match of text.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*[(<]/gm)) {
    const rest = text.slice(match.index!);
    const close = rest.search(/\n\}/);
    bodies.set(match[1]!, close === -1 ? rest : rest.slice(0, close + 2));
  }
  return bodies;
}

const MODULE_BODIES: ReadonlyArray<readonly [string, ReadonlyMap<string, string>]> = cliFiles().map(
  (path) => [path, topLevelBodies(readSource(path))] as const,
);

/** The module that declares `fn`, or null when nothing does. */
function moduleDeclaring(fn: string): readonly [string, ReadonlyMap<string, string>] | null {
  return MODULE_BODIES.find(([, bodies]) => bodies.has(fn)) ?? null;
}

/**
 * The source a call to `fn` can actually reach without leaving its own
 * module: its body plus the bodies of every same-module function it
 * calls, transitively. Handlers that fan out to private sub-verbs
 * (`cmdBrainGit` -> `cmdStatus`) are classified by what those sub-verbs
 * do, which is the only reading that matches what a caller experiences.
 */
function reachableSource(bodies: ReadonlyMap<string, string>, fn: string): string {
  const seen = new Set<string>();
  const pending = [fn];
  let source = "";
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const body = bodies.get(name);
    if (body === undefined) continue;
    source += body;
    for (const call of body.matchAll(/\b([A-Za-z0-9_]+)\s*\(/g)) {
      if (bodies.has(call[1]!) && !seen.has(call[1]!)) pending.push(call[1]!);
    }
  }
  return source;
}

interface CensusRow {
  /** `o2b brain doctor` - the invocation an operator types. */
  readonly state: string;
  readonly handler: string;
  readonly module: string;
  /** Null when neither detector matched; such a row owes a hand entry. */
  readonly detected: StateClass | null;
}

/** `case "<verb>": return <handler>(` pairs between `marker` and `default:`. */
function dispatcherCases(file: string, marker: string): ReadonlyArray<readonly [string, string]> {
  const text = readSource(join(CLI_ROOT, file));
  const start = text.indexOf(marker);
  expect(`${file} declares ${marker}: ${start >= 0}`).toBe(`${file} declares ${marker}: true`);
  const end = text.indexOf("default:", start);
  expect(`${file} switch terminates: ${end > start}`).toBe(`${file} switch terminates: true`);
  return [
    ...text
      .slice(start, end)
      .matchAll(/case "([^"]+)":\s*\n\s*return (?:await )?([A-Za-z0-9_]+)\(/g),
  ].map((m) => [m[1]!, m[2]!] as const);
}

const DISPATCHERS: ReadonlyArray<readonly [string, string, string]> = [
  ["o2b", "main.ts", "async function dispatchCommand"],
  ["o2b brain", "brain.ts", "export async function handleBrainSubcommand"],
  ["o2b search", "search.ts", "export async function handleSearchSubcommand"],
];

function census(): ReadonlyArray<CensusRow> {
  const rows: CensusRow[] = [];
  for (const [level, file, marker] of DISPATCHERS) {
    for (const [verb, handler] of dispatcherCases(file, marker)) {
      const declaring = moduleDeclaring(handler);
      // An unresolvable handler is a census failure, not a pass: it means
      // the parse drifted away from the dispatcher it is meant to read.
      expect(`${level} ${verb} handler ${handler} resolves: ${declaring !== null}`).toBe(
        `${level} ${verb} handler ${handler} resolves: true`,
      );
      const [modulePath, bodies] = declaring!;
      const source = reachableSource(bodies, handler);
      rows.push({
        state: `${level} ${verb}`,
        handler,
        module: relative(REPO_ROOT, modulePath).split("\\").join("/"),
        detected: NAMES_EXIT_RE.test(source)
          ? STATE_CLASS.exit
          : NAMES_REFUSAL_RE.test(source)
            ? STATE_CLASS.refusal
            : null,
      });
    }
  }
  return rows;
}

describe("terminal-state census", () => {
  test("every dispatcher case is classified", () => {
    const unclassified = census()
      .filter((row) => row.detected === null && CLASSIFIED_BY_HAND[row.state] === undefined)
      .map((row) => `${row.state} (${row.handler} in ${row.module})`);
    // Named, not counted: the failure message is the work to be done.
    expect(unclassified.toSorted().join("\n")).toBe("");
  });

  test("every state holds exactly one class", () => {
    const rows = census();
    const byState = new Map(rows.map((row) => [row.state, row]));
    for (const row of rows) {
      const hand = CLASSIFIED_BY_HAND[row.state];
      const classes = [row.detected, hand?.cls].filter((c) => c !== undefined && c !== null);
      expect(`${row.state} class count: ${classes.length}`).toBe(`${row.state} class count: 1`);
    }
    // Nothing is counted twice; the dispatcher list is the key set.
    expect(byState.size).toBe(rows.length);
  });

  test("no hand classification outlives the state it explains", () => {
    const states = new Set(census().map((row) => row.state));
    for (const state of Object.keys(CLASSIFIED_BY_HAND)) {
      expect(`${state} is dispatched: ${states.has(state)}`).toBe(`${state} is dispatched: true`);
    }
  });

  test("every hand-written reason is specific, and every class is a real class", () => {
    const known = new Set<string>(Object.values(STATE_CLASS));
    for (const [state, entry] of Object.entries(CLASSIFIED_BY_HAND)) {
      expect(`${state} class is known: ${known.has(entry.cls)}`).toBe(
        `${state} class is known: true`,
      );
      // A placeholder - "todo", "n/a", "see above", "" - cannot pass.
      expect(
        `${state} reason is specific: ${entry.reason.trim().length >= MIN_REASON_LENGTH}`,
      ).toBe(`${state} reason is specific: true`);
      // A reason that only restates the class name explains nothing.
      expect(`${state} reason is not the class name: ${entry.reason.trim() !== entry.cls}`).toBe(
        `${state} reason is not the class name: true`,
      );
    }
  });

  test("the census is not vacuous", () => {
    const rows = census();
    // A parser that stopped matching would sweep an empty set clean.
    expect(rows.length).toBeGreaterThan(160);
    expect(rows.filter((row) => row.detected === STATE_CLASS.exit).length).toBeGreaterThan(8);
    expect(rows.filter((row) => row.detected === STATE_CLASS.refusal).length).toBeGreaterThan(120);
    // And the exception table must stay an exception.
    expect(Object.keys(CLASSIFIED_BY_HAND).length).toBeLessThan(rows.length / 10);
  });

  test("the deliberately-silent class is the smallest of the three", () => {
    // If silence ever became the common answer, this release's thesis
    // would have been abandoned rather than enforced.
    const silent = Object.values(CLASSIFIED_BY_HAND).filter(
      (entry) => entry.cls === STATE_CLASS.silent,
    );
    const rows = census();
    expect(silent.length).toBeLessThan(
      rows.filter((row) => row.detected === STATE_CLASS.exit).length,
    );
  });
});

describe("the two states this census found and covered", () => {
  test("o2b status with no configuration file names the bootstrap command", async () => {
    const missing = join(REPO_ROOT, "tests", "cli", "__no-such-config__.yaml");
    const r = await runCli(["status", "--config", missing], {
      env: { OPEN_SECOND_BRAIN_CONFIG: missing },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("config_exists: false");
    expect(r.stdout).toContain("next: o2b init --vault <path> --name <name>\n");
  });

  test("o2b status with a configuration file present says nothing extra", async () => {
    const config = join(REPO_ROOT, "package.json");
    const r = await runCli(["status", "--config", config], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("next: ");
  });

  test("o2b status --json stays a clean payload", async () => {
    const missing = join(REPO_ROOT, "tests", "cli", "__no-such-config__.yaml");
    const r = await runCli(["status", "--config", missing, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: missing },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("next: ");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

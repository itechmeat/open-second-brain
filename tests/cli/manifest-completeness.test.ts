/**
 * Command-manifest completeness ratchet (no-dead-ends, task 6).
 *
 * `command-manifest.ts` is not documentation. It is the source of the
 * shell completion scripts and of `o2b help --json`, which is how an
 * agent discovers what this CLI can do. A verb the manifest does not
 * model is a verb that does not exist as far as either surface is
 * concerned - a dead end reached by not knowing the road is there.
 *
 * The audit that produced this file found the manifest two top-level
 * verbs, seven `search` subverbs and fifty-five `brain` cases short.
 * Repairing it once fixes today; this ratchet is what stops it drifting
 * again, and the direction of enumeration is the whole point: it reads
 * the DISPATCHERS and asks the manifest to account for each case, never
 * the reverse. A manifest cannot vouch for its own completeness.
 *
 * Scope is one level below each dispatcher - the switch in `main.ts`,
 * the switch in `brain.ts`, and `KNOWN_VERBS` in `search.ts`. Deeper
 * nesting (`brain schema report`, `brain git ingest`) is parsed by each
 * verb from its own positionals, with no shared table to enumerate from,
 * so it is out of this ratchet's reach and stays modelled by hand.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLI_COMMAND_MANIFEST,
  nestedCommandNames,
  type CliCommandManifest,
} from "../../src/cli/command-manifest.ts";
import { renderCompletions } from "../../src/cli/completions.ts";
import { runCli } from "../helpers/run-cli.ts";

const CLI_ROOT = join(import.meta.dir, "..", "..", "src", "cli");

/**
 * Top-level cases with no manifest entry, and why. An entry may only sit
 * here because listing the verb would be WRONG, never because writing
 * its summary was inconvenient.
 */
const TOP_LEVEL_UNLISTED: Readonly<Record<string, string>> = Object.freeze({});

/** `brain` cases with no manifest entry, and why. */
const BRAIN_UNLISTED: Readonly<Record<string, string>> = Object.freeze({});

/** `search` verbs with no manifest entry, and why. */
const SEARCH_UNLISTED: Readonly<Record<string, string>> = Object.freeze({});

/** An exclusion reason has to say something; ten characters is the floor. */
const MIN_REASON_LENGTH = 10;

/** Read `file` under `src/cli/`. */
function cliSource(file: string): string {
  return readFileSync(join(CLI_ROOT, file), "utf8");
}

/**
 * Every `case "<label>":` between `marker` and the switch's `default:`.
 * Bounded on both ends so an unrelated switch elsewhere in the module
 * cannot leak into the census.
 */
function switchCaseLabels(file: string, marker: string): string[] {
  const text = cliSource(file);
  const start = text.indexOf(marker);
  expect(`${file} contains ${marker}: ${start >= 0}`).toBe(`${file} contains ${marker}: true`);
  const end = text.indexOf("default:", start);
  expect(`${file} switch is terminated: ${end > start}`).toBe(`${file} switch is terminated: true`);
  return [...text.slice(start, end).matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
}

/** The `KNOWN_VERBS` set literal in `search.ts`. */
function searchKnownVerbs(): string[] {
  const text = cliSource("search.ts");
  const start = text.indexOf("const KNOWN_VERBS = new Set([");
  expect(`search.ts declares KNOWN_VERBS: ${start >= 0}`).toBe(
    "search.ts declares KNOWN_VERBS: true",
  );
  const end = text.indexOf("]);", start);
  return [...text.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** Paths of every modelled command whose summary says nothing. */
function emptySummaries(
  items: ReadonlyArray<CliCommandManifest>,
  prefix: string,
): ReadonlyArray<string> {
  const found: string[] = [];
  for (const item of items) {
    const path = `${prefix}${item.name}`;
    if (item.summary.trim().length === 0) found.push(path);
    if (item.commands) found.push(...emptySummaries(item.commands, `${path} `));
  }
  return found;
}

interface Level {
  readonly label: string;
  readonly dispatcherVerbs: ReadonlyArray<string>;
  readonly manifestVerbs: ReadonlyArray<string>;
  readonly unlisted: Readonly<Record<string, string>>;
}

function levels(): ReadonlyArray<Level> {
  return [
    {
      label: "o2b",
      dispatcherVerbs: switchCaseLabels("main.ts", "async function dispatchCommand"),
      manifestVerbs: CLI_COMMAND_MANIFEST.commands.map((c) => c.name),
      unlisted: TOP_LEVEL_UNLISTED,
    },
    {
      label: "o2b brain",
      dispatcherVerbs: switchCaseLabels("brain.ts", "export async function handleBrainSubcommand"),
      manifestVerbs: nestedCommandNames("brain"),
      unlisted: BRAIN_UNLISTED,
    },
    {
      label: "o2b search",
      dispatcherVerbs: searchKnownVerbs(),
      manifestVerbs: nestedCommandNames("search"),
      unlisted: SEARCH_UNLISTED,
    },
  ];
}

describe("command manifest completeness", () => {
  test("every dispatcher case is modelled or excluded with a written reason", () => {
    // Every level folds into ONE comparison so the failure message is
    // the complete list of verbs to act on. Asserting per level would
    // stop at the first and hide the rest.
    const unclassified: string[] = [];
    for (const level of levels()) {
      const modelled = new Set(level.manifestVerbs);
      for (const verb of level.dispatcherVerbs) {
        if (modelled.has(verb) || level.unlisted[verb] !== undefined) continue;
        unclassified.push(`${level.label} ${verb}`);
      }
    }
    expect(unclassified.toSorted().join("\n")).toBe("");
  });

  test("no manifest entry outlives the dispatcher case it describes", () => {
    const stale: string[] = [];
    for (const level of levels()) {
      const dispatched = new Set(level.dispatcherVerbs);
      for (const verb of level.manifestVerbs) {
        if (!dispatched.has(verb)) stale.push(`${level.label} ${verb}`);
      }
    }
    expect(stale.toSorted().join("\n")).toBe("");
  });

  test("no exclusion outlives the verb it excuses, and every reason says something", () => {
    for (const level of levels()) {
      const dispatched = new Set(level.dispatcherVerbs);
      for (const [verb, reason] of Object.entries(level.unlisted)) {
        expect(`${level.label} ${verb} is dispatched: ${dispatched.has(verb)}`).toBe(
          `${level.label} ${verb} is dispatched: true`,
        );
        // A placeholder ("todo", "n/a", "") cannot satisfy this.
        expect(
          `${level.label} ${verb} has a reason: ${reason.trim().length >= MIN_REASON_LENGTH}`,
        ).toBe(`${level.label} ${verb} has a reason: true`);
      }
    }
  });

  test("the ratchet is not vacuous", () => {
    // A parser that silently stopped matching would report a clean sweep
    // over an empty set. Pin the measurement, not only its verdict.
    const [top, brain, search] = levels();
    expect(top!.dispatcherVerbs.length).toBeGreaterThan(15);
    expect(brain!.dispatcherVerbs.length).toBeGreaterThan(130);
    expect(search!.dispatcherVerbs.length).toBeGreaterThan(10);
  });

  test("the search dispatcher and its verb gate agree", () => {
    // `KNOWN_VERBS` decides whether the first positional is a verb or a
    // query string; the switch decides what runs. A verb in one and not
    // the other is either unreachable or an unknown-verb error.
    expect(
      switchCaseLabels("search.ts", "export async function handleSearchSubcommand").toSorted(),
    ).toEqual(searchKnownVerbs().toSorted());
  });
});

describe("the repaired manifest reaches its two consumers", () => {
  /** Verbs the audit found missing; a spot check of each level. */
  const REPAIRED = Object.freeze({
    top: ["secrets", "partner"],
    brain: ["pending", "lint", "stale", "today", "obligation"],
    search: ["expand", "focus", "feedback", "weights", "rerank-provider", "rerank-fit", "plan"],
  });

  test("shell completions offer the repaired verbs", () => {
    const bash = renderCompletions("bash", CLI_COMMAND_MANIFEST);
    for (const verb of REPAIRED.top) expect(bash).toContain(verb);
    const zsh = renderCompletions("zsh", CLI_COMMAND_MANIFEST);
    for (const verb of [...REPAIRED.brain, ...REPAIRED.search]) {
      expect(`${verb}: ${zsh.includes(verb)}`).toBe(`${verb}: true`);
    }
  });

  test("help --json carries every dispatcher verb", async () => {
    const r = await runCli(["help", "--json"]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      commands: ReadonlyArray<{ name: string; commands?: ReadonlyArray<{ name: string }> }>;
    };
    const names = new Set(payload.commands.map((c) => c.name));
    for (const verb of REPAIRED.top) {
      expect(`${verb}: ${names.has(verb)}`).toBe(`${verb}: true`);
    }
    const nested = (parent: string): ReadonlySet<string> =>
      new Set((payload.commands.find((c) => c.name === parent)?.commands ?? []).map((c) => c.name));
    const brainNames = nested("brain");
    for (const verb of REPAIRED.brain) {
      expect(`brain ${verb}: ${brainNames.has(verb)}`).toBe(`brain ${verb}: true`);
    }
    const searchNames = nested("search");
    for (const verb of REPAIRED.search) {
      expect(`search ${verb}: ${searchNames.has(verb)}`).toBe(`search ${verb}: true`);
    }
  });

  test("every modelled command carries a non-empty summary", () => {
    // An entry added only to satisfy the ratchet, with an empty summary,
    // would complete the manifest and tell a reader nothing.
    expect(emptySummaries(CLI_COMMAND_MANIFEST.commands, "o2b ").join("\n")).toBe("");
  });
});

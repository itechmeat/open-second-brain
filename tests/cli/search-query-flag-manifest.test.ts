/**
 * The `o2b search` verbs advertise every flag they parse.
 *
 * There is no per-verb `--help` for the search verbs (`o2b search query
 * --help` exits 2 with "unknown flag: --help"), so `o2b help` and `o2b
 * help --json` are the ONLY discovery surface for these flags. The
 * manifest declared none of them, which is worse than a partial list read
 * as complete: an agent parsing `help --json` concluded `search query`
 * takes nothing but `--json`.
 *
 * The same hole was still open one line away on the two index builders,
 * where `reindex` parsed `--cron-template` and `--interval` - the whole
 * cron-recipe surface - with neither reachable from help or completions.
 * So the ratchet is a table: adding a verb to {@link COVERED} is all it
 * takes to hold the next one to the same standard.
 *
 * The direction of enumeration is the point, exactly as in
 * `manifest-completeness.test.ts`: this reads the `parseFlags` schema in
 * the VERB and asks the manifest to account for each key, never the
 * reverse. A manifest cannot vouch for its own completeness.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { nestedCommand } from "../../src/cli/command-manifest.ts";
import { VAULT_FLAGS } from "../../src/cli/search/helpers.ts";

const VERBS_DIR = join(import.meta.dir, "..", "..", "src", "cli", "search", "verbs");

/** One verb held to the ratchet: where it is parsed, and what models it. */
interface CoveredVerb {
  /** Manifest child name under `o2b search`. */
  readonly verb: string;
  /** Source file declaring the `parseFlags` schema. */
  readonly source: string;
  /** Function declaration the schema is read from, so sibling verbs in the
   * same module cannot leak into each other's census. */
  readonly marker: string;
  /** Lower bound on the parsed flag count, so a dead regex cannot pass. */
  readonly minFlags: number;
  /** A flag whose presence in help is the reason this entry exists. */
  readonly witness: readonly [name: string, type: string];
}

const COVERED: ReadonlyArray<CoveredVerb> = Object.freeze([
  {
    verb: "query",
    source: "query.ts",
    marker: "export async function cmdSearchQuery",
    minFlags: 20,
    witness: ["explain", "boolean"],
  },
  {
    verb: "index",
    source: "indexing.ts",
    marker: "export async function cmdSearchIndex",
    minFlags: 8,
    witness: ["force", "boolean"],
  },
  {
    verb: "reindex",
    source: "indexing.ts",
    marker: "export async function cmdSearchReindex",
    minFlags: 9,
    witness: ["cron-template", "boolean"],
  },
  {
    // Added with the probe's exit codes (wiring-what-exists, E1): the
    // verb had just gained a flag that decides whether it makes a network
    // call, on a surface where an undeclared flag is an unreachable one.
    verb: "check",
    source: "check.ts",
    marker: "export async function cmdSearchCheck",
    minFlags: 5,
    witness: ["no-probe", "boolean"],
  },
  {
    // Added with `--progress` (nothing-runs-unwatched, U1): this verb
    // grew the whole progress spine in core - an options field, a
    // counter, a terminator - with no flag to reach it, so the wiring
    // was unreachable from every surface an operator has. The flag is
    // the reach, and an undeclared flag on this family is no reach at all.
    verb: "vector-backfill",
    source: "vector-backfill.ts",
    marker: "export async function cmdSearchVectorBackfill",
    minFlags: 6,
    witness: ["progress", "boolean"],
  },
]);

/**
 * The inherited flag the manifest states once in the help header instead
 * of repeating on every entry; parity is asserted over declared flags.
 */
const INHERITED_FLAG_NAME = "json";

/** `<name>: { type: "<type>"` — one entry of a `parseFlags` schema literal. */
const SCHEMA_ENTRY_RE = /(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*\{\s*type:\s*"([^"]+)"/g;

/** The spread that pulls in the shared vault-addressing triple. */
const VAULT_SPREAD = "...VAULT_FLAGS";

/**
 * The `parseFlags(argv, { ... })` schema the named function declares, as
 * `name -> type`, with `...VAULT_FLAGS` resolved from the real constant.
 */
function parsedFlagSchema(entry: CoveredVerb): ReadonlyMap<string, string> {
  const text = readFileSync(join(VERBS_DIR, entry.source), "utf8");
  const fn = text.indexOf(entry.marker);
  expect(`${entry.source} declares ${entry.marker}: ${fn >= 0}`).toBe(
    `${entry.source} declares ${entry.marker}: true`,
  );
  const start = text.indexOf("parseFlags(argv, {", fn);
  expect(`${entry.verb} calls parseFlags: ${start >= 0}`).toBe(
    `${entry.verb} calls parseFlags: true`,
  );
  const end = text.indexOf("});", start);
  expect(`the ${entry.verb} parseFlags call is terminated: ${end > start}`).toBe(
    `the ${entry.verb} parseFlags call is terminated: true`,
  );
  const literal = text.slice(start, end);

  const out = new Map<string, string>();
  if (literal.includes(VAULT_SPREAD)) {
    for (const [name, spec] of Object.entries(VAULT_FLAGS)) {
      out.set(name, (spec as { type: string }).type);
    }
  }
  for (const match of literal.matchAll(SCHEMA_ENTRY_RE)) {
    out.set(match[1] ?? match[2]!, match[3]!);
  }
  return out;
}

/** The manifest's declared flags for one `o2b search` verb, as `name -> type`. */
function manifestFlagSchema(verb: string): ReadonlyMap<string, string> {
  const entry = nestedCommand("search", verb);
  expect(`the manifest models search ${verb}: ${entry !== undefined}`).toBe(
    `the manifest models search ${verb}: true`,
  );
  return new Map((entry!.flags ?? []).map((f) => [f.name, f.type]));
}

/** Both sides minus the inherited flag the header already states. */
function comparable(schema: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const out = new Map(schema);
  out.delete(INHERITED_FLAG_NAME);
  return out;
}

/** Every disagreement between one verb's parse and its manifest entry. */
function mismatches(
  parsed: ReadonlyMap<string, string>,
  modelled: ReadonlyMap<string, string>,
  label: string,
): string[] {
  const problems: string[] = [];
  for (const [name, type] of parsed) {
    const declared = modelled.get(name);
    if (declared === undefined) problems.push(`${label} --${name} is parsed but not modelled`);
    else if (declared !== type) {
      problems.push(`${label} --${name} is modelled as ${declared} but parsed as ${type}`);
    }
  }
  return problems;
}

describe("the search verbs declare the flags they parse", () => {
  test("every parsed flag is modelled by the manifest, with the same type", () => {
    // Every verb folds into ONE comparison so the failure message is the
    // complete list of work to be done.
    const problems: string[] = [];
    for (const entry of COVERED) {
      problems.push(
        ...mismatches(
          comparable(parsedFlagSchema(entry)),
          comparable(manifestFlagSchema(entry.verb)),
          entry.verb,
        ),
      );
    }
    expect(problems.toSorted().join("\n")).toBe("");
  });

  test("no modelled flag outlives the parse that would accept it", () => {
    const stale: string[] = [];
    for (const entry of COVERED) {
      const parsed = comparable(parsedFlagSchema(entry));
      for (const name of comparable(manifestFlagSchema(entry.verb)).keys()) {
        if (!parsed.has(name)) stale.push(`${entry.verb} --${name}`);
      }
    }
    expect(stale.toSorted().join("\n")).toBe("");
  });

  test("each verb's witness flag is reachable from help", () => {
    for (const entry of COVERED) {
      const [name] = entry.witness;
      const modelled = manifestFlagSchema(entry.verb);
      expect(`search ${entry.verb} --${name}: ${modelled.has(name)}`).toBe(
        `search ${entry.verb} --${name}: true`,
      );
    }
  });

  test("the ratchet is not vacuous and can fail", () => {
    // Pin the measurement, not only its verdict: a regex that stopped
    // matching would report a clean sweep over an empty set.
    for (const entry of COVERED) {
      const parsed = comparable(parsedFlagSchema(entry));
      expect(`${entry.verb} parsed count above floor: ${parsed.size >= entry.minFlags}`).toBe(
        `${entry.verb} parsed count above floor: true`,
      );
      expect(parsed.get(entry.witness[0])).toBe(entry.witness[1]);
      expect(parsed.get("vault")).toBe("string");
    }

    // Prove the comparison catches a violation: a verb schema carrying a
    // flag the manifest never heard of, and one whose type disagrees.
    const violating = new Map(comparable(parsedFlagSchema(COVERED[0]!)));
    violating.set("undeclared-flag", "boolean");
    violating.set("limit", "boolean");
    expect(
      mismatches(violating, comparable(manifestFlagSchema("query")), "query").toSorted(),
    ).toEqual([
      "query --limit is modelled as string but parsed as boolean",
      "query --undeclared-flag is parsed but not modelled",
    ]);
  });
});

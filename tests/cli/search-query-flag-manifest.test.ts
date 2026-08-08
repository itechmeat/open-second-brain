/**
 * `o2b search query` advertises every flag it parses.
 *
 * There is no per-verb `--help` for the search verbs (`o2b search query
 * --help` exits 2 with "unknown flag: --help"), so `o2b help` and `o2b
 * help --json` are the ONLY discovery surface for this verb's flags. The
 * manifest declared none of them, which is worse than a partial list read
 * as complete: an agent parsing `help --json` concluded `search query`
 * takes nothing but `--json`.
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

const QUERY_VERB_SOURCE = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "cli",
  "search",
  "verbs",
  "query.ts",
);

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
 * The `parseFlags(argv, { ... })` schema `query.ts` declares, as
 * `name -> type`, with `...VAULT_FLAGS` resolved from the real constant.
 */
function parsedFlagSchema(): ReadonlyMap<string, string> {
  const text = readFileSync(QUERY_VERB_SOURCE, "utf8");
  const start = text.indexOf("parseFlags(argv, {");
  expect(`query.ts calls parseFlags: ${start >= 0}`).toBe("query.ts calls parseFlags: true");
  const end = text.indexOf("});", start);
  expect(`the parseFlags call is terminated: ${end > start}`).toBe(
    "the parseFlags call is terminated: true",
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

/** The manifest's declared flags for `o2b search query`, as `name -> type`. */
function manifestFlagSchema(): ReadonlyMap<string, string> {
  const entry = nestedCommand("search", "query");
  expect(`the manifest models search query: ${entry !== undefined}`).toBe(
    "the manifest models search query: true",
  );
  return new Map((entry!.flags ?? []).map((f) => [f.name, f.type]));
}

/** Both sides minus the inherited flag the header already states. */
function comparable(schema: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const out = new Map(schema);
  out.delete(INHERITED_FLAG_NAME);
  return out;
}

describe("o2b search query declares the flags it parses", () => {
  test("every parsed flag is modelled by the manifest, with the same type", () => {
    const parsed = comparable(parsedFlagSchema());
    const modelled = comparable(manifestFlagSchema());
    // Named, not counted: the failure message is the work to be done.
    const problems: string[] = [];
    for (const [name, type] of parsed) {
      const declared = modelled.get(name);
      if (declared === undefined) problems.push(`--${name} is parsed but not modelled`);
      else if (declared !== type) {
        problems.push(`--${name} is modelled as ${declared} but parsed as ${type}`);
      }
    }
    expect(problems.toSorted().join("\n")).toBe("");
  });

  test("no modelled flag outlives the parse that would accept it", () => {
    const parsed = comparable(parsedFlagSchema());
    const modelled = comparable(manifestFlagSchema());
    const stale = [...modelled.keys()].filter((name) => !parsed.has(name));
    expect(stale.toSorted().join("\n")).toBe("");
  });

  test("the flag the trust receipts arrived with is reachable from help", () => {
    // `--explain` is the branch's new flag and the reason this file exists.
    expect([...manifestFlagSchema().keys()]).toContain("explain");
  });

  test("the ratchet is not vacuous and can fail", () => {
    // Pin the measurement, not only its verdict: a regex that stopped
    // matching would report a clean sweep over an empty set.
    const parsed = comparable(parsedFlagSchema());
    expect(parsed.size).toBeGreaterThan(20);
    expect(parsed.get("explain")).toBe("boolean");
    expect(parsed.get("vault")).toBe("string");

    // Prove the comparison catches a violation: a verb schema carrying a
    // flag the manifest never heard of, and one whose type disagrees.
    const violating = new Map(parsed);
    violating.set("undeclared-flag", "boolean");
    violating.set("limit", "boolean");
    const modelled = comparable(manifestFlagSchema());
    const problems: string[] = [];
    for (const [name, type] of violating) {
      const declared = modelled.get(name);
      if (declared === undefined) problems.push(`--${name} is parsed but not modelled`);
      else if (declared !== type) {
        problems.push(`--${name} is modelled as ${declared} but parsed as ${type}`);
      }
    }
    expect(problems.toSorted()).toEqual([
      "--limit is modelled as string but parsed as boolean",
      "--undeclared-flag is parsed but not modelled",
    ]);
  });
});

/**
 * The search CLI flag table derives from the search-options descriptor
 * (t_50c81d5c, Task E3): `o2b search "<query>"` no longer hand-lists its
 * flags - the table is projected from the descriptor's cli-visible rows,
 * so a flag cannot appear on one surface and vanish from the other.
 *
 * `LEGACY_QUERY_FLAGS` below is the literal table that lived in
 * `src/cli/search/verbs/query.ts` before the derivation, pasted verbatim
 * (frozen baseline, the `LEGACY_SEARCH_INPUT_SCHEMA` pattern): the
 * derived table must accept EXACTLY these flags with EXACTLY these
 * parse kinds, so every operator script keeps working unchanged. The
 * per-surface edges are pinned too: the CLI keeps `SEARCH_LIMIT_MAX`
 * bound at the read site (not here), the query stays uncapped, and the
 * `semantic` tri-state asymmetry stays a verb-body concern.
 *
 * The reverse direction holds the descriptor to its story: every
 * cli-visible row is in the table under its declared flag spelling and
 * parse kind, and nothing outside the cli rows is (the verb-local flags
 * `json` / `verbose` / `auto-refresh` and the vault triple stay local by
 * design).
 */

import { describe, expect, test } from "bun:test";

import { CliError, parseFlags } from "../../src/cli/argparse.ts";
import { SEARCH_QUERY_FLAGS } from "../../src/cli/search/verbs/query.ts";
import { SEARCH_OPTION_ROWS } from "../../src/core/search/search-options-descriptor.ts";

/**
 * The pre-derivation literal, frozen. The derived portion of
 * {@link SEARCH_QUERY_FLAGS} must equal the non-verb-local slice of this
 * object, and the full table must equal the vault triple plus that slice
 * plus the verb-local flags.
 */
const LEGACY_QUERY_FLAGS: Record<string, { type: string; default?: string }> = {
  vault: { type: "string" },
  config: { type: "string" },
  db: { type: "string" },
  limit: { type: "string", default: "10" },
  semantic: { type: "boolean" },
  "keyword-only": { type: "boolean" },
  "match-mode": { type: "string" },
  kind: { type: "string" },
  path: { type: "string" },
  "keyword-weight": { type: "string" },
  "semantic-weight": { type: "string" },
  "auto-refresh": { type: "boolean" },
  property: { type: "string-array" },
  degree: { type: "string-array" },
  visibility: { type: "string-array" },
  "agent-scope": { type: "string" },
  "query-doc": { type: "string" },
  expand: { type: "boolean" },
  disclosure: { type: "string" },
  profile: { type: "string" },
  "evidence-pack": { type: "boolean" },
  "include-superseded": { type: "boolean" },
  since: { type: "string" },
  until: { type: "string" },
  global: { type: "boolean" },
  "no-record-access": { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  explain: { type: "boolean" },
};

/** The verb-local flags that stay spelled in the verb, by design. */
const VERB_LOCAL = ["auto-refresh", "json", "verbose"] as const;

describe("the derived search CLI flag table (t_50c81d5c E3)", () => {
  test("accepts exactly the flags the literal table accepted, with the same kinds", () => {
    expect(Object.keys(SEARCH_QUERY_FLAGS).toSorted()).toEqual(
      Object.keys(LEGACY_QUERY_FLAGS).toSorted(),
    );
    for (const [name, spec] of Object.entries(LEGACY_QUERY_FLAGS)) {
      expect(`${name}: ${JSON.stringify(SEARCH_QUERY_FLAGS[name])}`).toBe(
        `${name}: ${JSON.stringify(spec)}`,
      );
    }
  });

  test("every cli-visible descriptor row is in the table under its declared spelling", () => {
    const cliRows = SEARCH_OPTION_ROWS.filter(
      (row) => row.surfaces.includes("cli") && row.cliFlag !== null,
    );
    expect(cliRows.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const row of cliRows) {
      const spec = SEARCH_QUERY_FLAGS[row.cliFlag!];
      if (spec === undefined) {
        missing.push(row.name);
        continue;
      }
      expect(spec.type).toBe(row.cliKind);
    }
    expect(missing).toEqual([]);
  });

  test("no mcp-only row leaked into the CLI table", () => {
    const leaked: string[] = [];
    for (const row of SEARCH_OPTION_ROWS) {
      if (row.surfaces.includes("cli") || row.cliFlag === null) continue;
      if (row.cliFlag in SEARCH_QUERY_FLAGS) leaked.push(row.name);
    }
    expect(leaked).toEqual([]);
  });

  test("the verb-local flags stay verb-local, never descriptor-derived", () => {
    const cliFlagNames = new Set(
      SEARCH_OPTION_ROWS.filter((row) => row.cliFlag !== null).map((row) => row.cliFlag!),
    );
    for (const name of VERB_LOCAL) {
      expect(`${name} in the table: ${name in SEARCH_QUERY_FLAGS}`).toBe(
        `${name} in the table: true`,
      );
      expect(`${name} descriptor-derived: ${cliFlagNames.has(name)}`).toBe(
        `${name} descriptor-derived: false`,
      );
    }
  });

  test("the table parses the argv shapes the verb needs", () => {
    // Booleans parse bare; strings take a value; string-arrays repeat.
    const parsed = parseFlags(
      [
        "alpha query",
        "--limit",
        "5",
        "--semantic",
        "--match-mode",
        "any",
        "--path",
        "Brain/notes",
        "--property",
        "status=draft",
        "--property",
        "topic=tabs",
        "--degree",
        "backlinks=0",
        "--query-doc",
        "intent: exact",
        "--no-record-access",
        "--json",
      ],
      SEARCH_QUERY_FLAGS,
    );
    expect(parsed.positional).toEqual(["alpha query"]);
    expect(parsed.flags["limit"]).toBe("5");
    expect(parsed.flags["semantic"]).toBe(true);
    expect(parsed.flags["match-mode"]).toBe("any");
    expect(parsed.flags["path"]).toBe("Brain/notes");
    expect(parsed.flags["property"]).toEqual(["status=draft", "topic=tabs"]);
    expect(parsed.flags["degree"]).toEqual(["backlinks=0"]);
    expect(parsed.flags["query-doc"]).toBe("intent: exact");
    expect(parsed.flags["no-record-access"]).toBe(true);
    expect(parsed.flags["json"]).toBe(true);
    // The limit default survives the derivation.
    const defaulted = parseFlags(["query"], SEARCH_QUERY_FLAGS);
    expect(defaulted.flags["limit"]).toBe("10");
  });

  test("the table still refuses what the literal table refused", () => {
    // Unknown flags throw...
    expect(() => parseFlags(["q", "--definitely-not-a-flag"], SEARCH_QUERY_FLAGS)).toThrow(
      CliError,
    );
    // ...booleans refuse values...
    expect(() => parseFlags(["q", "--semantic=true"], SEARCH_QUERY_FLAGS)).toThrow(CliError);
    // ...and value-taking flags refuse to dangle.
    expect(() => parseFlags(["q", "--limit"], SEARCH_QUERY_FLAGS)).toThrow(CliError);
  });
});

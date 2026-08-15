/**
 * Registry R2 - every path that writes vault content to a destination
 * outside the vault, measured rather than described.
 *
 * ## The defect
 *
 * `src/core/redactor.ts` is a mature structural redactor: credential
 * field identifiers across three assignment shapes, vendor key prefixes,
 * a pure character-class entropy detector, `<private>` region stripping,
 * and a fail-closed scan window. Eighteen modules import it. Before this
 * unit, FIVE of the six paths that hand vault bytes to a destination the
 * operator names never called it - `bank-export`, `graph-export`,
 * `okf-export`, `brain export`, and `export-config`, the last of which
 * used a private key-name-only copy that never inspected a value. A note
 * carrying a pasted API key left the machine byte for byte.
 *
 * Wiring five call sites fixes five call sites. What makes the sixth
 * impossible is a declared registry plus this census, the idiom this
 * repository already runs for raw `fs` write sites
 * (`write-site-census.test.ts`) and doctor exit codes
 * (`doctor-exit-census.test.ts`).
 *
 * ## The population, defined structurally
 *
 * Two rules, because one name means two different things depending on
 * what the module does with it.
 *
 * 1. UNAMBIGUOUS: the module declares a string parameter whose name is
 *    one of {@link DESTINATION_FLAGS} (`out`, `outdir`, `dest`, …). Those
 *    names name a destination and nothing else, so the declaration alone
 *    puts the module in population. The rule deliberately does NOT
 *    require the module to call `fs` itself: `okf-export` delegates its
 *    writes to `writeOkfBundle`, and a rule keyed on the write call would
 *    have missed the widest directory export in the tree.
 *
 * 2. AMBIGUOUS NAME PLUS A WRITE: `--file`, `--path`, `--to`, `--report`
 *    are destinations in a writer and inputs in a reader - `brain facts
 *    --file` reads one. Admitting the name alone would drag fourteen
 *    read-only modules in and make the registry a list of every verb that
 *    takes a path; ignoring it left the reviewer's synthetic `--file`
 *    export invisible. So an ambiguous name counts when the SAME module
 *    also puts bytes on disk ({@link RAW_WRITE_RE}). This rule is what
 *    reaches the MCP surface at all: an MCP tool declares its destination
 *    as an `inputSchema` property, not a flag spec, and the property has
 *    the same `name: { type: "string" }` shape.
 *
 * Rule 2 adds no module today, which is the point - it is a tripwire, not
 * a backlog.
 *
 * ## What it does not cover, stated rather than implied
 *
 * - A destination taken as a POSITIONAL argument, or a flag spec built
 *   dynamically instead of written as an object literal.
 * - A module that declares an ambiguous destination and DELEGATES the
 *   write to another module: rule 1 covers delegation only for the
 *   unambiguous names, and rule 2 needs the write in the same file. An
 *   MCP tool that handed `args.path` to a core helper that writes is the
 *   live shape of this gap.
 * - A plain helper with no parameter DECLARATION at all -
 *   `spillVault(destination, contents)`. Both rules read declared
 *   parameter specs; a function signature is not one. Nothing keys this
 *   census on `fs` reachability, because in-vault writers are what
 *   `write-site-census.test.ts` already measures and merging the two
 *   would make both unreadable.
 * - `process.stdout`. Every CLI verb writes there, so including it would
 *   make the population the whole CLI.
 * - Per-WRITE coverage. The guard is asserted per declared DESTINATION
 *   ({@link "every declared destination in a redacting module is matched
 *   by a guard call"}), which catches a new unguarded verb appended to an
 *   already-declared module - the hole the reviewer walked through by
 *   adding one to `src/cli/main.ts` - but two writes behind one
 *   declaration and one guard call still pass as a pair.
 *
 * {@link INTRUDER_SHAPES} is where a new source shape gets added the day
 * it appears.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EGRESS_REDACTION,
  EGRESS_SITES,
  type EgressSite,
} from "../../../src/core/egress/registry.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Flag names that name a destination the operator chose. `target` is
 * deliberately absent: `o2b install --target` names an ADAPTER, not a
 * path, and admitting it would put a name-selector in a destination
 * census.
 */
const DESTINATION_FLAGS: ReadonlyArray<string> = Object.freeze([
  "out",
  "output",
  "outfile",
  "outdir",
  "out-dir",
  "dest",
  "destination",
]);

/**
 * Names that MIGHT be a destination. `--file` is a destination in a
 * writer and an input in a reader (`brain facts --file` reads one), so
 * these count only alongside a write in the same module. `path` is here
 * rather than in {@link DESTINATION_FLAGS} for the same reason, and it is
 * also how an MCP `inputSchema` property reaches this census at all.
 */
const AMBIGUOUS_DESTINATION_NAMES: ReadonlyArray<string> = Object.freeze([
  "file",
  "path",
  "to",
  "report",
]);

/**
 * A parameter spec entry: `out: { type: "string" }`, optionally quoted,
 * with or without further properties - the same shape in a CLI flag spec
 * and in an MCP `inputSchema` property. The leading class rejects a
 * longer identifier ending in one of the names (`about:`, `stdout:`).
 */
function namedStringParamRe(names: ReadonlyArray<string>, flags: string): RegExp {
  return new RegExp(
    String.raw`(^|[^A-Za-z0-9_$"'\-])"?(${names.join("|")})"?\s*:\s*\{\s*type\s*:\s*"string"`,
    flags,
  );
}

const DESTINATION_FLAG_RE = namedStringParamRe(DESTINATION_FLAGS, "m");
const AMBIGUOUS_DESTINATION_RE = namedStringParamRe(AMBIGUOUS_DESTINATION_NAMES, "m");
const ANY_DESTINATION_G_RE = namedStringParamRe(
  [...DESTINATION_FLAGS, ...AMBIGUOUS_DESTINATION_NAMES],
  "gm",
);

/**
 * A call that puts file bytes on disk. Only what a CLI verb or an MCP
 * tool would reach for directly; the in-vault write surface is
 * `write-site-census.test.ts`'s subject, not this one's.
 */
const RAW_WRITE_RE =
  /\b(?:writeFileSync|appendFileSync|copyFileSync|cpSync|createWriteStream|atomicWriteFileSync|writeFile)\s*\(|\bBun\.write\s*\(/;

/** The shared egress guard. A module that calls it redacts on the way out. */
const EGRESS_GUARD_CALL_RE = /\bredactForEgress\s*\(/;
const EGRESS_GUARD_CALL_G_RE = /\bredactForEgress\s*\(/g;

/** Every `.ts` file under `src/`, as repo-relative POSIX path + text. */
function readSourceTree(): ReadonlyArray<{ path: string; text: string }> {
  const glob = new Bun.Glob("src/**/*.ts");
  const files: { path: string; text: string }[] = [];
  for (const rel of glob.scanSync({ cwd: REPO_ROOT })) {
    const path = rel.split("\\").join("/");
    files.push({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * True when this module declares an operator-named output destination:
 * an unambiguous destination name, or an ambiguous one in a module that
 * also writes bytes. See the two rules in the docblock.
 */
function declaresDestination(text: string): boolean {
  if (DESTINATION_FLAG_RE.test(text)) return true;
  return AMBIGUOUS_DESTINATION_RE.test(text) && RAW_WRITE_RE.test(text);
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

const SOURCE_TREE = readSourceTree();
const POPULATION: ReadonlyArray<string> = SOURCE_TREE.filter((f) =>
  declaresDestination(f.text),
).map((f) => f.path);

const ENTRIES: ReadonlyArray<EgressSite> = Object.values(EGRESS_SITES);
const DECLARED_MODULES: ReadonlySet<string> = new Set(ENTRIES.map((e) => e.module));

function moduleText(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("egress site census", () => {
  test("every module that names an output destination is declared", () => {
    // Named, not counted: the failure has to say which file.
    const unlisted = POPULATION.filter((path) => !DECLARED_MODULES.has(path));
    expect(unlisted).toEqual([]);
  });

  test("no declaration outlives the module it describes", () => {
    const stale = ENTRIES.filter(
      (entry) => !existsSync(join(REPO_ROOT, entry.module)) || !POPULATION.includes(entry.module),
    ).map((entry) => `${entry.id} -> ${entry.module}`);
    expect(stale).toEqual([]);
  });

  test("every entry declared as redacting actually calls the shared guard", () => {
    // The declaration is checked against the source, not trusted. A verb
    // that stops calling the guard fails here even though its registry
    // entry still claims coverage - which is the exact lie this census
    // exists to make impossible.
    const missing = ENTRIES.filter(
      (entry) =>
        entry.redaction === EGRESS_REDACTION.sharedRedactor &&
        !EGRESS_GUARD_CALL_RE.test(moduleText(entry.module)),
    ).map((entry) => entry.id);
    expect(missing).toEqual([]);
  });

  test("every declared destination in a redacting module is matched by a guard call", () => {
    // Presence of ONE guard call is not coverage of the module. A new
    // verb appended to `src/cli/main.ts` - the CLI dispatcher, the
    // natural home for a new top-level verb, and a module that already
    // contained a `redactForEgress` call - passed the presence check
    // while writing raw bytes to its own `--out`. Counting destinations
    // against guard calls closes that: a second destination needs a
    // second guard call.
    const uncovered = ENTRIES.filter((entry) => entry.redaction === EGRESS_REDACTION.sharedRedactor)
      .map((entry) => {
        const text = moduleText(entry.module);
        return {
          module: entry.module,
          destinations: countMatches(text, ANY_DESTINATION_G_RE),
          guards: countMatches(text, EGRESS_GUARD_CALL_G_RE),
        };
      })
      .filter((row) => row.guards < row.destinations)
      .map(
        (row) => `${row.module}: ${row.destinations} destination(s), ${row.guards} guard call(s)`,
      );
    expect(uncovered).toEqual([]);
  });

  test("no entry understates what its module does", () => {
    // The complement: a module that calls the guard but is declared as
    // something weaker would leave the registry describing a gap that is
    // no longer there, and the next reader would re-open a closed hole.
    //
    // This test once made a leak unfixable. `brain-continuity-export` was
    // declared `upstream_read_model` while its upstream redacted with the
    // redactor's DEFAULT options, and adding the guard call that closed
    // the leak failed HERE. The bug was never the assertion - it was
    // reading a failure as "remove the call" instead of "flip the
    // declaration". The unverifiable status is gone, so the only weaker
    // status left is `no_vault_content`, and a module that both composes
    // no vault content and scans it is a contradiction worth failing on.
    const understated = ENTRIES.filter(
      (entry) =>
        entry.redaction !== EGRESS_REDACTION.sharedRedactor &&
        EGRESS_GUARD_CALL_RE.test(moduleText(entry.module)),
    ).map((entry) => entry.id);
    expect(understated).toEqual([]);
  });

  test("every entry carries an id, a verb, and a non-empty reason", () => {
    for (const entry of ENTRIES) {
      expect(`${entry.id}: ${entry.verb.length > 0} ${entry.reason.trim().length > 0}`).toBe(
        `${entry.id}: true true`,
      );
    }
  });

  test("ids and module paths are unique", () => {
    expect(new Set(ENTRIES.map((e) => e.id)).size).toBe(ENTRIES.length);
    expect(DECLARED_MODULES.size).toBe(ENTRIES.length);
    // The record is keyed by id; a key that disagreed with its own entry
    // would make a refusal message name a site nobody can find.
    const mismatched = Object.entries(EGRESS_SITES)
      .filter(([key, entry]) => key !== entry.id)
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });
});

describe("the census cannot pass by finding nothing", () => {
  test("the detector still sees the sites it measures", () => {
    // A regex that stopped matching would report a clean sweep over an
    // empty set. Floors sit just under the live measurement, not an order
    // of magnitude under it.
    expect(POPULATION.length).toBeGreaterThan(5);
    expect(
      ENTRIES.filter((e) => e.redaction === EGRESS_REDACTION.sharedRedactor).length,
    ).toBeGreaterThan(4);
  });

  test("the five verbs this unit wired are all declared as redacting", () => {
    // Pinned by module path, because "five" is a number that goes stale
    // and a path is a fact.
    const redacting = new Set(
      ENTRIES.filter((e) => e.redaction === EGRESS_REDACTION.sharedRedactor).map((e) => e.module),
    );
    for (const path of [
      "src/cli/brain/verbs/bank-export.ts",
      "src/cli/brain/verbs/graph-export.ts",
      "src/cli/brain/verbs/okf-export.ts",
      "src/cli/brain/verbs/export.ts",
      "src/cli/main.ts",
    ]) {
      expect(`${path}: ${redacting.has(path)}`).toBe(`${path}: true`);
    }
  });

  /**
   * Every source shape a destination declaration can arrive in. Each must
   * be detected on its own, so a regex narrowed by a later edit shows up
   * here as a named failure rather than as a silently smaller population.
   */
  const INTRUDER_SHAPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
    ["a spec entry on its own line", '  out: { type: "string" },\n'],
    [
      "a spec entry inline with others",
      'parse(argv, { vault: { type: "string" }, out: { type: "string" } });\n',
    ],
    ["a quoted flag name", '  "out-dir": { type: "string" },\n'],
    ["a longer destination name", '  destination: { type: "string" },\n'],
    ["extra properties after the type", '  output: { type: "string", required: true },\n'],
    [
      "a CLI verb whose destination flag is --file",
      'const { flags } = parse(argv, { file: { type: "string" } });\n' +
        '  writeFileSync(flags["file"] as string, body, "utf8");\n',
    ],
    [
      "an MCP tool taking its destination in args",
      'inputSchema: { properties: { path: { type: "string", description: "where to write" } } }\n' +
        "  writeFileSync(args.path as string, body);\n",
    ],
    [
      "a verb that delegates the write but names --outdir",
      '  outdir: { type: "string" },\n  writeBundle(outdir, plan);\n',
    ],
  ]);

  for (const [shape, source] of INTRUDER_SHAPES) {
    test(`a new export path using ${shape} is in population`, () => {
      expect(declaresDestination(source)).toBe(true);
    });
  }

  test("an identifier that merely ends in a destination name is not one", () => {
    expect(declaresDestination('  stdout: { type: "string" },\n')).toBe(false);
    expect(declaresDestination('  about: { type: "string" },\n')).toBe(false);
  });

  test("an ambiguous name without a write is a reader, not an egress path", () => {
    // `brain facts --file` reads a claims file. Admitting the name alone
    // would put fourteen read-only modules in population and make the
    // registry a list of every verb that takes a path.
    expect(
      declaresDestination('  file: { type: "string" },\n  readFileSync(flags["file"]);\n'),
    ).toBe(false);
    expect(declaresDestination('  path: { type: "string" },\n')).toBe(false);
  });

  test("the ambiguous-name rule adds nothing today, so it is a tripwire", () => {
    // If it ever starts adding modules, that is a real new egress path
    // and the failure above will name it. Pinned so the rule cannot be
    // widened into a backlog by accident.
    const byAmbiguousOnly = SOURCE_TREE.filter(
      (f) => !DESTINATION_FLAG_RE.test(f.text) && declaresDestination(f.text),
    ).map((f) => f.path);
    expect(byAmbiguousOnly).toEqual([]);
  });

  test("a non-string destination flag is not a path", () => {
    expect(declaresDestination('  out: { type: "boolean" },\n')).toBe(false);
  });

  test("an undeclared module in population is reported by name", () => {
    const intruder = "src/cli/brain/verbs/synthetic-export.ts";
    const population = [...POPULATION, intruder];
    expect(population.filter((path) => !DECLARED_MODULES.has(path))).toEqual([intruder]);
  });
});

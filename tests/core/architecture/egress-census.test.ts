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
 * A module is IN POPULATION when it declares an operator-named output
 * DESTINATION flag: an entry in a flag-parser spec whose name is one of
 * {@link DESTINATION_FLAGS} and whose type is `string`. That is the one
 * syntactic fact common to every egress path - the operator says where
 * the bytes go - and it needs no judgment about whether a given payload
 * "is vault content". Deciding that is what the registry entry is for.
 *
 * The rule deliberately does NOT require the module to call `fs` itself.
 * `okf-export` delegates its writes to `writeOkfBundle`, and a rule keyed
 * on the write call would have missed the widest directory export in the
 * tree. The flag is declared where the decision is made; the write can be
 * anywhere downstream.
 *
 * ## What it does not cover, stated rather than implied
 *
 * A destination taken as a positional argument rather than a flag, and a
 * flag spec built dynamically instead of written as an object literal.
 * Both would be new shapes in this tree; {@link INTRUDER_SHAPES} is where
 * a new one gets added the day it appears. It also says nothing about
 * `process.stdout` - every CLI verb writes there, so including it would
 * make the population the whole CLI and the record meaningless. The
 * stdout arm of each declared verb is covered by the same guard call the
 * `--out` arm makes, which is why the guard is asserted per MODULE and
 * not per write.
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
 * A flag-parser spec entry: `out: { type: "string" }`, optionally quoted,
 * with or without further properties. The leading class rejects a longer
 * identifier ending in one of the names (`about:`, `stdout:`).
 */
const DESTINATION_FLAG_RE = new RegExp(
  String.raw`(^|[^A-Za-z0-9_$"'\-])"?(${DESTINATION_FLAGS.join("|")})"?\s*:\s*\{\s*type\s*:\s*"string"`,
  "m",
);

/** The shared egress guard. A module that calls it redacts on the way out. */
const EGRESS_GUARD_CALL_RE = /\bredactForEgress\s*\(/;

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

/** True when this module declares an operator-named output destination. */
function declaresDestination(text: string): boolean {
  return DESTINATION_FLAG_RE.test(text);
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

  test("a non-string destination flag is not a path", () => {
    expect(declaresDestination('  out: { type: "boolean" },\n')).toBe(false);
  });

  test("an undeclared module in population is reported by name", () => {
    const intruder = "src/cli/brain/verbs/synthetic-export.ts";
    const population = [...POPULATION, intruder];
    expect(population.filter((path) => !DECLARED_MODULES.has(path))).toEqual([intruder]);
  });
});

/**
 * Census over the in-vault state population.
 *
 * `STATE_SURFACES` claims to be the complete list of durable locations
 * this tool keeps inside a vault. A hand-written list cannot vouch for its
 * own completeness, and the failure mode is silent: a new module joins a
 * path under `<vault>/.open-second-brain/`, ships, and the inventory an
 * operator reads before migrating their vault simply does not mention it.
 *
 * So the derived-store half of the population is DERIVED, from the source:
 * every module under `src/` that names {@link DERIVED_STORE_DIR} - by the
 * constant or by its value - has to be attributed to a row through
 * {@link StateSurface.sources} or excused in
 * {@link STATE_SURFACE_SWEEP_EXCLUSIONS} with a written reason. That is
 * the same instrument `OUT_OF_VAULT_SWEEP_EXCLUSIONS` already applies to
 * the outside-the-vault half, pointed at the other root.
 *
 * ## What the sweep can and cannot see, stated rather than implied
 *
 * It lexes through the shared lexer (`tests/helpers/source-lexer.ts`) and
 * matches on the CODE view, so a directory named in a docblock is not a
 * path builder and a `"{"` inside a value cannot move a block. Four
 * private copies of that lexer produced a real defect in v1.49.0; there is
 * no fifth here.
 *
 *   - `src/` only. `hooks/lib/session-state.ts` builds a real surface
 *     under the same root and is out of the swept tree, so its row names
 *     it explicitly and `tests/core/state/surfaces.test.ts` asserts that
 *     the file it names still exists.
 *   - The `Brain/` half of the population carries no single anchor token -
 *     `BRAIN_LOG_REL`, `brainDirs(...).log` and a bare `"Brain"` are all
 *     the same root - so it is held true by the resolver-binding block in
 *     the unit test rather than by this sweep. Saying which half is swept
 *     is the difference between a census and a claim about a census. That
 *     delegation is only worth what the block covers: it bound 26 of 40
 *     rows when this sentence first appeared, and a deliberately wrong
 *     value in one of the other fourteen changed no test. It now binds
 *     every row bar a counted, reasoned exception list, and the count is
 *     itself an assertion there.
 *   - This sweep NEVER checks that a row's declared path is the path its
 *     owner builds. `attributed()` asks only whether a module is claimed
 *     by some row's `sources`, which is a question about attribution and
 *     not about correctness.
 *   - A path whose root arrives as an argument carries no token to match
 *     on. `writer-lock.ts` and `session-focus.ts` are exactly that shape:
 *     both build under the store directory and neither names it.
 *
 * ## The alarm on the parser
 *
 * A block matcher that goes wrong reports a clean tree, so the population
 * is cross-checked against a second, dumber search that cannot mis-parse
 * because it does not parse - a line regex for a `join(` whose arguments
 * name the store directory. Every file it finds must be in the population.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { DERIVED_STORE_DIR } from "../../../src/core/brain/path-constants.ts";
import {
  STATE_SURFACE_SWEEP_EXCLUSIONS,
  STATE_SURFACES,
} from "../../../src/core/state/surfaces.ts";
import { lexSource } from "../../helpers/source-lexer.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The one root the sweep walks. See the docblock for what living outside costs. */
const SWEPT_ROOT = "src";

/** The identifier the constant is imported under everywhere it is used. */
const STORE_DIR_IDENTIFIER = "DERIVED_STORE_DIR";

/**
 * Modules in the swept tree today. An equality rather than a floor: a
 * glob that stopped matching would sweep an empty set clean and every
 * assertion below would pass over nothing.
 */
const SWEPT_POPULATION_SIZE = 20;

/** Declared surfaces today. Pinned for the same reason. */
const DECLARED_SURFACE_COUNT = 40;

/** An exclusion reason has to be an argument, not a label. */
const MIN_REASON_LENGTH = 80;

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function readSourceTree(): ReadonlyArray<SourceFile> {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(join(REPO_ROOT, SWEPT_ROOT));
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Whether `file` names the derived-store directory in CODE.
 *
 * Two shapes, because both ship: the imported constant, and the bare
 * literal a dozen modules spell privately. The literal is read off the
 * comment-stripped view - which keeps string CONTENTS, so `".open-second-
 * brain"` is still readable - and confirmed against the code view, where a
 * quote delimiter survives but a comment does not. Reading it off the code
 * view alone would find nothing, because that view blanks literal
 * contents; reading it off the raw text would enrol every docblock that
 * mentions the directory by name.
 */
function namesStoreDir(file: SourceFile): boolean {
  const { withoutComments, code } = lexSource(file.text);
  if (new RegExp(`\\b${STORE_DIR_IDENTIFIER}\\b`).test(code)) return true;
  for (const quote of ['"', "'"]) {
    const needle = `${quote}${DERIVED_STORE_DIR}${quote}`;
    for (let at = withoutComments.indexOf(needle); at !== -1; ) {
      if (code[at] === quote) return true;
      at = withoutComments.indexOf(needle, at + 1);
    }
  }
  return false;
}

/** Every swept module that names the store directory. */
function sweepPopulation(tree: ReadonlyArray<SourceFile> = TREE): ReadonlyArray<string> {
  return tree.filter(namesStoreDir).map((file) => file.path);
}

/**
 * The naive cross-check: a `join(` whose arguments name the store
 * directory, matched on raw text one line at a time. It cannot mis-parse
 * because it does not parse, and it is strictly narrower than the rule
 * above, so every file it finds must be in the population.
 */
const NAIVE_RE = new RegExp(
  `join\\([^)\\n]*(?:"${DERIVED_STORE_DIR.replace(/\./g, "\\.")}"|${STORE_DIR_IDENTIFIER})`,
);

function naivePathBuilders(tree: ReadonlyArray<SourceFile> = TREE): ReadonlyArray<string> {
  return tree.filter((file) => NAIVE_RE.test(file.text)).map((file) => file.path);
}

/**
 * Whether any declared row claims `path` through its `sources`.
 *
 * A trailing-slash source names the files IN that directory and not the
 * tree beneath it. Unbounded, it was an absolution: a row declaring
 * `sources: ["src/core/"]` would have answered for most of this
 * repository, and the "every declared source module exists" check in
 * `tests/core/state/surfaces.test.ts` would have waved it through
 * because `src/core` does exist. No row spells one today, which is
 * exactly when the bound is cheap to put on.
 */
function attributed(
  path: string,
  surfaces: ReadonlyArray<{ readonly sources: ReadonlyArray<string> }> = STATE_SURFACES,
): boolean {
  return surfaces.some((surface) =>
    surface.sources.some((source) =>
      source.endsWith("/")
        ? path.startsWith(source) && !path.slice(source.length).includes("/")
        : path === source,
    ),
  );
}

const TREE = readSourceTree();

describe("state surface census", () => {
  test("every module that names the derived store is attributed to a row or excused", () => {
    // ONE folded expectation whose value NAMES the work: asserting per
    // module would stop at the first and hide the rest.
    const unaccounted = sweepPopulation().filter(
      (path) => !attributed(path) && !STATE_SURFACE_SWEEP_EXCLUSIONS.has(path),
    );
    expect(unaccounted.toSorted().join("\n")).toBe("");
  });

  test("no exclusion outlives the module it excuses, and every reason says something", () => {
    const swept = new Set(sweepPopulation());
    const stale: string[] = [];
    const thin: string[] = [];
    for (const [path, reason] of STATE_SURFACE_SWEEP_EXCLUSIONS) {
      if (!swept.has(path)) stale.push(path);
      // A placeholder ("todo", "n/a", "") cannot satisfy this.
      if (reason.trim().length < MIN_REASON_LENGTH) thin.push(path);
      if (/\bTODO\b|\bfor now\b|\blater\b/i.test(reason)) thin.push(path);
    }
    expect(stale.toSorted().join("\n")).toBe("");
    expect(thin.toSorted().join("\n")).toBe("");
  });

  test("no module is both attributed and excused", () => {
    // Two answers to one question is how an exclusion survives the row
    // that replaced it, still excusing a module nobody reads it for.
    const both = sweepPopulation().filter(
      (path) => attributed(path) && STATE_SURFACE_SWEEP_EXCLUSIONS.has(path),
    );
    expect(both.toSorted().join("\n")).toBe("");
  });

  test("the naive cross-check finds nothing the population missed", () => {
    // The alarm on the parser itself. A lexer that blanked the wrong span
    // would report a clean sweep over a shrunken population; this search
    // cannot, because it never looks at structure.
    const population = new Set(sweepPopulation());
    const unseen = naivePathBuilders().filter((path) => !population.has(path));
    expect(unseen.toSorted().join("\n")).toBe("");
    // …and it has to have found something, or it is no alarm at all.
    expect(naivePathBuilders().length).toBeGreaterThan(5);
  });

  test("the census is not vacuous", () => {
    expect(TREE.length).toBeGreaterThan(850);
    expect(sweepPopulation().length).toBe(SWEPT_POPULATION_SIZE);
    expect(STATE_SURFACES.length).toBe(DECLARED_SURFACE_COUNT);
  });
});

describe("the census can fail", () => {
  /** The intruder joins the real tree, so the rule runs under real conditions. */
  const intruder = (path: string, text: string): ReadonlyArray<SourceFile> => [
    ...TREE,
    { path, text },
  ];

  /** Only the intruder's own row, so an unrelated module cannot answer for it. */
  const unaccountedFrom = (path: string, text: string): ReadonlyArray<string> =>
    sweepPopulation(intruder(path, text)).filter(
      (p) => p === path && !attributed(p) && !STATE_SURFACE_SWEEP_EXCLUSIONS.has(p),
    );

  test("a new path builder under the store directory is unaccounted for", () => {
    const path = "src/core/synthetic-store-writer.ts";
    const text =
      'import { join } from "node:path";\n' +
      "export function spoolPath(vault: string): string {\n" +
      `  return join(vault, "${DERIVED_STORE_DIR}", "synthetic-spool.jsonl");\n` +
      "}\n";
    expect(unaccountedFrom(path, text)).toEqual([path]);
  });

  test("a builder reaching the directory through the constant is caught too", () => {
    const path = "src/core/synthetic-constant-writer.ts";
    const text =
      'import { DERIVED_STORE_DIR } from "./brain/path-constants.ts";\n' +
      'export const dir = (vault: string): string => join(vault, DERIVED_STORE_DIR, "x");\n';
    expect(unaccountedFrom(path, text)).toEqual([path]);
    expect(naivePathBuilders(intruder(path, text))).toContain(path);
  });

  test("a directory source answers for its own files and not for the tree below it", () => {
    // Driven against a synthetic row rather than a real one, because the
    // point is what the RULE would allow: an unbounded prefix let one
    // source line absolve every module under it, and the population is
    // only as honest as the narrowest claim it accepts.
    const sweeping = [{ sources: ["src/core/"] }];
    expect(attributed("src/core/doctor.ts", sweeping)).toBe(true);
    expect(attributed("src/core/state/migrate.ts", sweeping)).toBe(false);
    expect(attributed("src/core/brain/anticipatory-cache.ts", sweeping)).toBe(false);
  });

  test("a docblock that merely names the directory is not a path builder", () => {
    // The false positive the lexing exists to prevent. Seven modules in
    // the real tree mention the directory only in prose.
    const path = "src/core/synthetic-prose.ts";
    const text = `/** Nothing here writes to ${DERIVED_STORE_DIR}. */\nexport const x = 1;\n`;
    expect(sweepPopulation(intruder(path, text))).not.toContain(path);
  });
});

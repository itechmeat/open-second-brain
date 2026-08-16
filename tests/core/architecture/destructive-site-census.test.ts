/**
 * R1b: every destructive site under `src/core/brain/`, measured rather
 * than described.
 *
 * The defect. `snapshot-gate.ts` states in its own header that "no
 * destructive brain mutation runs without a recovery point on disk
 * first". It has two call sites. Everything else that removes or
 * displaces vault bytes does so with whatever recovery story its author
 * had in mind at the time, and there is no way to tell a site that
 * genuinely needs none from a site nobody has got round to. Both look
 * identical from outside, which is exactly the reading this census
 * removes: a removal site is either routed through the gate, or it
 * carries an entry in {@link DESTRUCTIVE_SITES} declaring what recovery
 * it actually has and why that is enough - never both, never neither.
 *
 * ## The population is syntactic
 *
 * "Is this destructive?" is a judgement this census must never have to
 * make. "Does this file call `unlinkSync`?" is not a judgement. A module
 * under `src/core/brain/` is in population when it calls a REMOVAL or
 * DISPLACEMENT call bound from `node:fs` / `node:fs/promises`. This is
 * `write-site-census.test.ts`'s rule with a different call set, and the
 * binding detector is deliberately the same shape - renamed bindings,
 * namespace imports, a second `node:fs` statement, either quote style -
 * because those are the shapes that made an earlier census read as clean
 * over sites it could not see.
 *
 * ### Six shapes that used to be invisible
 *
 * A reviewer dropped six modules into `src/core/brain/` and this census
 * returned a clean sweep over all of them; each one also typechecks, so
 * none was a strawman. They are fixtures in "the census can fail" now,
 * and the detector answers each of them:
 *
 *   - `import fs from "node:fs"` - a DEFAULT import, which the old
 *     binding regex could not express (it read `* as` and `{...}` only);
 *   - `import { promises as fsp } from "node:fs"` - a binding whose
 *     imported name is `promises`, i.e. a namespace reached through a
 *     named import rather than a specifier;
 *   - `import { rmSync } from "fs"` - the bare specifier, which is the
 *     same module as `node:fs` and was excluded by requiring the prefix;
 *   - `const { rmSync } = await import("node:fs")` - a dynamic import,
 *     which is not an import STATEMENT and so matched nothing;
 *   - `fs[call](p)` - a computed member on an fs namespace, which the
 *     literal `.rmSync(` probe cannot see. It is reported under
 *     {@link FS_UNRESOLVED_CALL} rather than resolved, because which call
 *     it makes is a runtime fact;
 *   - `probe.mts` - a module the tree walk skipped, because it filtered
 *     on `.ts`.
 *
 * The lesson generalises past the six: the detector reads a LEXED view of
 * each module (comments and string/regex literal bodies blanked, offsets
 * preserved), so a removal named in a comment is not a site and a site is
 * not hidden by a quote inside a regular expression.
 *
 * That lexer used to live in this file, and a character-identical copy of
 * it lived in the progress census while two further censuses ran partial
 * maskers of their own - one of which was wrong on shipped source. It is
 * now `tests/helpers/source-lexer.ts`, tested there in its own right, and
 * this census reads both of its views: {@link LexedSource.withoutComments}
 * for the import specifiers the binding detector needs, and
 * {@link LexedSource.code} for the calls and the gate spans.
 *
 * ## Gating is per SITE, not per file
 *
 * `gated` used to be a file-level boolean: any file containing the string
 * `withDestructiveSnapshot(` - including in a comment - exempted every
 * removal in it. That is not the guarantee this file's header claims. A
 * removal is gated when it sits INSIDE the argument list of a
 * `withDestructiveSnapshot(...)` call, and the containment is measured
 * from the lexed view by matching parentheses.
 *
 * Lexical containment is deliberately the whole of it. A module that
 * hands the gate a function BY NAME - `withDestructiveSnapshot(v, r,
 * runDeletion)` - is making a claim about reachability that nothing
 * syntactic can check, so it declares that claim in
 * {@link DESTRUCTIVE_SITES} like every other unproved recovery story. The
 * census is stricter under this rule, never looser: extracting a removal
 * into a helper moves it OUT of the gated set.
 *
 * ## The narrowing, stated rather than hidden
 *
 * The design's population rule also named "an atomic write in overwrite
 * mode". That clause is NOT in the rule below, and what follows is what
 * the exclusion does and does not buy - previously stated as two claims
 * that a reviewer falsified:
 *
 *   - it is NOT true that "an atomic overwrite replaces bytes the same
 *     module authored and can regenerate". `page-dedup.ts` rewrites
 *     wikilinks across user-authored notes through `atomicWriteFileSync`;
 *     no producer regenerates a sentence a person wrote;
 *   - it is NOT true that "every overwrite site is already held by the
 *     write-site census". That census registers the sites that BYPASS a
 *     shared writer (its own header, `:38-41`); a module that uses one is
 *     compliant there and appears in no registry at all.
 *
 * So the honest statement is a narrower one: this census holds the sites
 * where bytes CEASE TO EXIST, and an overwrite through a shared writer is
 * held by neither census. `the overwrite class is unheld by either
 * census` at the bottom of this file measures that gap rather than
 * asserting it is empty, and `the overwrite class is large` measures why
 * it is not closed by pasting reasons into this registry. Closing it
 * needs a population rule that can tell a regenerable derivation from
 * user prose, which is a different unit of work; leaving the old claim
 * standing while it is known to be false is the one option this file
 * cannot take.
 *
 * ## What this file deliberately does NOT do
 *
 * It does not check that a declared recovery story is TRUE. Nothing
 * syntactic can: whether `pending.ts` really lands its destination
 * before unlinking its source is a question for that module's own
 * tests, and this census would be claiming a proof it does not have if
 * it pretended otherwise. What it guarantees is that the claim exists,
 * is specific, is not a copy of another entry's claim, and names exactly
 * the calls the site makes today.
 *
 * It also does not reach outside `src/core/brain/`. The search store,
 * the CLI verbs and the MCP surface remove files too; they are a
 * separate population with a separate recovery story, and pulling them
 * in here would produce one list nobody reads instead of two that are
 * legible.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  DESTRUCTIVE_SITE_MIN_REASON_LENGTH,
  DESTRUCTIVE_SITES,
  destructiveSiteRecoverability,
  FS_UNRESOLVED_CALL,
  REMOVAL_CALLS,
} from "../../../src/core/brain/destructive-sites.ts";
import {
  isRecoverabilityBlocker,
  isRecoveryCoverage,
  RECOVERABILITY_STATE,
} from "../../../src/core/brain/gates/recoverability.ts";
import { type LexedSource, lexSource } from "../../helpers/source-lexer.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BRAIN_ROOT = join(REPO_ROOT, "src", "core", "brain");

/** The gate a site routes through instead of declaring its own story. */
const GATE_CALL = "withDestructiveSnapshot";

/** Every TypeScript module extension the runtime will load and run. */
const MODULE_EXTENSIONS: ReadonlyArray<string> = Object.freeze([".ts", ".mts", ".cts", ".tsx"]);

/**
 * The shared writers whose presence marks the overwrite class. Used only
 * by the narrowing measurements at the bottom - never by the population.
 */
const OVERWRITE_CALLS: ReadonlyArray<string> = Object.freeze([
  "atomicWriteFileSync",
  "atomicWriteText",
  "writeFrontmatterAtomic",
]);

/**
 * The write-site census's registry, read as TEXT rather than imported.
 *
 * It is a `const` inside a test file, so there is nothing to import; and
 * the question asked of it here is only whether a path appears in it,
 * which the text answers exactly. Reading it at all is what keeps "the
 * other census holds those sites" a measurement instead of a claim.
 */
const WRITE_SITE_CENSUS = readFileSync(
  join(REPO_ROOT, "tests", "core", "architecture", "write-site-census.test.ts"),
  "utf8",
);

// ----- Binding detection ----------------------------------------------------

interface CensusFile {
  readonly path: string;
  readonly text: string;
}

interface CensusRow {
  readonly path: string;
  /** Removal calls inside a `withDestructiveSnapshot(...)` argument list. */
  readonly gatedCalls: ReadonlyArray<string>;
  /** Removal calls that are not, by their `node:fs` name, sorted. */
  readonly ungatedCalls: ReadonlyArray<string>;
}

/** Every TypeScript module under `src/core/brain/`, at any depth. */
function readBrainTree(): CensusFile[] {
  const files: CensusFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (MODULE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(BRAIN_ROOT);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

interface FsImports {
  /** Local binding -> the `node:fs` name it was imported under. */
  readonly bindings: ReadonlyMap<string, string>;
  /** Locals that hold an fs MODULE object: `* as fs`, a default, a
   * dynamic import's binding, or a named `promises`. */
  readonly namespaces: ReadonlySet<string>;
}

/**
 * Every static import of the fs module, in every binding form and both
 * quote styles, with or without the `node:` prefix. GLOBAL, so a module's
 * second statement is read too. `import type` does not match - a type
 * cannot be called.
 */
const FS_STATIC_IMPORT_RE =
  /\bimport\s+(?!type\b)([^;]*?)\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g;

/**
 * The dynamic forms. `import()` and `require()` bind the same module
 * object; the difference from the statement form is only that the
 * binding is on the left of an `=`.
 */
const FS_DYNAMIC_IMPORT_RE =
  /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:import|require)\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/g;

/** The named import whose binding is a module object, not a function. */
const FS_NAMESPACE_MEMBER = "promises";

/** Record one `{ a, b as c }` clause's bindings. */
function readBraceClause(
  clause: string,
  imports: {
    bindings: Map<string, string>;
    namespaces: Set<string>;
  },
): void {
  for (const raw of clause.replaceAll(/[{}]/g, "").split(",")) {
    const specifier = raw.trim();
    if (specifier.length === 0) continue;
    // `{ type Foo }` and `{ type Foo as Bar }` bind nothing callable.
    if (/^type\s/.test(specifier)) continue;
    const [imported, local] = specifier.split(/\s+as\s+/).map((part) => part.trim());
    if (imported === undefined || imported.length === 0) continue;
    const bound = local !== undefined && local.length > 0 ? local : imported;
    if (imported === FS_NAMESPACE_MEMBER) imports.namespaces.add(bound);
    else imports.bindings.set(bound, imported);
  }
}

function fsImports(withoutComments: string): FsImports {
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
  const acc = { bindings, namespaces };
  for (const match of withoutComments.matchAll(FS_STATIC_IMPORT_RE)) {
    // One clause, which may be `* as ns`, `{ ... }`, `def`, or
    // `def, { ... }` - every combination the grammar allows.
    let clause = match[1]!.trim();
    const brace = clause.indexOf("{");
    if (brace !== -1) {
      readBraceClause(clause.slice(brace), acc);
      clause = clause.slice(0, brace).replace(/,\s*$/, "").trim();
    }
    if (clause.length === 0) continue;
    const asNamespace = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (asNamespace !== null) {
      namespaces.add(asNamespace[1]!);
      continue;
    }
    const asDefault = /^([A-Za-z_$][\w$]*)$/.exec(clause);
    if (asDefault !== null) namespaces.add(asDefault[1]!);
  }
  for (const match of withoutComments.matchAll(FS_DYNAMIC_IMPORT_RE)) {
    const target = match[1]!.trim();
    if (target.startsWith("{")) readBraceClause(target, acc);
    else namespaces.add(target);
  }
  return { bindings, namespaces };
}

const REMOVAL_SET: ReadonlySet<string> = new Set(REMOVAL_CALLS);

/** Longest name first, so a prefix cannot shadow the longer name after it. */
function alternation(names: ReadonlyArray<string>): string {
  return [...names].toSorted((a, b) => b.length - a.length).join("|");
}

/** One removal call: which `node:fs` name, and where in the module. */
interface RemovalSite {
  readonly call: string;
  readonly index: number;
}

/** Every removal this module makes directly, with its offset. */
function removalSites(code: string, imported: FsImports): RemovalSite[] {
  const sites: RemovalSite[] = [];
  const locals = [...imported.bindings.keys()];
  if (locals.length > 0) {
    for (const match of code.matchAll(
      new RegExp(String.raw`\b(${alternation(locals)})\s*\(`, "g"),
    )) {
      const name = imported.bindings.get(match[1]!);
      if (name !== undefined && REMOVAL_SET.has(name)) {
        sites.push({ call: name, index: match.index });
      }
    }
  }
  for (const namespace of imported.namespaces) {
    // `fs.rmSync(`, and `fs.promises.rm(` - the second is the same
    // module object one member deeper.
    const member = String.raw`\b${namespace}\s*\.\s*(?:${FS_NAMESPACE_MEMBER}\s*\.\s*)?`;
    for (const match of code.matchAll(
      new RegExp(String.raw`${member}(${alternation(REMOVAL_CALLS)})\s*\(`, "g"),
    )) {
      sites.push({ call: match[1]!, index: match.index });
    }
    // A computed member: which call it makes is a runtime fact, so it is
    // REPORTED rather than resolved. Declaring it is the only way past.
    for (const match of code.matchAll(
      new RegExp(String.raw`\b${namespace}\s*(?:\.\s*${FS_NAMESPACE_MEMBER}\s*)?\[`, "g"),
    )) {
      sites.push({ call: FS_UNRESOLVED_CALL, index: match.index });
    }
  }
  return sites;
}

/** `[start, end)` of every `withDestructiveSnapshot(...)` argument list. */
function gateSpans(code: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (const match of code.matchAll(new RegExp(String.raw`\b${GATE_CALL}\s*\(`, "g"))) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = code.length;
    for (let j = open; j < code.length; j++) {
      const ch = code[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    spans.push([match.index, end]);
  }
  return spans;
}

/**
 * A module and its lexed views. Lexing is the expensive step and the
 * result depends only on the text, so every file is read through this
 * once and the whole suite reuses it.
 */
interface CensusSource extends CensusFile {
  readonly views: LexedSource;
}

function lexed(file: CensusFile): CensusSource {
  return { ...file, views: lexSource(file.text) };
}

function classify(file: CensusFile | CensusSource): CensusRow | null {
  const views = "views" in file ? file.views : lexSource(file.text);
  const sites = removalSites(views.code, fsImports(views.withoutComments));
  if (sites.length === 0) return null;
  const spans = gateSpans(views.code);
  const gated = new Set<string>();
  const ungated = new Set<string>();
  for (const site of sites) {
    const inside = spans.some(([from, to]) => site.index >= from && site.index < to);
    (inside ? gated : ungated).add(site.call);
  }
  return {
    path: file.path,
    gatedCalls: [...gated].toSorted(),
    ungatedCalls: [...ungated].toSorted(),
  };
}

function census(files: ReadonlyArray<CensusSource>): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const file of files) {
    const row = classify(file);
    if (row !== null) rows.push(row);
  }
  return rows;
}

const BRAIN_TREE = readBrainTree().map(lexed);
const ROWS = census(BRAIN_TREE);
/** The rows that owe a declaration: at least one removal is not gated. */
const UNGATED_ROWS = ROWS.filter((row) => row.ungatedCalls.length > 0);

describe("destructive-site census", () => {
  test("every removal site is routed through the gate or declares its recovery", () => {
    const unaccounted = UNGATED_ROWS.filter((row) => !(row.path in DESTRUCTIVE_SITES)).map(
      (row) => `${row.path} [${row.ungatedCalls.join(",")}]`,
    );
    // Named, not counted: the failure has to say which file.
    expect(unaccounted).toEqual([]);
  });

  test("a site whose every removal is gated does not also carry a declaration", () => {
    // Two answers to one question is the drift this census exists to
    // stop: the gate would move and the entry would stay, saying
    // something about a routing that no longer exists.
    const both = ROWS.filter(
      (row) => row.ungatedCalls.length === 0 && row.path in DESTRUCTIVE_SITES,
    ).map((row) => row.path);
    expect(both).toEqual([]);
  });

  test("no declaration outlives the site it accounts for", () => {
    const present = new Set(UNGATED_ROWS.map((row) => row.path));
    const stale = Object.keys(DESTRUCTIVE_SITES).filter((path) => !present.has(path));
    expect(stale).toEqual([]);
  });

  test("each declaration names exactly the ungated calls its site makes", () => {
    // A new KIND of removal inside an already-declared module is a new
    // decision, not one the existing argument already covered. A removal
    // that MOVED inside the gate is the same drift from the other side:
    // the entry would keep claiming a story for a site that no longer
    // needs one.
    const drifted: string[] = [];
    for (const row of ROWS) {
      const entry = DESTRUCTIVE_SITES[row.path];
      if (entry === undefined) continue;
      if (entry.calls.join(",") !== row.ungatedCalls.join(",")) {
        drifted.push(
          `${row.path}: declared [${entry.calls.join(",")}] found [${row.ungatedCalls.join(",")}]`,
        );
      }
    }
    expect(drifted).toEqual([]);
  });

  test("every reason is specific", () => {
    for (const [path, entry] of Object.entries(DESTRUCTIVE_SITES)) {
      expect(`${path}: ${entry.reason.trim().length >= DESTRUCTIVE_SITE_MIN_REASON_LENGTH}`).toBe(
        `${path}: true`,
      );
    }
  });

  test("no two sites share a reason", () => {
    // The cheapest way to fake this census is to paste one plausible
    // sentence across thirty entries. A duplicate reason is that, and it
    // is detectable without reading a word of it.
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [path, entry] of Object.entries(DESTRUCTIVE_SITES)) {
      const key = entry.reason.trim().replaceAll(/\s+/g, " ");
      const first = seen.get(key);
      if (first === undefined) seen.set(key, path);
      else duplicates.push(`${path} repeats the reason of ${first}`);
    }
    expect(duplicates).toEqual([]);
  });

  test("every declaration classifies to a verdict from the closed vocabularies", () => {
    const offenders: string[] = [];
    for (const path of Object.keys(DESTRUCTIVE_SITES)) {
      const verdict = destructiveSiteRecoverability(path);
      if (verdict === null) {
        offenders.push(`${path}: no verdict`);
        continue;
      }
      if (!verdict.coverage.every(isRecoveryCoverage)) offenders.push(`${path}: coverage token`);
      if (!verdict.blockers.every(isRecoverabilityBlocker))
        offenders.push(`${path}: blocker token`);
      if (Object.isFrozen(verdict) !== true) offenders.push(`${path}: verdict not frozen`);
    }
    expect(offenders).toEqual([]);
  });

  test("a site declaring no recovery point says so, rather than claiming cover", () => {
    // The whole point of the declaration: a module with no archive
    // behind it must reach `unproven` or `nothing_at_risk`, never
    // `covered`. `covered` without the gate would be a claim the
    // registry cannot support.
    const overclaiming: string[] = [];
    for (const [path, entry] of Object.entries(DESTRUCTIVE_SITES)) {
      if (entry.recovery.recoveryPoint) continue;
      const state = destructiveSiteRecoverability(path)?.state;
      if (state === RECOVERABILITY_STATE.covered || state === RECOVERABILITY_STATE.partial) {
        overclaiming.push(`${path}: ${String(state)}`);
      }
    }
    expect(overclaiming).toEqual([]);
  });

  test("the census is not vacuous", () => {
    // A detector that stopped matching would sweep an empty set clean,
    // and a tree walk that lost its subdirectories would shrink the
    // population without failing anything above. Floors set just under
    // the measurement, not an order of magnitude under it.
    expect(BRAIN_TREE.length).toBeGreaterThan(250);
    expect(ROWS.length).toBeGreaterThan(28);
    expect(ROWS.filter((row) => row.gatedCalls.length > 0).length).toBeGreaterThan(1);
    expect(Object.keys(DESTRUCTIVE_SITES).length).toBeGreaterThan(25);
  });
});

/** Replaces bytes through a shared writer, and removes none. */
function overwritesThroughASharedWriter(file: CensusSource): boolean {
  if (classify(file) !== null) return false;
  return OVERWRITE_CALLS.some((call) =>
    new RegExp(String.raw`\b${call}\s*\(`).test(file.views.code),
  );
}

describe("the census can fail", () => {
  /**
   * Run the real census over the real tree plus one synthetic module.
   * The real tree's rows are the ones the suite already computed, so a
   * fixture measures the intruder rather than re-lexing 300 files.
   */
  function unaccountedWith(intruder: CensusFile): string[] {
    return [...ROWS, ...census([lexed(intruder)])]
      .filter((row) => row.ungatedCalls.length > 0 && !(row.path in DESTRUCTIVE_SITES))
      .map((row) => row.path);
  }

  /**
   * Every source shape a removal can arrive in. Each must be reported on
   * its own: a detector that saw only the first `node:fs` statement, in
   * the one binding form and the one quote style, would leave these
   * unreachable by construction and still report a clean sweep.
   *
   * The last six are the reviewer's, reproduced verbatim in shape. All
   * of them typecheck, which is why "no real module writes it that way"
   * was never an answer.
   */
  const INTRUDER_SHAPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
    ["a plain named import", 'import { unlinkSync } from "node:fs";\nunlinkSync("x");\n'],
    [
      "a second `node:fs` import statement",
      'import { readFileSync } from "node:fs";\nimport { rmSync } from "node:fs";\nrmSync("x");\n',
    ],
    ["a renamed binding", 'import { unlinkSync as drop } from "node:fs";\ndrop("x");\n'],
    ["a namespace import", 'import * as fs from "node:fs";\nfs.renameSync("a", "b");\n'],
    ["the promise API", 'import { rm } from "node:fs/promises";\nawait rm("x");\n'],
    ["a single-quoted specifier", "import { rmSync } from 'node:fs';\nrmSync('x');\n"],
    ["a default import", 'import fs from "node:fs";\nfs.rmSync("x");\n'],
    [
      "a default import beside a named one",
      'import fs, { readFileSync } from "node:fs";\nvoid readFileSync;\nfs.unlinkSync("x");\n',
    ],
    [
      "the promises member of node:fs",
      'import { promises as fsp } from "node:fs";\nawait fsp.rm("x");\n',
    ],
    [
      "the promises member of a namespace",
      'import * as fs from "node:fs";\nawait fs.promises.rm("x");\n',
    ],
    ["the bare `fs` specifier", 'import { rmSync } from "fs";\nrmSync("x");\n'],
    [
      "a dynamic import with destructuring",
      'const { rmSync } = await import("node:fs");\nrmSync("x");\n',
    ],
    [
      "a dynamic import bound as a namespace",
      'const fs = await import("node:fs");\nfs.rmSync("x");\n',
    ],
    [
      "a computed member on a namespace",
      'import * as fs from "node:fs";\nconst call = "rmSync";\nfs[call]("x");\n',
    ],
    [
      "a removal after a regex holding an unbalanced quote",
      'import { rmSync } from "node:fs";\nconst q = /["]/;\nvoid q;\nrmSync("x");\n',
    ],
  ]);

  for (const [shape, source] of INTRUDER_SHAPES) {
    test(`a new removal site using ${shape} is reported unaccounted`, () => {
      const path = "src/core/brain/synthetic-intruder.ts";
      expect(unaccountedWith({ path, text: source })).toEqual([path]);
    });
  }

  test("a module the tree walk must not skip by extension", () => {
    // `probe.mts` ran, removed files, and was invisible because the walk
    // filtered on `.ts`. Asserted on the WALK rather than on `classify`,
    // because the walk is where the bypass lived.
    const names = new Set(BRAIN_TREE.map((file) => file.path));
    expect(names.size).toBe(BRAIN_TREE.length);
    for (const ext of MODULE_EXTENSIONS) {
      const path = `src/core/brain/zzsub/probe${ext}`;
      const text = 'import { rmSync } from "node:fs";\nrmSync("x");\n';
      expect(unaccountedWith({ path, text })).toEqual([path]);
    }
  });

  test("a new unlinkSync added to an already-declared module is reported as drift", () => {
    // The other half of the guarantee: a module already in the registry
    // must not be able to absorb a NEW kind of removal under the reason
    // written for the old one.
    const path = "src/core/brain/exact-state.ts";
    const declared = DESTRUCTIVE_SITES[path];
    expect(declared?.calls).toEqual(["rmSync"]);
    const withExtra = classify({
      path,
      text: 'import { rmSync, unlinkSync } from "node:fs";\nrmSync("x");\nunlinkSync("y");\n',
    });
    expect(withExtra?.ungatedCalls).toEqual(["rmSync", "unlinkSync"]);
    expect(withExtra?.ungatedCalls.join(",") === declared?.calls.join(",")).toBe(false);
  });

  test("a type-only fs import is not a removal site", () => {
    // The complement of the import gate: naming a type removes nothing,
    // and counting it would put every module annotating a `Dirent` here.
    expect(
      classify({
        path: "src/core/brain/synthetic-types-only.ts",
        text: 'import type { RmOptions } from "node:fs";\nexport type T = RmOptions;\n',
      }),
    ).toBeNull();
  });

  test("an inline type specifier is not a removal site either", () => {
    expect(
      classify({
        path: "src/core/brain/synthetic-inline-type.ts",
        text: 'import { type RmOptions } from "node:fs";\nexport type T = RmOptions;\n',
      }),
    ).toBeNull();
  });

  test("a removal named only inside a string or a comment is not a site", () => {
    // The other direction of the lexer: it must not INVENT sites, or the
    // registry fills with entries for prose.
    expect(
      classify({
        path: "src/core/brain/synthetic-mentions.ts",
        text:
          'import { readFileSync } from "node:fs";\n' +
          "// rmSync(x) is what this module deliberately does not do\n" +
          'export const doc = "unlinkSync(p)";\n' +
          "void readFileSync;\n",
      }),
    ).toBeNull();
  });

  test("a gated intruder is accounted for without a declaration", () => {
    // The gate really is the alternative, not a second requirement.
    const path = "src/core/brain/synthetic-gated.ts";
    const text =
      'import { rmSync } from "node:fs";\n' +
      'import { withDestructiveSnapshot } from "./snapshot-gate.ts";\n' +
      'withDestructiveSnapshot(v, r, () => rmSync("x"));\n';
    expect(unaccountedWith({ path, text })).toEqual([]);
  });

  test("a removal OUTSIDE the gate in a gated module is still reported", () => {
    // The per-file boolean this replaced: one `withDestructiveSnapshot(`
    // anywhere in the file exempted every removal in it.
    const path = "src/core/brain/synthetic-half-gated.ts";
    const text =
      'import { rmSync, unlinkSync } from "node:fs";\n' +
      'import { withDestructiveSnapshot } from "./snapshot-gate.ts";\n' +
      'withDestructiveSnapshot(v, r, () => rmSync("x"));\n' +
      "export function elsewhere(p: string): void {\n  unlinkSync(p);\n}\n";
    const row = classify({ path, text });
    expect(row?.gatedCalls).toEqual(["rmSync"]);
    expect(row?.ungatedCalls).toEqual(["unlinkSync"]);
    expect(unaccountedWith({ path, text })).toEqual([path]);
  });

  test("a gate named only in a comment gates nothing", () => {
    const path = "src/core/brain/synthetic-comment-gate.ts";
    const text =
      'import { rmSync } from "node:fs";\n' +
      "// This module is reached from withDestructiveSnapshot(vault, reason, op).\n" +
      "export function sweep(p: string): void {\n  rmSync(p);\n}\n";
    expect(classify({ path, text })?.ungatedCalls).toEqual(["rmSync"]);
    expect(unaccountedWith({ path, text })).toEqual([path]);
  });

  test("a function handed to the gate BY NAME is not lexically gated", () => {
    // The deliberate strictness, pinned so it is a decision rather than
    // an accident: `source-cleanup.ts` is this shape, and it declares.
    const path = "src/core/brain/synthetic-by-reference.ts";
    const text =
      'import { rmSync } from "node:fs";\n' +
      'import { withDestructiveSnapshot } from "./snapshot-gate.ts";\n' +
      'const op = (): void => rmSync("x");\n' +
      "withDestructiveSnapshot(v, r, op);\n";
    expect(classify({ path, text })?.ungatedCalls).toEqual(["rmSync"]);
  });

  test("the overwrite class is large, which is why the rule stops at removals", () => {
    // The measurement behind the narrowing in this file's header. These
    // modules replace bytes they themselves authored; adding them would
    // roughly quadruple the registry and force a reason per entry that
    // no one could write honestly.
    const overwriteOnly = BRAIN_TREE.filter(overwritesThroughASharedWriter);
    expect(overwriteOnly.length).toBeGreaterThan(50);
    expect(overwriteOnly.length).toBeGreaterThan(ROWS.length);
  });

  test("the overwrite class is unheld by either census", () => {
    // The falsified claim, kept as a measurement so it cannot quietly
    // revert to "already held". A module that overwrites THROUGH a
    // shared writer is compliant in the write-site census, which
    // registers only the sites that bypass one, and it removes nothing,
    // so it is out of population here. Both censuses are silent about
    // it, and this asserts that the set is non-empty rather than naming
    // a file whose fate belongs to another unit.
    const unheld = BRAIN_TREE.filter(overwritesThroughASharedWriter)
      .filter((file) => !WRITE_SITE_CENSUS.includes(file.path))
      .map((file) => file.path);
    expect(unheld.length).toBeGreaterThan(0);
  });
});

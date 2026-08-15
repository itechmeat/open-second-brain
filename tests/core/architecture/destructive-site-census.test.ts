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
 * ## The narrowing, stated rather than hidden
 *
 * The design's population rule also named "an atomic write in overwrite
 * mode". That clause is NOT in the rule below, and the reason is
 * measured rather than asserted: `the overwrite class is large` at the
 * bottom of this file counts the modules it would add. An atomic
 * overwrite replaces bytes the same module authored and can regenerate;
 * a removal is the case where the bytes are gone and no producer will
 * emit them again. Every overwrite site is already held, categorised,
 * by the write-site census. Widening this population would have meant
 * writing filler reasons for the difference, and a filler reason is
 * worse than no census.
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
  REMOVAL_CALLS,
} from "../../../src/core/brain/destructive-sites.ts";
import {
  isRecoverabilityBlocker,
  isRecoveryCoverage,
  RECOVERABILITY_STATE,
} from "../../../src/core/brain/gates/recoverability.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BRAIN_ROOT = join(REPO_ROOT, "src", "core", "brain");

/** The gate a site routes through instead of declaring its own story. */
const GATE_CALL = "withDestructiveSnapshot";

/**
 * The shared writers whose presence marks the overwrite class. Used only
 * by the narrowing measurement at the bottom - never by the population.
 */
const OVERWRITE_CALLS: ReadonlyArray<string> = Object.freeze([
  "atomicWriteFileSync",
  "atomicWriteText",
  "writeFrontmatterAtomic",
]);

/**
 * Every `node:fs` / `node:fs/promises` import statement, in both binding
 * forms and both quote styles. GLOBAL, so a module's SECOND statement is
 * read too. `import type` does not match - a type cannot be called.
 */
const FS_IMPORT_RE =
  /import\s*(?:\*\s*as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*from\s*["']node:fs(?:\/promises)?["']/g;

/** Longest name first, so a prefix cannot shadow the longer name after it. */
function alternation(names: ReadonlyArray<string>): string {
  return [...names].toSorted((a, b) => b.length - a.length).join("|");
}

function callRe(names: ReadonlyArray<string>): RegExp {
  return new RegExp(String.raw`\b(${alternation(names)})\s*\(`, "g");
}

interface CensusFile {
  readonly path: string;
  readonly text: string;
}

interface CensusRow {
  readonly path: string;
  /** Removal calls this file makes directly, by their `node:fs` name. */
  readonly calls: ReadonlyArray<string>;
  /** Whether the module routes through the destructive gate. */
  readonly gated: boolean;
}

/** Every `.ts` file under `src/core/brain/`, at any depth, path + text. */
function readBrainTree(): CensusFile[] {
  const files: CensusFile[] = [];
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
  walk(BRAIN_ROOT);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

interface FsImports {
  /** Local binding -> the `node:fs` name it was imported under. */
  readonly bindings: ReadonlyMap<string, string>;
  /** Local names of namespace imports, e.g. `fs` in `import * as fs`. */
  readonly namespaces: ReadonlySet<string>;
}

function fsImports(text: string): FsImports {
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const match of text.matchAll(FS_IMPORT_RE)) {
    const namespace = match[1];
    if (namespace !== undefined) {
      namespaces.add(namespace);
      continue;
    }
    for (const raw of match[2]!.split(",")) {
      const [imported, local] = raw
        .trim()
        .split(/\s+as\s+/)
        .map((part) => part.trim());
      if (imported === undefined || imported.length === 0) continue;
      bindings.set(local !== undefined && local.length > 0 ? local : imported, imported);
    }
  }
  return { bindings, namespaces };
}

const REMOVAL_SET: ReadonlySet<string> = new Set(REMOVAL_CALLS);

/** The removal calls this module makes directly, by their `node:fs` name. */
function removalCalls(text: string, imported: FsImports): Set<string> {
  const direct = new Set<string>();
  const locals = [...imported.bindings.keys()];
  if (locals.length > 0) {
    for (const match of text.matchAll(callRe(locals))) {
      const name = imported.bindings.get(match[1]!.replace(/\s+/g, ""));
      if (name !== undefined && REMOVAL_SET.has(name)) direct.add(name);
    }
  }
  for (const namespace of imported.namespaces) {
    const re = new RegExp(
      String.raw`\b${namespace}\s*\.\s*(${alternation(REMOVAL_CALLS)})\s*\(`,
      "g",
    );
    for (const match of text.matchAll(re)) direct.add(match[1]!.replace(/\s+/g, ""));
  }
  return direct;
}

function classify(file: CensusFile): CensusRow | null {
  const calls = removalCalls(file.text, fsImports(file.text));
  if (calls.size === 0) return null;
  return {
    path: file.path,
    calls: [...calls].toSorted(),
    gated: new RegExp(String.raw`\b${GATE_CALL}\s*\(`).test(file.text),
  };
}

function census(files: ReadonlyArray<CensusFile>): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const file of files) {
    const row = classify(file);
    if (row !== null) rows.push(row);
  }
  return rows;
}

const BRAIN_TREE = readBrainTree();
const ROWS = census(BRAIN_TREE);

describe("destructive-site census", () => {
  test("every removal site is routed through the gate or declares its recovery", () => {
    const unaccounted = ROWS.filter((row) => !row.gated && !(row.path in DESTRUCTIVE_SITES)).map(
      (row) => `${row.path} [${row.calls.join(",")}]`,
    );
    // Named, not counted: the failure has to say which file.
    expect(unaccounted).toEqual([]);
  });

  test("a gated site does not also carry a declaration", () => {
    // Two answers to one question is the drift this census exists to
    // stop: the gate would move and the entry would stay, saying
    // something about a routing that no longer exists.
    const both = ROWS.filter((row) => row.gated && row.path in DESTRUCTIVE_SITES).map(
      (row) => row.path,
    );
    expect(both).toEqual([]);
  });

  test("no declaration outlives the site it accounts for", () => {
    const present = new Set(ROWS.filter((row) => !row.gated).map((row) => row.path));
    const stale = Object.keys(DESTRUCTIVE_SITES).filter((path) => !present.has(path));
    expect(stale).toEqual([]);
  });

  test("each declaration names exactly the calls its site makes", () => {
    // A new KIND of removal inside an already-declared module is a new
    // decision, not one the existing argument already covered.
    const drifted: string[] = [];
    for (const row of ROWS) {
      const entry = DESTRUCTIVE_SITES[row.path];
      if (entry === undefined) continue;
      if (entry.calls.join(",") !== row.calls.join(",")) {
        drifted.push(
          `${row.path}: declared [${entry.calls.join(",")}] found [${row.calls.join(",")}]`,
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
    expect(ROWS.filter((row) => row.gated).length).toBeGreaterThan(1);
    expect(Object.keys(DESTRUCTIVE_SITES).length).toBeGreaterThan(25);
  });
});

describe("the census can fail", () => {
  /** Run the real census over the real tree plus one synthetic module. */
  function unaccountedWith(intruder: CensusFile): string[] {
    return census([...BRAIN_TREE, intruder])
      .filter((row) => !row.gated && !(row.path in DESTRUCTIVE_SITES))
      .map((row) => row.path);
  }

  /**
   * Every source shape a removal can arrive in. Each must be reported on
   * its own: a detector that saw only the first `node:fs` statement, in
   * the one binding form and the one quote style, would leave these
   * unreachable by construction and still report a clean sweep.
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
  ]);

  for (const [shape, source] of INTRUDER_SHAPES) {
    test(`a new removal site using ${shape} is reported unaccounted`, () => {
      const path = "src/core/brain/synthetic-intruder.ts";
      expect(unaccountedWith({ path, text: source })).toEqual([path]);
    });
  }

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
    expect(withExtra?.calls).toEqual(["rmSync", "unlinkSync"]);
    expect(withExtra?.calls.join(",") === declared?.calls.join(",")).toBe(false);
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

  test("a gated intruder is accounted for without a declaration", () => {
    // The gate really is the alternative, not a second requirement.
    const path = "src/core/brain/synthetic-gated.ts";
    const text =
      'import { rmSync } from "node:fs";\n' +
      'import { withDestructiveSnapshot } from "./snapshot-gate.ts";\n' +
      'withDestructiveSnapshot(v, r, () => rmSync("x"));\n';
    expect(unaccountedWith({ path, text })).toEqual([]);
  });

  test("the overwrite class is large, which is why the rule stops at removals", () => {
    // The measurement behind the narrowing in this file's header. These
    // modules replace bytes they themselves authored; adding them would
    // roughly quadruple the registry and force a reason per entry that
    // no one could write honestly.
    const overwriteOnly = BRAIN_TREE.filter((file) => classify(file) === null).filter((file) =>
      OVERWRITE_CALLS.some((call) => new RegExp(String.raw`\b${call}\s*\(`).test(file.text)),
    );
    expect(overwriteOnly.length).toBeGreaterThan(50);
    expect(overwriteOnly.length).toBeGreaterThan(ROWS.length);
  });
});

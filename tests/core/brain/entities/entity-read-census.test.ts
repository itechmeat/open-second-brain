/**
 * Entity read-path census (provenance-at-the-boundary, unit A).
 *
 * A quarantine that nothing filters on is a no-op. This repository reverted
 * a unit in the previous release for shipping a layer that could never fire,
 * and the same failure mode is available here for free: the `active` filter
 * used to be re-implemented at every caller, eight callers applied none at
 * all, and a third status value would have read as "not archived, therefore
 * visible" at every one of them. Centralising the filter is what makes
 * `quarantine` mean something; this census is what keeps it centralised.
 *
 * Four ways a module can reach an entity record, so four rules over one
 * exclusion inventory. Each rule reaches modules no other rule reaches -
 * asserted below, because a rule whose members are all already caught by
 * another rule is a decision layer that never decides, and deleting it
 * would change no outcome.
 *
 *   1. It builds the index itself (`buildEntityIndex` / `parseEntityFile`)
 *      and reads the records out.
 *   2. It decides on the status of records handed to it - visible either as
 *      a call to the shared predicate, or as a comparison between a
 *      `status`-named expression and the entity status vocabulary.
 *   3. It asks the registry's list API (`listEntities`). That API has a
 *      deliberate bypass: an explicit `{ status }` is honoured verbatim and
 *      skips the shared predicate entirely, which is how an operator sees
 *      what is quarantined - and is also exactly how a machine read path
 *      would re-implement the filter by accident. `query-expansion.ts` did
 *      precisely that (`{ status: "active" }`) and matched no rule at all
 *      before this one existed.
 *   4. It walks vault PAGES inside the link-graph tree. `Brain/entities/**`
 *      are ordinary Markdown pages, so a walker that never touches the
 *      registry still reads a quarantined record's title, body and links.
 *      A walker is scoped either by the shared page predicate or by
 *      excluding the Brain root from every one of its walks.
 *
 * ## What this census does NOT claim
 *
 * Stated rather than implied, because a bound that lives only in prose is
 * the same defect as a rule that cannot fire:
 *
 *   - Rule 4 covers the link-graph tree, not every `listVaultPages` caller
 *     in the repository. The trees outside it (the freshness scan, the
 *     schema report, the doctor probes, the CLI page listing, the OpenCLAW
 *     adapter) walk pages too and are NOT asserted here. `quarantine` is
 *     absent from every entity read surface this census names; it is not
 *     yet asserted absent from every page-listing surface in the tree.
 *   - Rule 2's literal branch only fires in a module that already names the
 *     entity vocabulary, because `active` and `quarantine` are ALSO
 *     preference statuses and an ungated literal sweeps in four modules
 *     that have nothing to do with entities. The gate errs toward
 *     over-inclusion - `merge.ts` matches rule 2 on a preference status
 *     because it also imports from `entities/` - since a module named twice
 *     costs a line and a filter unseen costs the release.
 *
 * The census is proved capable of failing, below, over fixture modules that
 * bypass the predicate under each rule - the same way the import-cycle
 * ratchet proves its own search is not vacuous.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** Rule 1: the module builds the entity index and reads records out of it. */
const INDEX_READ_RE = /\b(?:buildEntityIndex|parseEntityFile)\s*\(/;

/**
 * Rule 2, literal branch: a `status`-named expression compared against the
 * entity status vocabulary. `quarantine` is IN the vocabulary here - it was
 * absent when this rule shipped, so the one value the release introduced was
 * the one value the rule could not see.
 */
const STATUS_LITERAL_DECISION_RE = new RegExp(
  [
    String.raw`\b\w*[Ss]tatus\w*\s*(?:!==|===)\s*(?:"(?:active|archived|quarantine)"|BRAIN_ENTITY_STATUS\s*\.\s*\w+)`,
    String.raw`BRAIN_ENTITY_STATUS\s*\.\s*\w+\s*(?:!==|===)`,
  ].join("|"),
);

/**
 * The gate on that branch: the module is about ENTITIES rather than about
 * one of the other vocabularies that spell the same words. Preference
 * status, profile names and vault-origin kinds all use `active`, and
 * preference status also uses `quarantine`.
 */
const ENTITY_VOCABULARY_RE =
  /\bBRAIN_ENTITY_STATUS\b|\bBrainEntityStatus\b|\bENTITY_STATUS_SCOPE\b|from\s*"[^"]*\bentities\/[^"]*\.ts"/;

/** Rule 2, predicate branch: deciding on status THROUGH the shared predicate. */
const SHARED_PREDICATE_RE = /\bentityStatusInScope\s*\(/;

/** Rule 3: the registry's list API, whose explicit `{ status }` ask bypasses the scope. */
const REGISTRY_LIST_RE = /(?<!function\s)\blistEntities\s*\(/;

/** Rule 4's population: the link-graph tree, whose walkers reach `Brain/entities/`. */
const LINK_GRAPH_ROOT = "src/core/brain/link-graph/";

/** Rule 4: a walk over vault pages. The declaration itself is not a walk. */
const PAGE_WALK_RE = /(?<!function\s)\blistVaultPages\s*\(/g;

/**
 * A page walk that excludes the Brain root cannot reach an entity page at
 * all, so it is scoped by construction rather than by a predicate. Counted
 * rather than merely detected: a module with two walks, only one of which
 * excludes the Brain root, is not scoped.
 */
const BRAIN_EXCLUDING_WALK_RE =
  /(?<!function\s)\blistVaultPages\s*\([^;]*?skipDirs[^;]*?(?:BRAIN_ROOT_REL|brainDir)/g;

/** A module is scoped when it names the shared predicate or its scopes. */
const SCOPED_RE = /entityStatusInScope|ENTITY_STATUS_SCOPE|vaultPageInStatusScope/;

/**
 * Every entity read path that deliberately does not go through the shared
 * predicate, with the reason. A module may only be here because scoping it
 * would be wrong, never because scoping it was inconvenient.
 */
const UNSCOPED_WITH_REASON: Readonly<Record<string, string>> = Object.freeze({
  "src/core/brain/doctor/entity-checks.ts":
    "registry-integrity surface. It reports duplicate identities and broken " +
    "relation edges over what is STORED; scoping it would stop the doctor " +
    "reporting on exactly the records most likely to be malformed - the ones " +
    "a read path is already hiding.",
  "src/core/brain/entities/label-hygiene.ts":
    "runs the label validator over every stored node (its own docblock says " +
    "'any status'), and the prune pass must see every survivor or it would " +
    "strand inbound edges pointing at a removed node.",
  "src/core/brain/deep-synthesis.ts":
    "hands the whole index to `checkEntityContamination`, which applies the " +
    "shared predicate at its own boundary. A second filter here would be a " +
    "duplicate of that decision, not an independent one.",
  "src/core/brain/merge.ts":
    "hands the whole index to `guardEntityMerge`, which applies the shared " +
    "predicate at its own boundary. It is also in the census under rule 2, on " +
    "a PREFERENCE status comparison - see the docblock on why that branch errs " +
    "toward over-inclusion.",
  "src/cli/brain/verbs/facts.ts":
    "hands the whole index to `decomposeAtomicFacts`, which applies the " +
    "shared predicate at its own boundary.",
  "src/cli/brain/verbs/entity.ts":
    "`brain entity list --status quarantine` IS the named exit from quarantine. " +
    "The explicit ask is the operator asking to see what a read scope hides, it " +
    "is validated against the vocabulary itself before it reaches the registry, " +
    "and scoping it would leave a status nothing can leave - a dead end rather " +
    "than a lane. Without an explicit `--status` this verb takes the registry's " +
    "predicate-applying branch like every other caller.",
  "src/mcp/brain/entity-tools.ts":
    "the MCP twin of that verb: `brain_entity` with an explicit `status` is the " +
    "agent-facing form of the same operator ask, validated against the same " +
    "vocabulary. Its `get` view resolves through `getEntity`, which applies the " +
    "canonical scope inside the registry.",
});

interface CensusRow {
  readonly path: string;
  /** Rule 1. */
  readonly buildsIndex: boolean;
  /** Rule 2. */
  readonly decidesOnStatus: boolean;
  /** Rule 3. */
  readonly asksRegistry: boolean;
  /** Rule 4. */
  readonly walksPages: boolean;
  readonly scoped: boolean;
}

function tsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) out.push(abs);
    }
  };
  walk(root);
  return out;
}

function matchCount(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

/** Classify a set of modules. Parameterised on the file list so the
 * non-vacuity tests below can run the identical classifier over fixtures. */
function censusOver(files: ReadonlyArray<string>, root: string): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const path = relative(root, file).split("\\").join("/");
    const walks = matchCount(text, PAGE_WALK_RE);
    const walksPages = path.startsWith(LINK_GRAPH_ROOT) && walks > 0;
    const buildsIndex = INDEX_READ_RE.test(text);
    const decidesOnStatus =
      SHARED_PREDICATE_RE.test(text) ||
      (ENTITY_VOCABULARY_RE.test(text) && STATUS_LITERAL_DECISION_RE.test(text));
    const asksRegistry = REGISTRY_LIST_RE.test(text);
    if (!buildsIndex && !decidesOnStatus && !asksRegistry && !walksPages) continue;
    // A walk that never reaches `Brain/` cannot see an entity page, which is
    // a stronger guarantee than filtering one out.
    const brainRootExcluded = walks > 0 && matchCount(text, BRAIN_EXCLUDING_WALK_RE) === walks;
    rows.push({
      path,
      buildsIndex,
      decidesOnStatus,
      asksRegistry,
      walksPages,
      scoped: SCOPED_RE.test(text) || (walksPages && brainRootExcluded),
    });
  }
  return rows;
}

/**
 * The census over the real tree, computed once. Every assertion below reads
 * the SAME rows, and the whole-tree walk is not repeated per test.
 */
let realCensus: CensusRow[] | null = null;
function census(): CensusRow[] {
  realCensus ??= censusOver(tsFiles(SRC_ROOT), REPO_ROOT);
  return realCensus;
}

/** The rules, by the row field each sets. Used by the no-dead-rule assertions. */
const RULES = Object.freeze({
  buildsIndex: "buildsIndex",
  decidesOnStatus: "decidesOnStatus",
  asksRegistry: "asksRegistry",
  walksPages: "walksPages",
} as const);

type RuleField = (typeof RULES)[keyof typeof RULES];

const RULE_FIELDS: ReadonlyArray<RuleField> = Object.freeze(Object.values(RULES));

/** Rows this rule reaches that no other rule reaches. */
function exclusiveTo(rows: ReadonlyArray<CensusRow>, rule: RuleField): string[] {
  return rows
    .filter((row) => row[rule] && RULE_FIELDS.every((other) => other === rule || !row[other]))
    .map((row) => row.path);
}

describe("entity read-path census", () => {
  test("every entity read path is scoped by the shared predicate or excluded with a reason", () => {
    const unscoped = census()
      .filter((row) => !row.scoped)
      .map((row) => row.path);
    // Named, not counted: the failure message is the file list.
    expect(unscoped.toSorted()).toEqual(Object.keys(UNSCOPED_WITH_REASON).toSorted());
  });

  test("no exclusion outlives the module it excuses", () => {
    const seen = new Set(census().map((row) => row.path));
    for (const excluded of Object.keys(UNSCOPED_WITH_REASON)) {
      expect(seen.has(excluded)).toBe(true);
    }
  });

  test("the search ran over the real tree, not an empty one", () => {
    const rows = census();
    // Floors just under the measurement, so "everything is scoped" cannot be
    // reported over a file list that was never built, and so a real loss of
    // input cannot pass underneath. Today: 22 rows, 10 building the index,
    // 15 scoped. The previous floors (5 index readers against a measured 10)
    // would have let half the population vanish and still read as healthy.
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((row) => row.buildsIndex).length).toBeGreaterThan(9);
    expect(rows.filter((row) => row.scoped).length).toBeGreaterThan(14);
  });

  test("no rule is dead: each reaches modules no other rule reaches", () => {
    // The assertion the previous shape of this file got wrong. It proved
    // rule 2 "alive" by naming a module rule 1 already caught, so deleting
    // rule 2 outright would have changed no outcome. What makes a rule load
    // bearing is the modules ONLY it sees.
    const rows = census();
    for (const rule of RULE_FIELDS) {
      expect(`${rule}: ${exclusiveTo(rows, rule).length > 0}`).toBe(`${rule}: true`);
    }
  });

  test("the modules each rule alone reaches are the ones the rule was written for", () => {
    const rows = census();
    // Rule 3 exists because the registry's explicit-status branch bypasses
    // the predicate, and these two surfaces are its only legitimate users.
    expect(exclusiveTo(rows, RULES.asksRegistry).toSorted()).toEqual([
      "src/cli/brain/verbs/entity.ts",
      "src/mcp/brain/entity-tools.ts",
    ]);
    // Rule 4 exists because entity pages are ordinary vault pages. None of
    // these four touches the registry, so rule 4 is the ONLY rule that sees
    // them - which is exactly why the leak they carried was invisible.
    expect(exclusiveTo(rows, RULES.walksPages).toSorted()).toEqual([
      "src/core/brain/link-graph/bridge-discovery.ts",
      "src/core/brain/link-graph/co-occurrence.ts",
      "src/core/brain/link-graph/graph-holdout.ts",
      "src/core/brain/link-graph/repair-lane.ts",
    ]);
    // Rule 2 exists for modules handed entity-shaped records by a caller;
    // they never build an index and never call the registry.
    expect(exclusiveTo(rows, RULES.decidesOnStatus)).toContain(
      "src/core/brain/truth/contamination.ts",
    );
  });

  test("the registry is in the census under three rules, so its own read API is watched", () => {
    // The registry owns the decision: it builds the index, it names the
    // status vocabulary, and it defines the list API rule 3 watches. If the
    // census could not see the module that OWNS the decision, it is
    // measuring the wrong tree and every verdict above is meaningless.
    const registry = census().find((row) => row.path === "src/core/brain/entities/registry.ts");
    expect(registry).toBeDefined();
    expect(registry!.buildsIndex).toBe(true);
    expect(registry!.decidesOnStatus).toBe(true);
    expect(registry!.scoped).toBe(true);
  });

  test("the link-graph walkers that reach Brain/entities are all scoped", () => {
    // The concrete leak this unit closed, pinned by name: three walkers read
    // page titles, bodies and links straight out of `Brain/entities/` with no
    // status filter at all, and the census could not see them because they
    // never touch `buildEntityIndex`.
    const rows = census().filter((row) => row.walksPages);
    expect(rows.map((row) => row.path).toSorted()).toEqual([
      "src/core/brain/link-graph/bridge-discovery.ts",
      "src/core/brain/link-graph/co-occurrence.ts",
      "src/core/brain/link-graph/graph-holdout.ts",
      "src/core/brain/link-graph/repair-lane.ts",
    ]);
    expect(rows.filter((row) => !row.scoped).map((row) => row.path)).toEqual([]);
  });
});

describe("the census can fail", () => {
  /** Write fixture modules and run the real classifier over them. */
  function classifyFixtures(fixtures: Readonly<Record<string, string>>): CensusRow[] {
    const dir = mkdtempSync(join(tmpdir(), "o2b-entity-census-"));
    try {
      const files = Object.entries(fixtures).map(([name, source]) => {
        const path = join(dir, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, source, "utf8");
        return path;
      });
      return censusOver(files, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const BYPASSING_INDEX_READER = [
    'import { buildEntityIndex } from "./index-builder.ts";',
    "export function surfaceEntities(vault: string) {",
    "  return buildEntityIndex(vault).entities;",
    "}",
    "",
  ].join("\n");

  const BYPASSING_STATUS_DECIDER = [
    'import { normalizeEntityName } from "./entities/canonical.ts";',
    "export function anchor(entities: ReadonlyArray<{ status: string; name: string }>) {",
    '  return entities.filter((e) => e.status !== "quarantine").map((e) => normalizeEntityName(e.name));',
    "}",
    "",
  ].join("\n");

  const BYPASSING_REGISTRY_ASK = [
    'import { listEntities } from "./entities/registry.ts";',
    "export function anchors(vault: string) {",
    '  return listEntities(vault, { status: "active" }).map((e) => e.name);',
    "}",
    "",
  ].join("\n");

  const LINK_GRAPH_WALKER = `${LINK_GRAPH_ROOT}rogue-walker.ts`;
  const BYPASSING_PAGE_WALKER = [
    'import { EXCLUDED_DIRS, listVaultPages } from "../../../vault.ts";',
    "export function titles(vault: string) {",
    "  return listVaultPages(vault, { skipDirs: [...EXCLUDED_DIRS] }).map((p) => p.title);",
    "}",
    "",
  ].join("\n");

  const SCOPED_READER = [
    'import { buildEntityIndex } from "./index-builder.ts";',
    'import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "./status-scope.ts";',
    "export function surfaceEntities(vault: string) {",
    "  return buildEntityIndex(vault).entities.filter((e) =>",
    "    entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.readable),",
    "  );",
    "}",
    "",
  ].join("\n");

  test("a new read path that builds the index without the predicate is caught", () => {
    const rows = classifyFixtures({ "rogue-index-reader.ts": BYPASSING_INDEX_READER });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.buildsIndex).toBe(true);
    expect(rows[0]!.scoped).toBe(false);
  });

  test("a new read path that re-implements the status filter is caught", () => {
    const rows = classifyFixtures({ "rogue-status-decider.ts": BYPASSING_STATUS_DECIDER });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decidesOnStatus).toBe(true);
    expect(rows[0]!.scoped).toBe(false);
  });

  test("a status filter naming `quarantine` is caught - the value this release added", () => {
    // The literal was absent from the vocabulary when the rule shipped, so
    // the one status the release introduced was invisible to the rule meant
    // to police it. The fixture above compares against `quarantine` alone.
    expect(STATUS_LITERAL_DECISION_RE.test(BYPASSING_STATUS_DECIDER)).toBe(true);
    const withoutQuarantine = new RegExp(
      String.raw`\b\w*[Ss]tatus\w*\s*(?:!==|===)\s*"(?:active|archived)"`,
    );
    expect(withoutQuarantine.test(BYPASSING_STATUS_DECIDER)).toBe(false);
  });

  test("a new read path that takes the registry's explicit-status bypass is caught", () => {
    const rows = classifyFixtures({ "rogue-registry-ask.ts": BYPASSING_REGISTRY_ASK });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.asksRegistry).toBe(true);
    expect(rows[0]!.buildsIndex).toBe(false);
    expect(rows[0]!.scoped).toBe(false);
  });

  test("a new link-graph walker that reaches Brain/entities unfiltered is caught", () => {
    const rows = classifyFixtures({ [LINK_GRAPH_WALKER]: BYPASSING_PAGE_WALKER });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.walksPages).toBe(true);
    expect(rows[0]!.scoped).toBe(false);
  });

  test("a link-graph walker that excludes the Brain root is scoped by construction", () => {
    const rows = classifyFixtures({
      [LINK_GRAPH_WALKER]: BYPASSING_PAGE_WALKER.replace(
        "[...EXCLUDED_DIRS]",
        "[...EXCLUDED_DIRS, BRAIN_ROOT_REL]",
      ),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.walksPages).toBe(true);
    expect(rows[0]!.scoped).toBe(true);
  });

  test("a page walker outside the link-graph tree is out of rule 4's population", () => {
    // The bound stated in the docblock, asserted rather than described: the
    // census does not claim to cover every `listVaultPages` caller.
    const rows = classifyFixtures({ "elsewhere/rogue-walker.ts": BYPASSING_PAGE_WALKER });
    expect(rows).toEqual([]);
  });

  test("a read path that uses the predicate is not flagged", () => {
    const rows = classifyFixtures({ "scoped-reader.ts": SCOPED_READER });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scoped).toBe(true);
  });

  test("a module that touches no entity record is not in the census at all", () => {
    const rows = classifyFixtures({
      "unrelated.ts": 'export const NAME = "active";\nexport const K = 1;\n',
    });
    expect(rows).toEqual([]);
  });

  test("a preference status comparison alone is not an entity read", () => {
    // Both vocabularies spell `active` and `quarantine`. Without the entity
    // gate, rule 2 sweeps in the digest, the epistemic ladder and the MCP
    // resource index, none of which touch an entity record.
    const rows = classifyFixtures({
      "preference-surface.ts": [
        'import { BRAIN_PREFERENCE_STATUS } from "./preference.ts";',
        "export function quarantined(prefs: ReadonlyArray<{ status: string }>) {",
        '  return prefs.filter((p) => p.status === "quarantine").length;',
        "}",
        "",
      ].join("\n"),
    });
    expect(rows).toEqual([]);
  });

  test("the assertion the census makes fails when a bypassing path is present", () => {
    // The verdict itself, not just the classification: an unscoped module
    // that is not in the exclusion inventory makes the top-level assertion
    // fail. Without this, a classifier that worked over a list nobody
    // asserted against would still look healthy.
    const rows = classifyFixtures({
      "rogue-index-reader.ts": BYPASSING_INDEX_READER,
      "scoped-reader.ts": SCOPED_READER,
    });
    const unscoped = rows.filter((row) => !row.scoped).map((row) => row.path);
    expect(unscoped).toEqual(["rogue-index-reader.ts"]);
    expect(() => expect(unscoped.toSorted()).toEqual([])).toThrow();
  });
});

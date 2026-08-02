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
 * Two ways a module can obtain entity records, so two rules over one
 * exclusion inventory:
 *
 *   1. It builds the index itself (`buildEntityIndex` / `parseEntityFile`)
 *      and reads the records out. Every such module either names the shared
 *      predicate or carries a written reason for not needing it.
 *   2. It is handed entity-shaped records by a caller and decides on their
 *      status - visible as a comparison between a `status`-named expression
 *      and a member of the entity status vocabulary. Same rule.
 *
 * The boundary is honest about what it does not see: a module handed entity
 * records that filters on a value it never names `status` is outside rule 2,
 * and is caught by rule 1 only if it also builds the index. That is why both
 * rules run rather than either alone.
 *
 * The census is proved capable of failing, below, over fixture modules that
 * bypass the predicate - the same way the import-cycle ratchet proves its
 * own search is not vacuous.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** Rule 1: the module builds the entity index and reads records out of it. */
const INDEX_READ_RE = /\b(?:buildEntityIndex|parseEntityFile)\s*\(/;

/**
 * Rule 2: the module compares a `status`-named expression to a member of the
 * entity status vocabulary, or compares that vocabulary to anything. Anchored
 * on the vocabulary rather than on the bare word so a preference status, a
 * profile name, or a vault-origin kind that happens to spell `"active"` is
 * not swept in - those are different vocabularies with different rules.
 */
const STATUS_DECISION_RE = new RegExp(
  [
    String.raw`\b\w*[Ss]tatus\w*\s*(?:!==|===)\s*(?:"(?:active|archived)"|BRAIN_ENTITY_STATUS\s*\.\s*\w+)`,
    String.raw`BRAIN_ENTITY_STATUS\s*\.\s*\w+\s*(?:!==|===)`,
  ].join("|"),
);

/** A module is scoped when it names the shared predicate or its scopes. */
const SCOPED_RE = /entityStatusInScope|ENTITY_STATUS_SCOPE/;

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
    "predicate at its own boundary.",
  "src/cli/brain/verbs/facts.ts":
    "hands the whole index to `decomposeAtomicFacts`, which applies the " +
    "shared predicate at its own boundary.",
});

interface CensusRow {
  readonly path: string;
  readonly buildsIndex: boolean;
  readonly decidesOnStatus: boolean;
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

/** Classify a set of modules. Parameterised on the file list so the
 * non-vacuity tests below can run the identical classifier over fixtures. */
function censusOver(files: ReadonlyArray<string>, root: string): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const buildsIndex = INDEX_READ_RE.test(text);
    const decidesOnStatus = STATUS_DECISION_RE.test(text);
    if (!buildsIndex && !decidesOnStatus) continue;
    rows.push({
      path: relative(root, file).split("\\").join("/"),
      buildsIndex,
      decidesOnStatus,
      scoped: SCOPED_RE.test(text),
    });
  }
  return rows;
}

const census = (): CensusRow[] => censusOver(tsFiles(SRC_ROOT), REPO_ROOT);

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
    // Floors under the measurement, so "everything is scoped" cannot be
    // reported over a file list that was never built. Ten modules read the
    // index today and five of them go through the predicate; a glob that
    // stopped seeing `src/core/brain/entities/` crosses both.
    expect(rows.filter((row) => row.buildsIndex).length).toBeGreaterThan(5);
    expect(rows.filter((row) => row.scoped).length).toBeGreaterThan(4);
  });

  test("the registry is in the census under BOTH rules, so neither is dead", () => {
    // Counting is no evidence for rule 2: centralisation is what makes the
    // status vocabulary rare, and after it the registry is the module that
    // legitimately still names one (the write side chooses a status, and
    // the identity-holder lookup names the one outside every read scope).
    // If the census could not see the module that OWNS the decision, it is
    // measuring the wrong tree and every verdict above is meaningless.
    const registry = census().find((row) => row.path === "src/core/brain/entities/registry.ts");
    expect(registry).toBeDefined();
    expect(registry!.buildsIndex).toBe(true);
    expect(registry!.decidesOnStatus).toBe(true);
    expect(registry!.scoped).toBe(true);
  });
});

describe("the census can fail", () => {
  /** Write fixture modules and run the real classifier over them. */
  function classifyFixtures(fixtures: Readonly<Record<string, string>>): CensusRow[] {
    const dir = mkdtempSync(join(tmpdir(), "o2b-entity-census-"));
    try {
      const files = Object.entries(fixtures).map(([name, source]) => {
        const path = join(dir, name);
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
    "export function anchor(entities: ReadonlyArray<{ status: string; id: string }>) {",
    '  return entities.filter((e) => e.status !== "active").map((e) => e.id);',
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

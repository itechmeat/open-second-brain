/**
 * Link-type endpoint constraints (t_15453235): the schema pack's
 * `link_constraints` field declares allowed (source_type, target_type)
 * pairs per link type; the indexer's materialization post-pass marks
 * violating typed edges blocked - they fall back to plain untyped
 * links instead of participating in typed-relation recall - and the
 * flags recompute from the current pack on every index run, so
 * removing a constraint restores the edges without touching files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { buildSchemaLint } from "../../../src/core/brain/schema-admin.ts";
import { linkConstraintAllows } from "../../../src/core/search/link-constraints.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const CONSTRAINTS = Object.freeze({
  depends_on: Object.freeze(["preference->preference"]),
});

describe("linkConstraintAllows (pure)", () => {
  test("a relation without declared constraints is always allowed", () => {
    expect(linkConstraintAllows(CONSTRAINTS, "related", "preference", "receipt")).toBe(true);
  });

  test("a declared pair allows; an undeclared pair blocks", () => {
    expect(linkConstraintAllows(CONSTRAINTS, "depends_on", "preference", "preference")).toBe(true);
    expect(linkConstraintAllows(CONSTRAINTS, "depends_on", "preference", "receipt")).toBe(false);
  });

  test("a missing endpoint type cannot be evaluated - allowed", () => {
    expect(linkConstraintAllows(CONSTRAINTS, "depends_on", null, "receipt")).toBe(true);
    expect(linkConstraintAllows(CONSTRAINTS, "depends_on", "preference", null)).toBe(true);
  });
});

describe("indexer materialization post-pass", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("link-constraints"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  function writeSchema(withConstraint: boolean): void {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      [
        "schema_version: 1",
        "schema:",
        "  page_types: [preference, receipt]",
        "  link_types:",
        "    - depends_on",
        ...(withConstraint
          ? ["  link_constraints:", "    - depends_on=preference->preference"]
          : []),
      ].join("\n") + "\n",
    );
  }

  function writeNotes(): void {
    writeMd(
      vault,
      "notes/pref-a.md",
      '---\ntype: preference\ndepends_on: "[[notes/receipt-b]]"\nrelated: "[[notes/pref-c]]"\n---\n\n# A\n\nbody\n',
    );
    writeMd(vault, "notes/receipt-b.md", "---\ntype: receipt\n---\n\n# B\n\nbody\n");
    writeMd(vault, "notes/pref-c.md", "---\ntype: preference\n---\n\n# C\n\nbody\n");
  }

  test("a violating edge is blocked, a conforming edge stays typed", async () => {
    writeSchema(true);
    writeNotes();
    const config = makeConfig({ vault, dbPath });
    const stats = await indexVault(config);
    expect(stats.relationViolations).toHaveLength(1);
    expect(stats.relationViolations[0]).toMatchObject({
      relation: "depends_on",
      sourcePath: "notes/pref-a.md",
      sourceType: "preference",
      targetType: "receipt",
    });

    const store = await Store.open(config, { mode: "read" });
    try {
      const docId = store.getDocumentIdByPath("notes/pref-a.md")!;
      const typed = store.typedRelationsForDocuments([docId]).get(docId) ?? [];
      const relations = typed.map((t) => t.relation);
      expect(relations).not.toContain("depends_on");
      expect(relations).toContain("related");
    } finally {
      store.close();
    }
  });

  test("without constraints the typed edges are identical to today", async () => {
    writeSchema(false);
    writeNotes();
    const config = makeConfig({ vault, dbPath });
    const stats = await indexVault(config);
    expect(stats.relationViolations).toHaveLength(0);
    const store = await Store.open(config, { mode: "read" });
    try {
      const docId = store.getDocumentIdByPath("notes/pref-a.md")!;
      const typed = store.typedRelationsForDocuments([docId]).get(docId) ?? [];
      expect(typed.map((t) => t.relation).toSorted()).toEqual(["depends_on", "related"]);
    } finally {
      store.close();
    }
  });

  test("removing the constraint restores the edge on the next index run", async () => {
    writeSchema(true);
    writeNotes();
    const config = makeConfig({ vault, dbPath });
    await indexVault(config);

    writeSchema(false);
    const stats = await indexVault(config);
    expect(stats.relationViolations).toHaveLength(0);
    const store = await Store.open(config, { mode: "read" });
    try {
      const docId = store.getDocumentIdByPath("notes/pref-a.md")!;
      const typed = store.typedRelationsForDocuments([docId]).get(docId) ?? [];
      expect(typed.map((t) => t.relation).toSorted()).toEqual(["depends_on", "related"]);
    } finally {
      store.close();
    }
  });

  test("schema lint surfaces blocked edges with the declared pairs", async () => {
    writeSchema(true);
    writeNotes();
    const config = makeConfig({ vault, dbPath });
    await indexVault(config);

    const lint = buildSchemaLint(vault, { dbPath });
    const violation = lint.findings.find((f) => f.kind === "link-constraint-violation");
    expect(violation).toBeDefined();
    expect(violation).toMatchObject({
      relation: "depends_on",
      source: "notes/pref-a.md",
      source_type: "preference",
      target_type: "receipt",
    });
  });

  test("lint without an index file stays silent on constraints", () => {
    writeSchema(true);
    const lint = buildSchemaLint(vault, { dbPath: join(vault, "missing.sqlite") });
    expect(lint.findings.filter((f) => f.kind === "link-constraint-violation")).toHaveLength(0);
  });
});

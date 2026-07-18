/**
 * doc_aliases store surface (link-recall-intelligence, Task 2):
 * schema v7 table, per-document alias replacement, and the JS-driven
 * alias resolve pass that materializes `target_document_id` for
 * unresolved slash-free wikilink targets - exact path matches first,
 * shadowing-safe (an alias never outranks a real document basename),
 * collisions first-wins by sorted document path.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store, normalizeAlias } from "../../../src/core/search/store.ts";
import { LATEST_SCHEMA_VERSION } from "../../../src/core/search/schema.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

let tmp: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-aliases-"));
  config = makeConfig({ vault: tmp, dbPath: join(tmp, "index.sqlite") });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function doc(store: Store, path: string, title?: string): number {
  return store.upsertDocument({
    path,
    title: title ?? path,
    contentHash: `hash-${path}`,
    mtime: 1700000000,
    size: 10,
  });
}

function link(store: Store, sourceId: number, target: string): void {
  store.replaceLinks(sourceId, [
    { linkType: "wikilink", targetPath: target, linkText: null, sourceChunkId: null },
  ]);
}

function targetDocId(store: Store, sourceId: number): number | null {
  // Same private-db introspection idiom as time-range.test.ts.
  const row = (store as any).db
    .query("SELECT target_document_id FROM links WHERE source_document_id = ?")
    .get(sourceId) as { target_document_id: number | null } | null;
  return row?.target_document_id ?? null;
}

test("schema version is 10", () => {
  expect(LATEST_SCHEMA_VERSION).toBe(10);
});

test("normalizeAlias lower-cases, trims, and NFC-normalises", () => {
  expect(normalizeAlias("  Project Alpha ")).toBe("project alpha");
  // U+0041 U+0301 (decomposed) -> U+00C1 -> lowercased U+00E1
  expect(normalizeAlias("Á")).toBe("á");
});

describe("replaceDocAliases / aliasesForDocument", () => {
  test("round-trips normalised aliases and replaces on re-call", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      const id = doc(store, "notes/project-alpha.md", "Project Alpha");
      store.replaceDocAliases(id, ["PA", "Alpha Project"]);
      expect(store.aliasesForDocument(id)).toEqual(["alpha project", "pa"]);
      store.replaceDocAliases(id, ["PA"]);
      expect(store.aliasesForDocument(id)).toEqual(["pa"]);
      store.replaceDocAliases(id, []);
      expect(store.aliasesForDocument(id)).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("duplicate and empty aliases are dropped", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      const id = doc(store, "a.md");
      store.replaceDocAliases(id, ["PA", "pa", "  ", ""]);
      expect(store.aliasesForDocument(id)).toEqual(["pa"]);
    } finally {
      await store.close();
    }
  });
});

describe("resolveAliasTargets", () => {
  test("resolves an unresolved slash-free wikilink target through an alias", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      const alpha = doc(store, "notes/project-alpha.md", "Project Alpha");
      store.replaceDocAliases(alpha, ["PA"]);
      const src = doc(store, "notes/source.md");
      link(store, src, "PA");
      store.resolveLinkTargets();
      expect(targetDocId(store, src)).toBeNull();
      const resolved = store.resolveAliasTargets();
      expect(resolved).toBe(1);
      expect(targetDocId(store, src)).toBe(alpha);
    } finally {
      await store.close();
    }
  });

  test("an exact path match wins and the alias pass leaves it alone", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      const real = doc(store, "exact.md");
      const other = doc(store, "other.md");
      store.replaceDocAliases(other, ["exact.md"]);
      const src = doc(store, "src.md");
      link(store, src, "exact.md");
      store.resolveLinkTargets();
      expect(targetDocId(store, src)).toBe(real);
      store.resolveAliasTargets();
      expect(targetDocId(store, src)).toBe(real);
    } finally {
      await store.close();
    }
  });

  test("an alias that shadows a real document basename never resolves", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      doc(store, "notes/foo.md");
      const impostor = doc(store, "notes/impostor.md");
      store.replaceDocAliases(impostor, ["foo"]);
      const src = doc(store, "src.md");
      link(store, src, "foo");
      store.resolveLinkTargets();
      const resolved = store.resolveAliasTargets();
      expect(resolved).toBe(0);
      // Read-time basename fallback still finds notes/foo.md; the
      // materialized id must not point at the impostor.
      expect(targetDocId(store, src)).toBeNull();
    } finally {
      await store.close();
    }
  });

  test("two documents claiming one alias resolve first-wins by sorted path", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      const b = doc(store, "b-notes/claim.md");
      const a = doc(store, "a-notes/claim2.md");
      store.replaceDocAliases(b, ["shared"]);
      store.replaceDocAliases(a, ["shared"]);
      const src = doc(store, "src.md");
      link(store, src, "Shared");
      store.resolveAliasTargets();
      expect(targetDocId(store, src)).toBe(a);
    } finally {
      await store.close();
    }
  });

  test("targets with a slash are never alias-resolved", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      const alpha = doc(store, "notes/alpha.md");
      store.replaceDocAliases(alpha, ["nested/pa"]);
      const src = doc(store, "src.md");
      link(store, src, "nested/pa");
      const resolved = store.resolveAliasTargets();
      expect(resolved).toBe(0);
      expect(targetDocId(store, src)).toBeNull();
    } finally {
      await store.close();
    }
  });

  test("deleting the alias owner cascades its alias rows", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      const alpha = doc(store, "notes/alpha.md");
      store.replaceDocAliases(alpha, ["pa"]);
      store.deleteDocument("notes/alpha.md");
      const count = (store as any).db.query("SELECT COUNT(*) AS n FROM doc_aliases").get() as {
        n: number;
      } | null;
      expect(count?.n).toBe(0);
    } finally {
      await store.close();
    }
  });
});

describe("resolvedDocLinkPairs basename resolution (v8)", () => {
  test("exact top-level path wins over a nested basename; unique nested resolves; ambiguous nested is dropped", async () => {
    const store = await Store.open(config, { mode: "write" });
    try {
      // Top-level `alpha.md` and nested `notes/alpha.md` both exist: the
      // exact `<target>.md` branch must pick the top-level doc, not treat
      // `alpha` as an ambiguous basename.
      const topAlpha = doc(store, "alpha.md");
      doc(store, "notes/alpha.md");
      // Unique nested basename.
      const beta = doc(store, "notes/beta.md");
      // Ambiguous nested basename: two `.../gamma.md`.
      doc(store, "x/gamma.md");
      doc(store, "y/gamma.md");

      const sAlpha = doc(store, "src/s-alpha.md");
      const sBeta = doc(store, "src/s-beta.md");
      const sGamma = doc(store, "src/s-gamma.md");
      link(store, sAlpha, "alpha");
      link(store, sBeta, "beta");
      link(store, sGamma, "gamma");

      const pairs = store.resolvedDocLinkPairs();
      const bySource = new Map(pairs.map((p) => [p.source, p.target]));
      expect(bySource.get(sAlpha)).toBe(topAlpha); // exact top-level wins
      expect(bySource.get(sBeta)).toBe(beta); // unique nested resolves
      expect(bySource.has(sGamma)).toBe(false); // ambiguous nested dropped
    } finally {
      await store.close();
    }
  });
});

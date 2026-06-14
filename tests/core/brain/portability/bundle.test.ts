/**
 * Whole-vault (bank) export/import (Brain Portability & Interop suite,
 * Unit A). `exportBankBundle` composes the existing exporters into one
 * schema-versioned envelope; `importBankBundle` reconstructs the page
 * graph (delegating to importVaultGraph) and reports every other carried
 * section honestly as exported-not-restored.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BANK_BUNDLE_SCHEMA_VERSION,
  BankImportError,
  exportBankBundle,
  importBankBundle,
} from "../../../../src/core/brain/portability/bundle.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-bank-bundle-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function note(rel: string, content: string): void {
  const p = join(vault, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

describe("exportBankBundle", () => {
  test("emits a schema-versioned envelope composing the existing exporters", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nlinks to [[Beta]].\n");
    note("Notes/Beta.md", "---\ntitle: Beta\nkind: brain-source\n---\nleaf.\n");
    const bundle = exportBankBundle(vault);
    expect(bundle.schema).toBe(BANK_BUNDLE_SCHEMA_VERSION);
    expect(typeof bundle.generated_at).toBe("string");
    expect(bundle.graph.nodes.some((n) => n.id === "Alpha")).toBe(true);
    expect(bundle.pages.some((p) => p.path === "Notes/Beta.md" && p.kind === "brain-source")).toBe(
      true,
    );
    expect(Array.isArray(bundle.preferences)).toBe(true);
    expect(bundle.sources).toBeDefined();
  });

  test("the content sections are deterministic across two exports", () => {
    note("Notes/B.md", "---\ntitle: B\n---\nsee [[A]].\n");
    note("Notes/A.md", "---\ntitle: A\n---\nleaf.\n");
    const first = exportBankBundle(vault);
    const second = exportBankBundle(vault);
    // generated_at is a snapshot timestamp; the content sections are stable.
    expect(JSON.stringify(first.graph)).toBe(JSON.stringify(second.graph));
    expect(JSON.stringify(first.pages)).toBe(JSON.stringify(second.pages));
    expect(JSON.stringify(first.preferences)).toBe(JSON.stringify(second.preferences));
  });
});

describe("importBankBundle", () => {
  test("round-trips: export from one vault reconstructs page stubs in another", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nlinks to [[Beta]].\n");
    const bundle = exportBankBundle(vault);

    const dest = mkdtempSync(join(tmpdir(), "o2b-bank-dest-"));
    try {
      const result = importBankBundle(dest, bundle, { mode: "skip" });
      expect(result.schema).toBe(BANK_BUNDLE_SCHEMA_VERSION);
      expect(result.graph.created).toContain("Notes/Alpha.md");
      expect(existsSync(join(dest, "Notes/Alpha.md"))).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("reports preferences, pages, and sources as carried-not-restored", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\nkind: note\n---\nx\n");
    const bundle = exportBankBundle(vault);
    const dest = mkdtempSync(join(tmpdir(), "o2b-bank-dest2-"));
    try {
      const result = importBankBundle(dest, bundle, { mode: "skip" });
      expect(result.pagesCarried).toBe(bundle.pages.length);
      expect(result.preferencesCarried).toBe(bundle.preferences.length);
      expect(result.sourcesCarried).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("honours the conflict mode delegated to importVaultGraph", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nx\n");
    const bundle = exportBankBundle(vault);
    // skip leaves an existing page untouched.
    const r1 = importBankBundle(vault, bundle, { mode: "skip" });
    expect(r1.graph.skipped).toContain("Notes/Alpha.md");
  });

  test("rejects an unsupported schema loudly (typed error), never silently", () => {
    expect(() => importBankBundle(vault, { schema: "999", graph: { nodes: [] } })).toThrow(
      BankImportError,
    );
  });

  test("a malformed graph node is rejected per-entry, not thrown", () => {
    const bundle = {
      schema: BANK_BUNDLE_SCHEMA_VERSION,
      graph: { nodes: [{ path: 42 }, { path: "Notes/Ok.md", title: "Ok" }] },
    };
    const result = importBankBundle(vault, bundle, { mode: "skip" });
    expect(result.graph.rejected.length).toBe(1);
    expect(result.graph.created).toContain("Notes/Ok.md");
  });
});

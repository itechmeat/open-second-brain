/**
 * Vault graph export (Vault portability suite, Feature 5).
 *
 * `exportVaultGraph` walks the user's vault pages (excluding the Brain
 * machinery root and standard ignored dirs), extracting wikilinks and
 * typed-relation frontmatter into a stable, sorted graph. Re-export is
 * byte-identical. Pure read-only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exportVaultGraph,
  GRAPH_VERSION,
} from "../../../../src/core/brain/portability/graph.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-graph-export-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function note(rel: string, content: string): void {
  const p = join(vault, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

describe("exportVaultGraph", () => {
  test("emits a versioned graph of user pages with links and relations", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\nrelated: [[Gamma]]\n---\nlinks to [[Beta]] here.\n");
    note("Notes/Beta.md", "---\ntitle: Beta\n---\nleaf node.\n");
    const graph = exportVaultGraph(vault);
    expect(graph.version).toBe(GRAPH_VERSION);
    const alpha = graph.nodes.find((n) => n.id === "Alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.links).toContain("Beta");
    expect(alpha!.relations["related"]).toContain("Gamma");
  });

  test("excludes the Brain machinery root", () => {
    note("Notes/User.md", "---\ntitle: User\n---\nx\n");
    note("Brain/preferences/pref-x.md", "---\nkind: brain-preference\nid: pref-x\ntitle: PrefX\n---\ny\n");
    const ids = exportVaultGraph(vault).nodes.map((n) => n.id);
    expect(ids).toContain("User");
    expect(ids).not.toContain("pref-x");
  });

  test("nodes and links are sorted (stable, deterministic)", () => {
    note("Notes/B.md", "---\ntitle: B\n---\nsee [[Z]] and [[A]].\n");
    note("Notes/A.md", "---\ntitle: A\n---\nleaf.\n");
    const g1 = exportVaultGraph(vault);
    const g2 = exportVaultGraph(vault);
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
    const ids = g1.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    const b = g1.nodes.find((n) => n.id === "B")!;
    expect(b.links).toEqual(["A", "Z"]);
  });

  test("an empty vault yields a graph with no nodes", () => {
    const g = exportVaultGraph(vault);
    expect(g.nodes).toHaveLength(0);
  });
});

/**
 * Vault graph import (Vault portability suite, Feature 5, Task 4).
 *
 * `importVaultGraph` reconstructs page stubs (frontmatter title + single
 * typed relations, body wikilinks) under three conflict modes - skip
 * (default) / overwrite / merge. Writes go through the atomic writer and
 * `ensureInsideVault`; skip is idempotent; export -> import -> export
 * round-trips body links and single relations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exportVaultGraph,
  importVaultGraph,
} from "../../../../src/core/brain/portability/graph.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-graph-import-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

const GRAPH: {
  version: string;
  nodes: Array<{
    id: string;
    path: string;
    title: string;
    links: string[];
    relations: Record<string, string[]>;
  }>;
} = {
  version: "1",
  nodes: [
    {
      id: "Alpha",
      path: "Notes/Alpha.md",
      title: "Alpha",
      links: ["Beta"],
      relations: { related: ["Gamma"] },
    },
    { id: "Beta", path: "Notes/Beta.md", title: "Beta", links: [], relations: {} },
  ],
};

describe("importVaultGraph", () => {
  test("creates page stubs and round-trips links + single relations", () => {
    const res = importVaultGraph(vault, GRAPH, { mode: "skip" });
    expect(res.created.toSorted()).toEqual(["Notes/Alpha.md", "Notes/Beta.md"]);
    expect(existsSync(join(vault, "Notes", "Alpha.md"))).toBe(true);

    const re = exportVaultGraph(vault);
    const alpha = re.nodes.find((n) => n.id === "Alpha")!;
    expect(alpha.links).toContain("Beta");
    expect(alpha.relations["related"]).toContain("Gamma");
  });

  test("skip mode is idempotent and never overwrites", () => {
    importVaultGraph(vault, GRAPH, { mode: "skip" });
    const before = readFileSync(join(vault, "Notes", "Alpha.md"), "utf8");
    const res = importVaultGraph(vault, GRAPH, { mode: "skip" });
    expect(res.skipped).toContain("Notes/Alpha.md");
    expect(res.created).toHaveLength(0);
    expect(readFileSync(join(vault, "Notes", "Alpha.md"), "utf8")).toBe(before);
  });

  test("overwrite mode replaces an existing page", () => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, "Notes", "Beta.md"), "---\ntitle: Old\n---\nold body\n", "utf8");
    const res = importVaultGraph(vault, GRAPH, { mode: "overwrite" });
    expect(res.overwritten).toContain("Notes/Beta.md");
    expect(readFileSync(join(vault, "Notes", "Beta.md"), "utf8")).not.toContain("old body");
  });

  test("merge mode unions wikilinks with an existing page", () => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(
      join(vault, "Notes", "Alpha.md"),
      "---\ntitle: Alpha\n---\nexisting link to [[Delta]].\n",
      "utf8",
    );
    const res = importVaultGraph(vault, GRAPH, { mode: "merge" });
    expect(res.merged).toContain("Notes/Alpha.md");
    const alpha = exportVaultGraph(vault).nodes.find((n) => n.id === "Alpha")!;
    expect(alpha.links).toContain("Beta"); // incoming
    expect(alpha.links).toContain("Delta"); // pre-existing
  });

  test("rejects a node path that escapes the vault", () => {
    const evil = { version: "1", nodes: [{ id: "x", path: "../escape.md", title: "x", links: [], relations: {} }] };
    const res = importVaultGraph(vault, evil, { mode: "overwrite" });
    expect(res.created).toHaveLength(0);
    expect(res.rejected).toContain("../escape.md");
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
  });
});

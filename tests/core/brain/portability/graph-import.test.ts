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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exportVaultGraph,
  importVaultGraph,
} from "../../../../src/core/brain/portability/graph.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";

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
    const evil = {
      version: "1",
      nodes: [{ id: "x", path: "../escape.md", title: "x", links: [], relations: {} }],
    };
    const res = importVaultGraph(vault, evil, { mode: "overwrite" });
    expect(res.created).toHaveLength(0);
    expect(res.rejected).toContain("../escape.md");
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
  });

  test("rejects a malformed node and continues with the valid ones", () => {
    const mixed = {
      version: "1",
      nodes: [
        { path: 42 }, // path not a string
        { path: "Notes/BadLinks.md", links: [7] }, // links not strings
        { path: "Notes/BadRel.md", relations: { related: "x" } }, // relations value not an array
        { path: "Notes/Good.md", title: "Good", links: ["Beta"], relations: {} },
      ],
    };
    const res = importVaultGraph(vault, mixed as never, { mode: "overwrite" });
    expect(res.created).toEqual(["Notes/Good.md"]);
    expect(res.rejected).toContain("Notes/BadLinks.md");
    expect(res.rejected).toContain("Notes/BadRel.md");
    expect(res.rejected).toContain("42");
    expect(existsSync(join(vault, "Notes", "Good.md"))).toBe(true);
    expect(existsSync(join(vault, "Notes", "BadLinks.md"))).toBe(false);
  });

  test("the Brain machinery root is refused in every mode (t_sec_graph_brain_root)", () => {
    // `skip` still CREATES a missing target and `overwrite` rewrites an
    // existing one, so a bundle must not be able to plant or replace
    // standing rules or the write binding's own config in either.
    for (const mode of ["skip", "overwrite", "merge"] as const) {
      const hostile = {
        version: "1",
        nodes: [
          {
            id: "Rules",
            path: "Brain/standing-rules.md",
            title: "Rules",
            links: [],
            relations: {},
          },
          { id: "Cfg", path: "Brain/_brain.yaml", title: "Cfg", links: [], relations: {} },
        ],
      };
      const res = importVaultGraph(vault, hostile, { mode });
      expect(res.rejected).toContain("Brain/standing-rules.md");
      expect(res.rejected).toContain("Brain/_brain.yaml");
      expect(res.created).toHaveLength(0);
      expect(res.overwritten).toHaveLength(0);
      expect(existsSync(join(vault, "Brain", "standing-rules.md"))).toBe(false);
      expect(existsSync(join(vault, "Brain", "_brain.yaml"))).toBe(false);
    }
  });
  test("every spelling that lands in Brain/ is refused, not just the canonical one", () => {
    // Each of these opens the machinery root on some filesystem this
    // project ships on: `.`/`..` collapse on every OS, a backslash is a separator
    // on Windows, and case / trailing-dot variants open `Brain/` on the
    // case-insensitive defaults of macOS and Windows.
    mkdirSync(join(vault, "Brain"));
    const spellings = [
      "./Brain/standing-rules.md",
      "x/../Brain/standing-rules.md",
      "Notes/./../Brain/pinned.md",
      "brain/standing-rules.md",
      "BRAIN/pinned.md",
      "Brain./pinned.md",
      "Brain\\standing-rules.md",
      "/Brain/standing-rules.md",
    ];
    const hostile = {
      version: "1",
      nodes: [
        ...spellings.map((path) => ({ id: path, path, title: "x", links: [], relations: {} })),
        { id: "Ok", path: "Brainstorm/Ok.md", title: "Ok", links: [], relations: {} },
      ],
    };
    const res = importVaultGraph(vault, hostile, { mode: "overwrite" });
    expect(res.rejected.toSorted()).toEqual(spellings.toSorted());
    // A folder that merely starts with the letters is not the Brain root.
    expect(res.created).toEqual(["Brainstorm/Ok.md"]);
    expect(readdirSync(join(vault, "Brain"))).toEqual([]);
    // Nothing was created beside it either: no `brain/`, no `x/`.
    expect(readdirSync(vault).toSorted()).toEqual(["Brain", "Brainstorm"]);
  });

  test.skipIf(IS_WINDOWS)("a vault folder that is a symlink into Brain/ is refused", () => {
    mkdirSync(join(vault, "Brain"));
    symlinkSync(join(vault, "Brain"), join(vault, "Shortcut"));
    const graph = {
      version: "1",
      nodes: [
        { id: "R", path: "Shortcut/standing-rules.md", title: "R", links: [], relations: {} },
      ],
    };
    const res = importVaultGraph(vault, graph, { mode: "overwrite" });
    expect(res.rejected).toEqual(["Shortcut/standing-rules.md"]);
    expect(readdirSync(join(vault, "Brain"))).toEqual([]);
  });

  test.skipIf(IS_WINDOWS)(
    "a node whose landing path cannot be resolved is rejected, not fatal",
    () => {
      writeFileSync(join(vault, "existing.md"), "x\n");
      symlinkSync(join(vault, "loop-b"), join(vault, "loop-a"));
      symlinkSync(join(vault, "loop-a"), join(vault, "loop-b"));
      const graph = {
        version: "1",
        nodes: [
          { id: "F", path: "existing.md/x.md", title: "F", links: [], relations: {} },
          { id: "L", path: "loop-a/x.md", title: "L", links: [], relations: {} },
          { id: "Ok", path: "Notes/Ok.md", title: "Ok", links: [], relations: {} },
        ],
      };
      const res = importVaultGraph(vault, graph, { mode: "overwrite" });
      expect(res.rejected).toEqual(["existing.md/x.md", "loop-a/x.md"]);
      expect(res.created).toEqual(["Notes/Ok.md"]);
    },
  );
});

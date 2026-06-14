/**
 * Page interchange contract (Brain Portability & Interop suite, Unit B).
 *
 * `projectPageContracts` is a pure, read-only projection of every user
 * vault page (Brain machinery + ignored dirs excluded) to a stable,
 * schema-versioned interchange record. Structural derivation only: no
 * LLM synthesis and no natural-language heuristics.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAGE_CONTRACT_VERSION,
  projectPageContracts,
} from "../../../../src/core/brain/portability/page-contract.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-page-contract-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function note(rel: string, content: string): void {
  const p = join(vault, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

describe("projectPageContracts", () => {
  test("exposes a stable schema version", () => {
    expect(PAGE_CONTRACT_VERSION).toBe("1");
  });

  test("projects one record per user page with a vault-relative POSIX path", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nbody\n");
    const pages = projectPageContracts(vault);
    expect(pages.length).toBe(1);
    expect(pages[0]!.path).toBe("Notes/Alpha.md");
  });

  test("kind reads the frontmatter field, else defaults structurally to note", () => {
    note("Sources/S.md", "---\ntitle: S\nkind: brain-source\n---\nx\n");
    note("Notes/Plain.md", "---\ntitle: Plain\n---\nx\n");
    const byPath = new Map(projectPageContracts(vault).map((p) => [p.path, p]));
    expect(byPath.get("Sources/S.md")!.kind).toBe("brain-source");
    expect(byPath.get("Notes/Plain.md")!.kind).toBe("note");
  });

  test("confidence and provenance are advisory: present when set, null otherwise", () => {
    note("Notes/Has.md", "---\ntitle: Has\nconfidence: 0.8\nprovenance: stated\n---\nx\n");
    note("Notes/None.md", "---\ntitle: None\n---\nx\n");
    const byPath = new Map(projectPageContracts(vault).map((p) => [p.path, p]));
    // The advisory value is reported faithfully as the frontmatter parser
    // yields it (string-based), never coerced or fabricated.
    expect(byPath.get("Notes/Has.md")!.confidence).toBe("0.8");
    expect(byPath.get("Notes/Has.md")!.provenance).toBe("stated");
    expect(byPath.get("Notes/None.md")!.confidence).toBeNull();
    expect(byPath.get("Notes/None.md")!.provenance).toBeNull();
  });

  test("citations flatten body wikilinks and typed-relation targets, sorted-unique", () => {
    note(
      "Notes/Cite.md",
      "---\ntitle: Cite\nrelated: [[Zeta]]\n---\nsee [[Beta]] and [[Alpha]] and [[Beta]].\n",
    );
    const page = projectPageContracts(vault).find((p) => p.path === "Notes/Cite.md")!;
    expect(page.citations).toEqual(["Alpha", "Beta", "Zeta"]);
  });

  test("aliases pass through from frontmatter, else empty", () => {
    note("Notes/Al.md", "---\ntitle: Al\naliases: [A1, A2]\n---\nx\n");
    note("Notes/NoAl.md", "---\ntitle: NoAl\n---\nx\n");
    const byPath = new Map(projectPageContracts(vault).map((p) => [p.path, p]));
    expect(byPath.get("Notes/Al.md")!.aliases).toEqual(["A1", "A2"]);
    expect(byPath.get("Notes/NoAl.md")!.aliases).toEqual([]);
  });

  test("freshness reads a frontmatter timestamp when present", () => {
    note("Notes/Fresh.md", "---\ntitle: Fresh\nupdated_at: 2026-01-02T03:04:05Z\n---\nx\n");
    const page = projectPageContracts(vault).find((p) => p.path === "Notes/Fresh.md")!;
    expect(page.freshness).toBe("2026-01-02T03:04:05Z");
  });

  test("freshness falls back to the file mtime (ISO) when no frontmatter timestamp", () => {
    note("Notes/Mtime.md", "---\ntitle: Mtime\n---\nx\n");
    const page = projectPageContracts(vault).find((p) => p.path === "Notes/Mtime.md")!;
    // No frontmatter timestamp -> a non-null ISO string derived from mtime.
    expect(page.freshness).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("excludes the Brain machinery root and ignored dirs", () => {
    note("Notes/User.md", "---\ntitle: User\n---\nx\n");
    note("Brain/preferences/pref-x.md", "---\nkind: brain-preference\ntitle: PrefX\n---\ny\n");
    const paths = projectPageContracts(vault).map((p) => p.path);
    expect(paths).toContain("Notes/User.md");
    expect(paths.some((p) => p.startsWith("Brain/"))).toBe(false);
  });

  test("output is deterministic and sorted by path", () => {
    note("Notes/B.md", "---\ntitle: B\n---\nx\n");
    note("Notes/A.md", "---\ntitle: A\n---\nx\n");
    const first = projectPageContracts(vault);
    const second = projectPageContracts(vault);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((p) => p.path)).toEqual(["Notes/A.md", "Notes/B.md"]);
  });
});

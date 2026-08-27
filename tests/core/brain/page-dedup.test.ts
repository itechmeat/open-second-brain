import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findDuplicateCandidates,
  mergePage,
  patchWikilinks,
} from "../../../src/core/brain/page-dedup.ts";
import { MergeChainError } from "../../../src/core/brain/page-meta/page-id.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-page-dedup-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(
  slug: string,
  fields: { topic: string; principle: string; created_at?: string; merged_into?: string },
): string {
  const path = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  const lines = [
    "---",
    `id: pref-${slug}`,
    `topic: ${fields.topic}`,
    `principle: ${fields.principle}`,
  ];
  if (fields.created_at) lines.push(`created_at: ${fields.created_at}`);
  if (fields.merged_into) lines.push(`merged_into: ${fields.merged_into}`);
  lines.push("---", "");
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("findDuplicateCandidates", () => {
  test("returns empty when no duplicates", () => {
    writePref("a", { topic: "x", principle: "alpha" });
    writePref("b", { topic: "y", principle: "beta" });
    const report = findDuplicateCandidates(vault);
    expect(report.scanned).toBe(2);
    expect(report.candidates.length).toBe(0);
  });

  test("groups by normalised topic+principle key", () => {
    writePref("old", {
      topic: "writing",
      principle: "Use imperative voice",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("new", {
      topic: "Writing",
      principle: "USE IMPERATIVE VOICE",
      created_at: "2026-05-01T00:00:00Z",
    });
    const report = findDuplicateCandidates(vault);
    expect(report.candidates.length).toBe(1);
    const c = report.candidates[0]!;
    expect(c.pages.length).toBe(2);
    // oldest wins
    expect(c.canonical.id).toBe("pref-old");
    expect(c.secondaries.map((s) => s.id)).toEqual(["pref-new"]);
  });

  test("collapses fullwidth and halfwidth variants", () => {
    writePref("ascii", {
      topic: "ru",
      principle: "Hello",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("wide", {
      topic: "ru",
      principle: "Ｈｅｌｌｏ",
      created_at: "2026-02-01T00:00:00Z",
    });
    const report = findDuplicateCandidates(vault);
    expect(report.candidates.length).toBe(1);
    expect(report.candidates[0]!.canonical.id).toBe("pref-ascii");
  });

  test("ignores singletons", () => {
    writePref("a", { topic: "x", principle: "alpha" });
    writePref("b", { topic: "x", principle: "beta" });
    writePref("c", { topic: "x", principle: "alpha" });
    const report = findDuplicateCandidates(vault);
    expect(report.candidates.length).toBe(1);
    expect(report.candidates[0]!.pages.map((p) => p.id).toSorted()).toEqual(["pref-a", "pref-c"]);
  });
});

/**
 * A page a merge already resolved leaves the candidate pool (GitHub #180).
 *
 * Claims pinned here:
 *
 *  1. A secondary stamped `merged_into: <canonical>` is not proposed for
 *     the same merge on the next scan - the cluster is finished.
 *  2. A pointer that leaves the group resolves the page just as one that
 *     stays inside it does. The page was de-canonicalised; where its
 *     canonical lives is not the dedup pass's question, and re-proposing
 *     it is what silently overwrote an operator's merge decision.
 *  3. A chain that leaves the group and comes back (`b -> x -> a`, `x`
 *     carrying unrelated text) resolves `b` as well - the predicate is
 *     not a one-hop "points at a group member" test.
 *  4. A DANGLING pointer still means the page was resolved. A target
 *     nobody kept is a lint problem, never a licence to re-merge.
 *  5. A group left with fewer than two live members proposes nothing.
 *  6. Resolving ONE member of a three-page group still proposes the
 *     merge for the two that are live - the filter drops pages, it does
 *     not abandon clusters.
 */
describe("findDuplicateCandidates skips pages a merge already resolved", () => {
  /** Rule text shared by every page meant to land in one group. */
  const DUPE = { topic: "writing", principle: "Use imperative voice" };

  test("a merged secondary is not proposed for the same merge again", () => {
    writePref("a", { ...DUPE, created_at: "2026-01-01T00:00:00Z" });
    writePref("b", { ...DUPE, created_at: "2026-02-01T00:00:00Z", merged_into: "pref-a" });
    const report = findDuplicateCandidates(vault);
    expect(report.scanned).toBe(2);
    expect(report.candidates).toHaveLength(0);
  });

  test("a pointer that leaves the group still resolves the page", () => {
    writePref("a", { ...DUPE, created_at: "2026-01-01T00:00:00Z" });
    writePref("b", { ...DUPE, created_at: "2026-02-01T00:00:00Z", merged_into: "pref-x" });
    // Unrelated text, so `pref-x` is in no group of its own and in
    // particular not in this one.
    writePref("x", {
      topic: "other",
      principle: "something else",
      created_at: "2025-01-01T00:00:00Z",
    });
    expect(findDuplicateCandidates(vault).candidates).toHaveLength(0);
  });

  test("a chain that leaves the group and comes back resolves the page", () => {
    writePref("a", { ...DUPE, created_at: "2026-01-01T00:00:00Z" });
    writePref("b", { ...DUPE, created_at: "2026-02-01T00:00:00Z", merged_into: "pref-x" });
    writePref("x", {
      topic: "other",
      principle: "something else",
      created_at: "2025-01-01T00:00:00Z",
      merged_into: "pref-a",
    });
    expect(findDuplicateCandidates(vault).candidates).toHaveLength(0);
  });

  test("a dangling pointer does not resurrect the page as a candidate", () => {
    writePref("a", { ...DUPE, created_at: "2026-01-01T00:00:00Z" });
    writePref("b", { ...DUPE, created_at: "2026-02-01T00:00:00Z", merged_into: "pref-gone" });
    expect(findDuplicateCandidates(vault).candidates).toHaveLength(0);
  });

  test("a group left with fewer than two live members proposes nothing", () => {
    writePref("a", { ...DUPE, created_at: "2026-01-01T00:00:00Z" });
    writePref("b", { ...DUPE, created_at: "2026-02-01T00:00:00Z", merged_into: "pref-a" });
    writePref("c", { ...DUPE, created_at: "2026-03-01T00:00:00Z", merged_into: "pref-a" });
    const report = findDuplicateCandidates(vault);
    expect(report.scanned).toBe(3);
    expect(report.candidates).toHaveLength(0);
  });

  test("one resolved member still leaves two live candidates", () => {
    writePref("a", { ...DUPE, created_at: "2026-01-01T00:00:00Z" });
    writePref("b", { ...DUPE, created_at: "2026-02-01T00:00:00Z", merged_into: "pref-a" });
    writePref("c", { ...DUPE, created_at: "2026-03-01T00:00:00Z" });
    const report = findDuplicateCandidates(vault);
    expect(report.candidates).toHaveLength(1);
    const candidate = report.candidates[0]!;
    expect(candidate.canonical.id).toBe("pref-a");
    expect(candidate.secondaries.map((s) => s.id)).toEqual(["pref-c"]);
    expect(candidate.pages.map((p) => p.id)).toEqual(["pref-a", "pref-c"]);
  });
});

describe("patchWikilinks", () => {
  test("rewrites plain [[oldTarget]] references", () => {
    const log = join(vault, "Brain", "log", "2026-05-25.md");
    writeFileSync(log, "see [[pref-old]] for context\n");
    const touched = patchWikilinks(vault, "pref-old", "pref-new");
    expect(touched).toBe(1);
    expect(readFileSync(log, "utf8")).toContain("[[pref-new]]");
  });

  test("rewrites aliased and anchored wikilinks", () => {
    const log = join(vault, "Brain", "log", "2026-05-25.md");
    writeFileSync(log, "[[pref-old|the rule]] and [[pref-old#section]] and [[pref-old]]\n");
    const touched = patchWikilinks(vault, "pref-old", "pref-new");
    expect(touched).toBe(1);
    const content = readFileSync(log, "utf8");
    expect(content).toContain("[[pref-new|the rule]]");
    expect(content).toContain("[[pref-new#section]]");
    expect(content).toContain("[[pref-new]]");
    expect(content).not.toContain("pref-old");
  });

  test("does not rewrite when nothing matches", () => {
    const log = join(vault, "Brain", "log", "2026-05-25.md");
    writeFileSync(log, "nothing relevant here\n");
    const touched = patchWikilinks(vault, "pref-old", "pref-new");
    expect(touched).toBe(0);
  });

  test("identity rewrite is a no-op", () => {
    const log = join(vault, "Brain", "log", "2026-05-25.md");
    writeFileSync(log, "[[pref-x]]\n");
    const touched = patchWikilinks(vault, "pref-x", "pref-x");
    expect(touched).toBe(0);
  });

  test("does not rewrite wikilinks that merely share a prefix", () => {
    // Patching `pref-old` must NOT touch `[[pref-old-extra]]` or
    // `[[pref-older]]` - those are distinct identities that just
    // happen to start with the same substring. The lookahead in
    // the patcher's regex defends this; pin it explicitly so a
    // future regex rewrite cannot regress the case.
    const log = join(vault, "Brain", "log", "2026-05-25.md");
    writeFileSync(log, "matches [[pref-old]] and skips [[pref-old-extra]] and [[pref-older]]\n");
    const touched = patchWikilinks(vault, "pref-old", "pref-new");
    expect(touched).toBe(1);
    const content = readFileSync(log, "utf8");
    expect(content).toContain("[[pref-new]]");
    expect(content).toContain("[[pref-old-extra]]");
    expect(content).toContain("[[pref-older]]");
    expect(content).not.toMatch(/\[\[pref-old\]\]/);
  });
});

describe("mergePage", () => {
  test("stamps merged_into on the secondary and rewrites wikilinks", () => {
    const oldPath = writePref("old", {
      topic: "writing",
      principle: "Use imperative voice",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("new", {
      topic: "writing",
      principle: "Use imperative voice",
      created_at: "2026-05-01T00:00:00Z",
    });
    const log = join(vault, "Brain", "log", "2026-05-25.md");
    writeFileSync(log, "applied [[pref-new]] today\n");

    const res = mergePage(vault, "pref-new", "pref-old");
    expect(res.canonical).toBe("pref-old");
    expect(res.secondary).toBe("pref-new");
    expect(res.wikilinksUpdated).toBe(1);

    const newPath = join(vault, "Brain", "preferences", "pref-new.md");
    expect(readFileSync(newPath, "utf8")).toContain("merged_into: pref-old");
    expect(readFileSync(log, "utf8")).toContain("[[pref-old]]");
    // canonical untouched
    expect(readFileSync(oldPath, "utf8")).not.toContain("merged_into:");
  });

  test("second merge is idempotent (no extra wikilink rewrites)", () => {
    writePref("canon", {
      topic: "x",
      principle: "y",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("dup", {
      topic: "x",
      principle: "y",
      created_at: "2026-02-01T00:00:00Z",
    });
    const log = join(vault, "Brain", "log", "2026-05-25.md");
    writeFileSync(log, "[[pref-dup]]\n");
    const first = mergePage(vault, "pref-dup", "pref-canon");
    expect(first.wikilinksUpdated).toBe(1);
    const second = mergePage(vault, "pref-dup", "pref-canon");
    expect(second.wikilinksUpdated).toBe(0);
  });

  test("refuses the reverse merge that would close a cycle", () => {
    // The GitHub #180 destroyer, at the seam that did the damage. Pages
    // with no `created_at` order by mtime, and the merge moves the
    // canonical's mtime, so a second pass over this pair used to pick
    // the reverse direction and write `a -> b` on top of `b -> a`.
    // `findDuplicateCandidates` no longer proposes it; the writer
    // refuses it whoever asks.
    writePref("a", { topic: "x", principle: "y" });
    writePref("b", { topic: "x", principle: "y" });
    mergePage(vault, "pref-b", "pref-a");
    const aPath = join(vault, "Brain", "preferences", "pref-a.md");
    const before = readFileSync(aPath, "utf8");
    expect(() => mergePage(vault, "pref-a", "pref-b")).toThrow(MergeChainError);
    expect(readFileSync(aPath, "utf8")).toBe(before);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findDuplicateCandidates,
  mergePage,
  patchWikilinks,
} from "../../../src/core/brain/page-dedup.ts";

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
});

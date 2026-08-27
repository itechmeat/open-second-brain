import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MERGE_CHAIN_MAX_DEPTH,
  MergeChainError,
  readMergedInto,
  resolveCanonicalId,
  setMergedInto,
} from "../../../../src/core/brain/page-meta/page-id.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-page-id-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, frontmatter: Record<string, string>) {
  const path = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  const yamlLines = ["---", `id: pref-${slug}`];
  for (const [k, v] of Object.entries(frontmatter)) yamlLines.push(`${k}: ${v}`);
  yamlLines.push("---", "");
  writeFileSync(path, yamlLines.join("\n"));
  return path;
}

describe("readMergedInto", () => {
  test("returns the canonical id when present", () => {
    expect(readMergedInto({ merged_into: "pref-foo" })).toBe("pref-foo");
  });

  test("trims whitespace", () => {
    expect(readMergedInto({ merged_into: "  pref-foo  " })).toBe("pref-foo");
  });

  test("returns null when absent or non-string", () => {
    expect(readMergedInto({})).toBeNull();
    expect(readMergedInto({ merged_into: "" })).toBeNull();
    expect(readMergedInto({ merged_into: "   " })).toBeNull();
    expect(readMergedInto({ merged_into: 123 as unknown })).toBeNull();
  });
});

describe("resolveCanonicalId", () => {
  test("returns the starting id when the page has no merged_into", () => {
    writePref("a", { topic: "x", principle: "y" });
    expect(resolveCanonicalId(vault, "pref-a")).toBe("pref-a");
  });

  test("follows a single-hop merged_into pointer", () => {
    writePref("canonical", { topic: "x", principle: "y" });
    writePref("secondary", { topic: "x", principle: "y", merged_into: "pref-canonical" });
    expect(resolveCanonicalId(vault, "pref-secondary")).toBe("pref-canonical");
  });

  test("follows a multi-hop chain", () => {
    writePref("c", { topic: "x", principle: "y" });
    writePref("b", { topic: "x", principle: "y", merged_into: "pref-c" });
    writePref("a", { topic: "x", principle: "y", merged_into: "pref-b" });
    expect(resolveCanonicalId(vault, "pref-a")).toBe("pref-c");
  });

  test("returns dangling id when target file does not exist", () => {
    writePref("a", { topic: "x", principle: "y", merged_into: "pref-missing" });
    expect(resolveCanonicalId(vault, "pref-a")).toBe("pref-missing");
  });

  test("throws CYCLE on a self-loop", () => {
    writePref("a", { topic: "x", principle: "y", merged_into: "pref-a" });
    expect(() => resolveCanonicalId(vault, "pref-a")).toThrow(MergeChainError);
  });

  test("throws CYCLE on a multi-page cycle", () => {
    writePref("a", { topic: "x", principle: "y", merged_into: "pref-b" });
    writePref("b", { topic: "x", principle: "y", merged_into: "pref-a" });
    try {
      resolveCanonicalId(vault, "pref-a");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MergeChainError);
      expect((e as MergeChainError).code).toBe("CYCLE");
    }
  });

  test("throws DEPTH on a chain longer than MERGE_CHAIN_MAX_DEPTH", () => {
    // Build a chain of MAX_DEPTH + 2 pages so the walker bails out.
    const n = MERGE_CHAIN_MAX_DEPTH + 2;
    for (let i = 0; i < n; i++) {
      const target = i + 1 < n ? `pref-p${i + 1}` : undefined;
      writePref(
        `p${i}`,
        target
          ? { topic: "x", principle: "y", merged_into: target }
          : { topic: "x", principle: "y" },
      );
    }
    try {
      resolveCanonicalId(vault, "pref-p0");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MergeChainError);
      expect((e as MergeChainError).code).toBe("DEPTH");
    }
  });

  test("throws MALFORMED on an unknown-prefix id", () => {
    expect(() => resolveCanonicalId(vault, "garbage-x")).toThrow(MergeChainError);
  });
});

describe("setMergedInto", () => {
  test("writes the pointer when absent", () => {
    writePref("canonical", { topic: "x", principle: "y" });
    const path = writePref("secondary", { topic: "x", principle: "y" });
    setMergedInto(vault, "pref-secondary", "pref-canonical");
    expect(readFileSync(path, "utf8")).toContain("merged_into: pref-canonical");
  });

  test("reports the write it performed", () => {
    writePref("canonical", { topic: "x", principle: "y" });
    writePref("secondary", { topic: "x", principle: "y" });
    const result = setMergedInto(vault, "pref-secondary", "pref-canonical");
    expect(result).toEqual({
      secondary: "pref-secondary",
      canonical: "pref-canonical",
      previous: null,
      changed: true,
    });
  });

  test("refuses to repoint a page that already points somewhere else", () => {
    // This used to be `updates an existing pointer`, and the silent
    // overwrite it pinned is how a second `page-dedup --apply` destroyed
    // an operator's deliberate merge (GitHub #180).
    writePref("a", { topic: "x", principle: "y" });
    writePref("b", { topic: "x", principle: "y" });
    const path = writePref("c", { topic: "x", principle: "y", merged_into: "pref-a" });
    const before = readFileSync(path, "utf8");
    try {
      setMergedInto(vault, "pref-c", "pref-b");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MergeChainError);
      expect((e as MergeChainError).code).toBe("REPOINT");
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("repoints when the caller asks for it explicitly", () => {
    writePref("a", { topic: "x", principle: "y" });
    writePref("b", { topic: "x", principle: "y" });
    const path = writePref("c", { topic: "x", principle: "y", merged_into: "pref-a" });
    const result = setMergedInto(vault, "pref-c", "pref-b", { repoint: true });
    expect(result.previous).toBe("pref-a");
    expect(result.changed).toBe(true);
    const yaml = readFileSync(path, "utf8");
    expect(yaml).toContain("merged_into: pref-b");
    expect(yaml).not.toContain("merged_into: pref-a");
  });

  test("re-setting the same target changes nothing and says so", () => {
    writePref("a", { topic: "x", principle: "y" });
    const path = writePref("b", { topic: "x", principle: "y", merged_into: "pref-a" });
    const before = readFileSync(path, "utf8");
    const result = setMergedInto(vault, "pref-b", "pref-a");
    expect(result.previous).toBe("pref-a");
    expect(result.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses a pointer that would close a cycle", () => {
    // The mtime-flip destroyer: `pref-b` is already merged into
    // `pref-a`, and a second pass that reversed the pair used to write
    // `pref-a -> pref-b` on top of it, leaving both pages unresolvable.
    writePref("a", { topic: "x", principle: "y" });
    writePref("b", { topic: "x", principle: "y", merged_into: "pref-a" });
    const path = join(vault, "Brain", "preferences", "pref-a.md");
    const before = readFileSync(path, "utf8");
    try {
      setMergedInto(vault, "pref-a", "pref-b");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MergeChainError);
      expect((e as MergeChainError).code).toBe("CYCLE");
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(resolveCanonicalId(vault, "pref-b")).toBe("pref-a");
  });

  test("refuses a cycle reached through a longer chain", () => {
    writePref("a", { topic: "x", principle: "y" });
    writePref("c", { topic: "x", principle: "y", merged_into: "pref-a" });
    writePref("b", { topic: "x", principle: "y", merged_into: "pref-c" });
    try {
      setMergedInto(vault, "pref-a", "pref-b");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MergeChainError);
      expect((e as MergeChainError).code).toBe("CYCLE");
    }
    expect(readFileSync(join(vault, "Brain", "preferences", "pref-a.md"), "utf8")).not.toContain(
      "merged_into",
    );
  });

  test("rejects self-pointer", () => {
    writePref("a", { topic: "x", principle: "y" });
    expect(() => setMergedInto(vault, "pref-a", "pref-a")).toThrow(MergeChainError);
  });

  test("rejects missing secondary", () => {
    expect(() => setMergedInto(vault, "pref-nope", "pref-foo")).toThrow(MergeChainError);
  });

  test("written page remains readable through the merge chain", () => {
    writePref("c", { topic: "x", principle: "y" });
    writePref("b", { topic: "x", principle: "y" });
    setMergedInto(vault, "pref-b", "pref-c");
    expect(resolveCanonicalId(vault, "pref-b")).toBe("pref-c");
    expect(existsSync(join(vault, "Brain", "preferences", "pref-b.md"))).toBe(true);
  });
});

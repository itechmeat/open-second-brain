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

  test("updates an existing pointer", () => {
    writePref("a", { topic: "x", principle: "y" });
    writePref("b", { topic: "x", principle: "y" });
    const path = writePref("c", {
      topic: "x",
      principle: "y",
      merged_into: "pref-a",
    });
    setMergedInto(vault, "pref-c", "pref-b");
    const yaml = readFileSync(path, "utf8");
    expect(yaml).toContain("merged_into: pref-b");
    expect(yaml).not.toContain("merged_into: pref-a");
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

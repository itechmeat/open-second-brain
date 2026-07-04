import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractWikilinks,
  listVaultPages,
  parseFrontmatter,
  slugify,
  writeFrontmatter,
} from "../../src/core/vault.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-vault-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  test("extracts simple key/value fields", () => {
    const path = join(tmp, "note.md");
    writeFileSync(path, "---\ntitle: Hello World\ntags: test, example\n---\n\nBody text.\n");
    const [meta, body] = parseFrontmatter(path);
    expect(meta["title"]).toBe("Hello World");
    expect(meta["tags"]).toBe("test, example");
    expect(body).toBe("Body text.");
  });

  test("handles file without frontmatter", () => {
    const path = join(tmp, "note.md");
    writeFileSync(path, "Just a note.");
    const [meta, body] = parseFrontmatter(path);
    expect(meta).toEqual({});
    expect(body).toBe("Just a note.");
  });

  test("handles missing file gracefully", () => {
    const [meta, body] = parseFrontmatter("/nonexistent/file.md");
    expect(meta).toEqual({});
    expect(body).toBe("");
  });
});

describe("writeFrontmatter", () => {
  test("roundtrip preserves title and body", () => {
    const path = join(tmp, "note.md");
    writeFrontmatter(path, { title: "Roundtrip" }, "The body.");
    const [meta, body] = parseFrontmatter(path);
    expect(meta["title"]).toBe("Roundtrip");
    expect(body).toBe("The body.");
  });

  test("serializes lists as inline arrays", () => {
    const path = join(tmp, "note.md");
    writeFrontmatter(path, { title: "Tagged", tags: ["draft", "demo"] }, "Body.");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("tags: [draft, demo]");
  });

  test("quotes list values with special chars", () => {
    const path = join(tmp, "note.md");
    writeFrontmatter(path, { tags: ["plain", "needs, comma"] }, "Body.");
    const text = readFileSync(path, "utf8");
    expect(text).toContain('tags: [plain, "needs, comma"]');
  });

  test("quotes scalars containing colon-space", () => {
    const path = join(tmp, "note.md");
    writeFrontmatter(path, { title: "Hello: world" }, "Body.");
    const text = readFileSync(path, "utf8");
    expect(text).toContain('title: "Hello: world"');
  });

  test("escapes control characters", () => {
    const path = join(tmp, "note.md");
    writeFrontmatter(path, { summary: "line one\nline two" }, "Body.");
    const text = readFileSync(path, "utf8");
    expect(text).toContain('summary: "line one\\nline two"');
  });

  test("inline array with quoted comma round-trips", () => {
    const path = join(tmp, "note.md");
    writeFrontmatter(path, { tags: ["plain", "needs, comma", "third"] }, "Body.");
    const [meta] = parseFrontmatter(path);
    expect(meta["tags"]).toEqual(["plain", "needs, comma", "third"]);
  });

  test("empty inline array round-trips to []", () => {
    const path = join(tmp, "note.md");
    writeFrontmatter(path, { tags: [] as string[] }, "Body.");
    const [meta] = parseFrontmatter(path);
    expect(meta["tags"]).toEqual([]);
  });

  test("double-quoted scalar with quotes round-trips without escape amplification", () => {
    // The formatter escapes `"` to `\"` inside double-quoted scalars;
    // the parser must unescape symmetrically. Before the fix every
    // parse -> format cycle doubled the backslashes, which is how the
    // live vault accumulated \\\\\\" chains in preference frontmatter.
    const path = join(tmp, "note.md");
    const value = 'phrasing like "давай так:" or "пусть так"';
    writeFrontmatter(path, { principle: value }, "Body.");
    const [meta] = parseFrontmatter(path);
    expect(meta["principle"]).toBe(value);

    // Second cycle: rewrite what we parsed; bytes must be stable.
    const firstBytes = readFileSync(path, "utf8");
    writeFrontmatter(path, { principle: meta["principle"] as string }, "Body.");
    expect(readFileSync(path, "utf8")).toBe(firstBytes);
  });

  test("escaped newline and backslash round-trip through double-quoted scalars", () => {
    const path = join(tmp, "note.md");
    const value = "line one\nline two with backslash \\ and tab\there";
    writeFrontmatter(path, { summary: value }, "Body.");
    const [meta] = parseFrontmatter(path);
    expect(meta["summary"]).toBe(value);
  });

  test("inline array elements with quotes round-trip", () => {
    const path = join(tmp, "note.md");
    const tags = ["plain", 'say "hi"'];
    writeFrontmatter(path, { tags }, "Body.");
    const [meta] = parseFrontmatter(path);
    expect(meta["tags"]).toEqual(tags);
  });
});

describe("slugify", () => {
  test("lowercases and replaces punctuation", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  test("empty / punctuation-only inputs fall back to a stable unnamed-<hash>", () => {
    // Every input that slugifies to nothing must land on `unnamed-<hex>` —
    // never a bare `-`, empty string, or traversal-capable name.
    const fallback = /^unnamed-[0-9a-f]{8}$/;
    for (const input of [
      "", // empty
      "   ", // whitespace-only
      "---", // punctuation-only
      "@", // single symbol
      "!!!", // repeated punctuation
      "★ ☆ ☃", // dingbat / geometric symbols
      "🙂🙂", // emoji-only
      "́̈", // bare combining marks (acute + diaeresis)
    ]) {
      expect(slugify(input)).toMatch(fallback);
    }
  });

  test("fallback is stable per-input and distinct across inputs", () => {
    // Same title → same basename (stable across devices / re-slug)...
    expect(slugify("@")).toBe(slugify("@"));
    // ...normalized: leading/trailing whitespace and case do not fork it.
    expect(slugify("  @  ")).toBe(slugify("@"));
    // ...but different punctuation-only titles must not collide on one name.
    expect(slugify("@")).not.toBe(slugify("!!!"));
  });

  test("fallback is idempotent under a second slugify pass", () => {
    const once = slugify("@");
    expect(slugify(once)).toBe(once);
  });

  test("truncates long input to 64 chars", () => {
    expect(slugify("a".repeat(200)).length).toBe(64);
  });
});

describe("extractWikilinks", () => {
  test("simple links", () => {
    expect(extractWikilinks("See [[Target]] and [[Other]] for details.")).toEqual([
      "Target",
      "Other",
    ]);
  });

  test("ignores media file extensions", () => {
    expect(extractWikilinks("Look at ![[photo.png]] and [[concept]].")).toEqual(["concept"]);
  });

  test("ignores code blocks", () => {
    expect(extractWikilinks("```\n[[not-a-link]]\n```\nReal: [[real-link]]")).toEqual([
      "real-link",
    ]);
  });

  test("deduplicates", () => {
    expect(extractWikilinks("[[A]] [[A]] [[B]]")).toEqual(["A", "B"]);
  });
});

describe("listVaultPages", () => {
  test("discovers Markdown files", () => {
    writeFileSync(join(tmp, "page1.md"), "---\ntitle: Alpha\n---\n\nContent.");
    writeFileSync(join(tmp, "page2.md"), "Beta content without frontmatter.");
    const pages = listVaultPages(tmp);
    expect(pages.length).toBe(2);
    const titles = pages.map((p) => p.title);
    expect(titles).toContain("Alpha");
    expect(titles).toContain("page2");
  });

  test("skips excluded dirs", () => {
    writeFileSync(join(tmp, "page.md"), "Content.");
    mkdirSync(join(tmp, ".obsidian"));
    writeFileSync(join(tmp, ".obsidian", "hidden.md"), "Hidden.");
    expect(listVaultPages(tmp).length).toBe(1);
  });

  test("skips excluded files (index.md, log.md)", () => {
    writeFileSync(join(tmp, "page.md"), "Content.");
    writeFileSync(join(tmp, "index.md"), "Index.");
    const pages = listVaultPages(tmp);
    expect(pages.length).toBe(1);
    expect(pages[0]!.title).toBe("page");
  });
});

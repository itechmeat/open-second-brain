import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEGRADATION_CODE, type DegradationNotice } from "../../src/core/integrity/degradation.ts";
import {
  FrontmatterKeyError,
  extractWikilinks,
  formatFrontmatter,
  listVaultPages,
  parseFrontmatter,
  parseFrontmatterText,
  parseFrontmatterTextWithNotices,
  parseFrontmatterWithNotices,
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

  test("parses block-style YAML list into an array", () => {
    // Regression: the frontmatter reader only understood inline arrays
    // (`tags: [a, b]`) and silently dropped block sequences
    // (`tags:\n  - a\n  - b`). Block lists are what Obsidian's Properties
    // editor and several writers emit, so the dropped `tags` surfaced as
    // spurious `signal missing field: tags` errors in `o2b brain doctor`.
    const path = join(tmp, "note.md");
    writeFileSync(
      path,
      "---\nkind: brain-signal\ntags:\n  - brain\n  - brain/signal\n  - brain/topic/foo\ntopic: foo\nsignal: positive\n---\n\nBody.\n",
    );
    const [meta, body] = parseFrontmatter(path);
    expect(meta["kind"]).toBe("brain-signal");
    expect(meta["tags"]).toEqual(["brain", "brain/signal", "brain/topic/foo"]);
    expect(meta["topic"]).toBe("foo");
    expect(meta["signal"]).toBe("positive");
    expect(body).toBe("Body.");
  });

  test("block list with a bare empty dash item is not silently dropped", () => {
    // Regression for the CodeRabbit edge case: an isolated `-` (or `- `)
    // must NOT reset blockKey and drop the rest of the list. The empty
    // item surfaces as an empty-string element, and subsequent items are
    // still captured.
    const path = join(tmp, "note.md");
    writeFileSync(path, "---\ntags:\n  - brain\n  -\n  - brain/signal\n---\n\nBody.\n");
    const [meta] = parseFrontmatter(path);
    expect(meta["tags"]).toEqual(["brain", "", "brain/signal"]);
  });

  test("dash-prefixed string without whitespace is not a list item", () => {
    // `-foo` has no space after the dash, so it must NOT be parsed as a
    // block-list item (only `- foo` / bare `-` count). As a lone line it
    // is simply ignored as a non-key/value line.
    const path = join(tmp, "note.md");
    writeFileSync(path, "---\nkey: value\n-foo\nother: end\n---\n\nBody.\n");
    const [meta] = parseFrontmatter(path);
    expect(meta["key"]).toBe("value");
    expect(meta["other"]).toBe("end");
    expect(meta["-foo"]).toBeUndefined();
  });

  test("block-style list with quoted items parses as strings", () => {
    const path = join(tmp, "note.md");
    writeFileSync(path, '---\ntags:\n  - plain\n  - "needs, comma"\ntitle: Mixed\n---\n\nBody.\n');
    const [meta] = parseFrontmatter(path);
    expect(meta["tags"]).toEqual(["plain", "needs, comma"]);
  });

  test("empty scalar key (no following dash list) round-trips as empty string", () => {
    // A genuine null scalar (`key:` with no block list after it) must
    // stay an empty string, not be misread as a block-sequence header.
    const path = join(tmp, "note.md");
    writeFileSync(path, "---\ntitle: Hello\nsummary:\nbody: A note\n---\n\nBody.\n");
    const [meta] = parseFrontmatter(path);
    expect(meta["summary"]).toBe("");
    expect(meta["body"]).toBe("A note");
  });

  test("block list and inline array interleave correctly", () => {
    const path = join(tmp, "note.md");
    writeFileSync(path, "---\ninline: [x, y]\nblock:\n  - a\n  - b\ntail: end\n---\n\nBody.\n");
    const [meta] = parseFrontmatter(path);
    expect(meta["inline"]).toEqual(["x", "y"]);
    expect(meta["block"]).toEqual(["a", "b"]);
    expect(meta["tail"]).toBe("end");
  });

  test("handles missing file gracefully", () => {
    const [meta, body] = parseFrontmatter("/nonexistent/file.md");
    expect(meta).toEqual({});
    expect(body).toBe("");
  });
});

describe("parseFrontmatterWithNotices", () => {
  test("a dash-prefixed non-list line yields exactly one notice naming the line", () => {
    // `-foo` is pinned above as "simply ignored as a non-key/value line".
    // Ignoring it is still the right control flow; what was missing is the
    // trace. The parse result must stay identical to `parseFrontmatterText`.
    const text = "---\nkey: value\n-foo\nother: end\n---\n\nBody.\n";
    const [meta, body, notices] = parseFrontmatterTextWithNotices(text);
    expect(meta["key"]).toBe("value");
    expect(meta["other"]).toBe("end");
    expect(meta["-foo"]).toBeUndefined();
    expect(body).toBe("Body.");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.code).toBe(DEGRADATION_CODE.frontmatterLineDropped);
    expect(notices[0]!.detail).toContain("-foo");
  });

  test("supported grammar produces no notices at all", () => {
    // The block-list regression from 426d06f8 is SUPPORTED grammar, so it
    // must parse and stay silent. Blank lines and `#` comments are content
    // the format expects to skip and are likewise not drops.
    const text =
      "---\nkind: brain-signal\n\n# a comment\ntags:\n  - brain\n  - brain/signal\n  -\ninline: [x, y]\nsummary:\ntopic: foo\n---\n\nBody.\n";
    const [meta, , notices] = parseFrontmatterTextWithNotices(text);
    expect(meta["tags"]).toEqual(["brain", "brain/signal", ""]);
    expect(meta["inline"]).toEqual(["x", "y"]);
    expect(meta["summary"]).toBe("");
    expect(notices).toEqual([]);
  });

  test("a note with no frontmatter block at all produces no notices", () => {
    const [meta, body, notices] = parseFrontmatterTextWithNotices("Just a note.");
    expect(meta).toEqual({});
    expect(body).toBe("Just a note.");
    expect(notices).toEqual([]);
  });

  test("an orphan block-list item outside any open key is reported", () => {
    // A dash item with no preceding `key:` header has nowhere to land, so
    // the scanner drops it. Today that is structurally silent.
    const text = "---\n- orphan\ntitle: T\n---\n\nBody.\n";
    const [meta, , notices] = parseFrontmatterTextWithNotices(text);
    expect(meta["title"]).toBe("T");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.code).toBe(DEGRADATION_CODE.frontmatterLineDropped);
    expect(notices[0]!.detail).toContain("orphan");
  });

  test("every dropped line is reported, and the notice carries the caller's site and path", () => {
    const text = "---\nkey: value\n-foo\n> folded\ntitle: T\n---\n\nBody.\n";
    const [, , notices] = parseFrontmatterTextWithNotices(text, {
      site: "unit-test",
      path: "notes/a.md",
    });
    expect(notices).toHaveLength(2);
    for (const n of notices) {
      expect(n.site).toBe("unit-test");
      expect(n.path).toBe("notes/a.md");
    }
  });

  test("an unreadable file yields one frontmatter-unreadable notice naming the path", () => {
    const missing = join(tmp, "nope", "gone.md");
    const [meta, body, notices] = parseFrontmatterWithNotices(missing);
    expect(meta).toEqual({});
    expect(body).toBe("");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.code).toBe(DEGRADATION_CODE.frontmatterUnreadable);
    expect(notices[0]!.path).toBe(missing);
  });

  test("the path form attributes line drops to the file it read", () => {
    const path = join(tmp, "note.md");
    writeFileSync(path, "---\nkey: value\n-foo\n---\n\nBody.\n");
    const [meta, , notices] = parseFrontmatterWithNotices(path, { site: "unit-test" });
    expect(meta["key"]).toBe("value");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.path).toBe(path);
    expect(notices[0]!.site).toBe("unit-test");
  });

  test("the two-tuple functions delegate and stay byte-identical", () => {
    const text = "---\nkey: value\n-foo\ntags:\n  - a\n---\n\nBody.\n";
    const [meta, body] = parseFrontmatterText(text);
    const [metaN, bodyN] = parseFrontmatterTextWithNotices(text);
    expect(meta).toEqual(metaN);
    expect(body).toBe(bodyN);

    const path = join(tmp, "note.md");
    writeFileSync(path, text);
    const [fileMeta, fileBody] = parseFrontmatter(path);
    const [fileMetaN, fileBodyN, notices] = parseFrontmatterWithNotices(path);
    expect(fileMeta).toEqual(fileMetaN);
    expect(fileBody).toBe(fileBodyN);
    expect(notices).toHaveLength(1);
  });

  test("a very long dropped line is truncated in the notice detail", () => {
    const long = "x".repeat(500);
    const [, , notices] = parseFrontmatterTextWithNotices(`---\n${long}\n---\n\nBody.\n`);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.detail.length).toBeLessThan(300);
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

  test("an opt-in notices sink collects dropped frontmatter lines per page", () => {
    writeFileSync(join(tmp, "clean.md"), "---\ntitle: Alpha\ntags:\n  - a\n---\n\nContent.");
    writeFileSync(join(tmp, "odd.md"), "---\ntitle: Beta\n-foo\n---\n\nContent.");
    const notices: DegradationNotice[] = [];
    const pages = listVaultPages(tmp, { notices });
    // Control flow unchanged: the odd page is still listed.
    expect(pages.length).toBe(2);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.code).toBe(DEGRADATION_CODE.frontmatterLineDropped);
    expect(notices[0]!.path).toBe(join(tmp, "odd.md"));
  });

  test("the notices sink stays empty for a vault with supported grammar only", () => {
    writeFileSync(join(tmp, "clean.md"), "---\ntitle: Alpha\ntags:\n  - a\n---\n\nContent.");
    writeFileSync(join(tmp, "plain.md"), "No frontmatter at all.");
    const notices: DegradationNotice[] = [];
    listVaultPages(tmp, { notices });
    expect(notices).toEqual([]);
  });

  test("a directory the walker cannot read is reported instead of vanishing", () => {
    writeFileSync(join(tmp, "page.md"), "Content.");
    const locked = join(tmp, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inner.md"), "Inner.");
    chmodSync(locked, 0o000);
    const notices: DegradationNotice[] = [];
    try {
      const pages = listVaultPages(tmp, { notices });
      // Same control flow as before: the unreadable subtree is skipped.
      expect(pages.length).toBe(1);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.code).toBe(DEGRADATION_CODE.vaultWalkEntrySkipped);
      expect(notices[0]!.path).toBe(locked);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("formatFrontmatter refuses a key the parser could not read back", () => {
  // The emitter escaped VALUES but emitted KEYS raw, so a key carrying a
  // newline emitted extra frontmatter lines. Because `update_note` merges
  // `{...existing, ...caller}` and the scanner is last-wins, that let a
  // caller override a frontmatter key it was not asked to touch. The
  // guarantee belongs at the emitter so every writer inherits it.
  for (const [label, key] of [
    ["a newline", "title\nowner"],
    ["a carriage return", "title\rowner"],
    ["a colon", "ti:tle"],
    ["a leading digit", "1title"],
    ["a space", "my title"],
    ["an empty key", ""],
  ] as const) {
    test(`${label} is refused`, () => {
      expect(() => formatFrontmatter({ [key]: "v" }, "body")).toThrow(FrontmatterKeyError);
    });
  }

  test("a conforming key still round-trips through the parser", () => {
    const text = formatFrontmatter({ title: "T", owner_name: "a-b", x2: "v" }, "body");
    const [meta] = parseFrontmatterText(text);
    expect(meta).toEqual({ title: "T", owner_name: "a-b", x2: "v" });
  });

  test("the refusal fires before any byte reaches disk", () => {
    const path = join(tmp, "note.md");
    expect(() => writeFrontmatter(path, { "a\nb: c": "v" }, "body")).toThrow(FrontmatterKeyError);
    expect(existsSync(path)).toBe(false);
  });
});

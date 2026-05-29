/**
 * Deterministic session codec (Vault portability suite, Feature 1).
 *
 * A pure, lossless, language-agnostic codec: `expand(compress(x)) === x`
 * for ALL input (brain memory must never lose data), with token savings
 * from reversibly collapsing whitespace and blank-line runs. Fenced and
 * inline code are protected (never altered), and structured content
 * (URLs, paths, identifiers, version numbers) is preserved byte-for-byte
 * by construction. No language word lists; detection is structural.
 */

import { describe, expect, test } from "bun:test";

import { compress, expand, CODEC_VERSION } from "../../../../src/core/brain/portability/codec.ts";

const FIXTURES: ReadonlyArray<{ name: string; text: string }> = [
  { name: "empty", text: "" },
  { name: "whitespace only", text: "   \n\n\n\t  " },
  { name: "plain prose", text: "The quick brown fox jumps over the lazy dog." },
  {
    name: "prose with blank-line runs",
    text: "First paragraph.\n\n\n\nSecond paragraph after several blanks.\n\n\nEnd.",
  },
  {
    name: "deep indentation",
    text: "root\n        deeply indented line with eight leading spaces\nback",
  },
  {
    name: "structured content",
    text: "See https://example.com/a/b?x=1#frag and /usr/local/lib/foo.ts plus foo_bar.BazQux and v1.2.3-rc.4.",
  },
  {
    name: "fenced code block with significant indentation",
    text: "intro\n\n```ts\nfunction f() {\n    return  [1,   2,    3];\n}\n```\n\noutro",
  },
  {
    name: "inline code with runs",
    text: "use `a    b` and `c\td` inline, then    four spaces in prose.",
  },
  {
    name: "literal sentinel in input (PUA char)",
    text: "edge  case with a private-use char and  doubled.",
  },
  {
    name: "mixed agent observation",
    text: "## Turn 3\n\nThe agent ran:\n\n```bash\ngit commit -m 'x'\n```\n\nResult: ok.\n\n\nNext step at /tmp/out.\n",
  },
];

describe("session codec", () => {
  test("exposes a CODEC_VERSION", () => {
    expect(typeof CODEC_VERSION).toBe("string");
    expect(CODEC_VERSION.length).toBeGreaterThan(0);
  });

  test("round-trips every fixture exactly (lossless)", () => {
    for (const f of FIXTURES) {
      expect(expand(compress(f.text))).toBe(f.text);
    }
  });

  test("never expands the payload for sentinel-free input (compressed <= original)", () => {
    // The codec only ever shrinks or matches, EXCEPT when the raw input
    // already contains the private-use sentinel (never true for real text),
    // which must be escaped (+1 char each) to keep round-trip exact.
    const SENTINEL = String.fromCodePoint(0xe000);
    for (const f of FIXTURES) {
      if (f.text.includes(SENTINEL)) continue;
      expect(compress(f.text).length).toBeLessThanOrEqual(f.text.length);
    }
  });

  test("escaping keeps round-trip exact even when input contains the sentinel", () => {
    const withSentinel = "before  middle  after";
    expect(expand(compress(withSentinel))).toBe(withSentinel);
  });

  test("actually shrinks blank-line and indentation runs", () => {
    const text = "a\n\n\n\n\n\nb"; // six newlines
    expect(compress(text).length).toBeLessThan(text.length);
    expect(expand(compress(text))).toBe(text);
  });

  test("preserves structured content byte-for-byte in the compressed form", () => {
    const text = "url https://example.com/x and path /a/b/c.ts and ver 1.2.3";
    const c = compress(text);
    // No whitespace runs to collapse here, so the structured tokens survive verbatim.
    expect(c).toContain("https://example.com/x");
    expect(c).toContain("/a/b/c.ts");
    expect(c).toContain("1.2.3");
  });

  test("does not collapse whitespace inside fenced or inline code", () => {
    const fenced = "```\n    indented    code\n```";
    expect(expand(compress(fenced))).toBe(fenced);
    const inline = "`a    b`";
    // Inline code content is protected: round-trip exact and untouched.
    expect(expand(compress(inline))).toBe(inline);
  });

  test("is deterministic", () => {
    const text = FIXTURES[5]!.text;
    expect(compress(text)).toBe(compress(text));
  });

  test("expand tolerates non-codec text (no markers) by returning it unchanged", () => {
    expect(expand("just plain text, never compressed")).toBe(
      "just plain text, never compressed",
    );
  });
});

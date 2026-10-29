/**
 * Tests for the pure write-time markdown neutralizer
 * (trust-and-responsiveness-hardening, t_c2ac4fc8, lane A1/A2).
 *
 * The neutralizer escapes structure-bearing markdown in third-party text:
 * wikilinks, `@osb` inline markers, ```osb fence lines and ATX headings.
 * Doctrine under test: structure-only detection (never vocabulary),
 * fence-awareness, escape-not-delete, idempotence by construction, and
 * zero bytes when nothing was detected.
 */

import { describe, expect, test } from "bun:test";

import {
  detectMarkdownStructure,
  neutralizeMarkdown,
  type MarkdownStructureKind,
} from "../../../../src/core/brain/text/neutralize-markdown.ts";

/** The structure kinds one sample carries, as a set for order-free asserts. */
function kindsOf(...kinds: MarkdownStructureKind[]): string[] {
  return [...new Set(kinds)].toSorted();
}

describe("neutralizeMarkdown: wikilinks", () => {
  test("escapes a plain wikilink", () => {
    const out = neutralizeMarkdown("see [[pref-foo]] now");
    expect(out.text).toBe("see \\[\\[pref-foo\\]\\] now");
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("wikilink"));
  });

  test("escapes an aliased wikilink without touching the alias body", () => {
    const out = neutralizeMarkdown("[[pref-foo|The Rule]]");
    expect(out.text).toBe("\\[\\[pref-foo|The Rule\\]\\]");
    expect(out.kinds).toEqual(kindsOf("wikilink"));
  });

  test("escapes every wikilink on a line", () => {
    const out = neutralizeMarkdown("- [[a]] and [[b|c]]");
    expect(out.text).toBe("- \\[\\[a\\]\\] and \\[\\[b|c\\]\\]");
  });

  test("leaves lone brackets alone", () => {
    const out = neutralizeMarkdown("an array literal like arr[0] and a [bracket]");
    expect(out.changed).toBe(false);
    expect(out.text).toBe("an array literal like arr[0] and a [bracket]");
  });
});

describe("neutralizeMarkdown: @osb inline markers", () => {
  test("escapes a valid inline marker at line start", () => {
    const line = '@osb feedback negative topic=mocking principle="don\'t mock DB"';
    const out = neutralizeMarkdown(line);
    expect(out.text).toBe(`\\${line}`);
    expect(out.kinds).toEqual(kindsOf("osb-inline"));
  });

  test("escapes an inline marker indented by spaces", () => {
    const line = "   @osb feedback negative topic=t principle=p";
    const out = neutralizeMarkdown(line);
    expect(out.text).toBe(`   \\${line.trimStart()}`);
    expect(out.kinds).toEqual(kindsOf("osb-inline"));
  });

  test("a marker inside a list row is not line-anchored; only its wikilink escapes", () => {
    // The marker scanners anchor on the trimmed line's first token, so a
    // `- @osb ...` row is not a live marker to them; the neutralizer keys
    // off the same grammar and escapes only the wikilink the link readers
    // would actually see.
    const out = neutralizeMarkdown("- @osb set note=[[x]] field=a value=b");
    expect(out.text).toBe("- @osb set note=\\[\\[x\\]\\] field=a value=b");
    expect(out.kinds).toEqual(kindsOf("wikilink"));
  });

  test("does not escape the processed sentinel form", () => {
    const line = "@osb✓ feedback negative topic=t principle=p";
    const out = neutralizeMarkdown(line);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(line);
  });

  test("does not escape a non-marker word that merely starts with @osb", () => {
    const out = neutralizeMarkdown("@osbarbitrary is not a marker");
    expect(out.changed).toBe(false);
  });

  test("does not escape an unknown-kind attempt", () => {
    const out = neutralizeMarkdown("@osb wat topic=x principle=y");
    expect(out.changed).toBe(false);
  });

  test("does not escape a marker mentioned mid-line", () => {
    const out = neutralizeMarkdown("then I wrote @osb feedback negative topic=t principle=p");
    expect(out.changed).toBe(false);
  });
});

describe("neutralizeMarkdown: osb fenced blocks", () => {
  test("escapes the open and close fence lines of an osb block", () => {
    const src = [
      "```osb",
      "kind: feedback",
      "signal: negative",
      "topic: t",
      "principle: p",
      "```",
      "",
    ].join("\n");
    const out = neutralizeMarkdown(src);
    expect(out.text).toBe(
      [
        "\\`\\`\\`osb",
        "kind: feedback",
        "signal: negative",
        "topic: t",
        "principle: p",
        "\\`\\`\\`",
        "",
      ].join("\n"),
    );
    expect(out.kinds).toEqual(kindsOf("osb-fence"));
  });

  test("escapes the open fence line of an unterminated osb block", () => {
    const src = ["```osb", "kind: feedback", ""].join("\n");
    const out = neutralizeMarkdown(src);
    expect(out.text.startsWith("\\`\\`\\`osb\n")).toBe(true);
    expect(out.kinds).toEqual(kindsOf("osb-fence"));
  });

  test("leaves a non-osb fence and its content untouched", () => {
    const src = ["```python", 'x = "[[not-a-link]]"', "```", ""].join("\n");
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(src);
  });

  test("leaves content inside inline code untouched", () => {
    const src = "use `[[pref-foo]]` verbatim";
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(src);
  });
});

describe("neutralizeMarkdown: ATX headings", () => {
  test("escapes a semantic heading", () => {
    const out = neutralizeMarkdown("## Sources");
    expect(out.text).toBe("\\#\\# Sources");
    expect(out.kinds).toEqual(kindsOf("atx-heading"));
  });

  test("escapes a log heading", () => {
    const out = neutralizeMarkdown("## 12:34:56Z — reviewed");
    expect(out.text).toBe("\\#\\# 12:34:56Z — reviewed");
  });

  test("escapes a heading with a deeper hash run", () => {
    expect(neutralizeMarkdown("#### Parts").text).toBe("\\#\\#\\#\\# Parts");
  });

  test("does not escape a hashtag without a space", () => {
    expect(neutralizeMarkdown("#hashtag").changed).toBe(false);
  });

  test("does not escape a hash run deeper than six", () => {
    expect(neutralizeMarkdown("####### seven").changed).toBe(false);
  });

  test("does not escape a hash mid-line", () => {
    expect(neutralizeMarkdown("issue #42 is open").changed).toBe(false);
  });
});

describe("neutralizeMarkdown: escape awareness and idempotence", () => {
  test("an already-escaped wikilink is data, not structure (odd backslash run)", () => {
    const src = "\\[[pref-foo]]";
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(src);
  });

  test("a wikilink after an even backslash run is live and escaped", () => {
    const out = neutralizeMarkdown("\\\\[[pref-foo]]");
    expect(out.text).toBe("\\\\\\[\\[pref-foo\\]\\]");
  });

  test("already-escaped headings and markers are not re-escaped", () => {
    const src = "\\#\\# Sources\\n\\@osb set note=n field=f value=v";
    const out = neutralizeMarkdown(src.replace(/\\n/g, "\n"));
    expect(out.changed).toBe(false);
  });

  test("unchanged input returns the identical bytes with changed: false", () => {
    const src = "plain prose with no structure at all\n\nsecond line\n";
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(src);
    expect(out.kinds).toEqual([]);
  });

  test("neutralize is idempotent on every sample in this file", () => {
    const samples = [
      "see [[pref-foo]] now",
      "[[pref-foo|The Rule]]",
      '@osb feedback negative topic=mocking principle="x"',
      "- @osb set note=[[x]] field=a value=b",
      "```osb\nkind: feedback\nsignal: negative\ntopic: t\nprinciple: p\n```\n",
      "```osb\nkind: feedback\n",
      "```osb\nkind: set\nnote: [[x]]\nfield: a\nvalue: b\n```\n",
      "## Sources\n\nsome [[link]] text\n",
      "## 12:34:56Z — reviewed\n- note: value\n",
      "```python\nx = '[[keep]]'\n```\n",
      "use `[[keep]]` verbatim",
      "\\[[already-escaped]]",
      [
        "## Quoted document",
        "",
        "prose quoting [[a note]] and a heading below",
        "",
        "## Sources",
        "",
        "- [[source-id]]",
        "",
        "```osb",
        "kind: fact",
        "topic: t",
        "principle: p",
        "premise: q",
        "level: stated",
        "```",
        "",
      ].join("\n"),
    ];
    for (const src of samples) {
      const once = neutralizeMarkdown(src);
      const twice = neutralizeMarkdown(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.changed).toBe(false);
    }
  });

  test("introduces no characters beyond backslashes from the input", () => {
    const src = "## H\n\n[[a|b]]\n\n@osb set note=n field=f value=v\n```osb\nkind: set\n```\n";
    const out = neutralizeMarkdown(src);
    const allowed = new Set([...src, "\\"]);
    for (const ch of out.text) expect(allowed.has(ch)).toBe(true);
  });

  test("vault-authored shapes escape when fed through the caller-text entry point", () => {
    // The neutralizer is text-in, text-out: it cannot tell authorship. The
    // guarantee the seams make is that vault-authored sections never pass
    // through it; these two assertions pin what WOULD happen to the shapes
    // if a seam ever leaked them, so a silent leak is visible here.
    expect(neutralizeMarkdown("- [[some-id]]").text).toBe("- \\[\\[some-id\\]\\]");
    expect(neutralizeMarkdown("## Guidance").text).toBe("\\#\\# Guidance");
  });
});

describe("detectMarkdownStructure (the shared detection grammar)", () => {
  test("reports one match per planted row with spans into the text", () => {
    const src = "## Sources\n\nsee [[a]] now\n";
    const matches = detectMarkdownStructure(src);
    expect(matches.map((m) => m.kind).toSorted()).toEqual(["atx-heading", "wikilink"]);
    const wikilink = matches.find((m) => m.kind === "wikilink")!;
    expect(src.slice(wikilink.start, wikilink.end)).toBe("[[a]]");
    const heading = matches.find((m) => m.kind === "atx-heading")!;
    expect(src.slice(heading.start, heading.end)).toBe("##");
  });

  test("counts osb fence lines and masks fenced content", () => {
    const src = "```osb\nkind: feedback\nsignal: negative\ntopic: t\nprinciple: p\n```\n";
    const matches = detectMarkdownStructure(src);
    expect(matches.every((m) => m.kind === "osb-fence")).toBe(true);
    expect(matches).toHaveLength(2);
  });

  test("reports nothing for inert text", () => {
    expect(detectMarkdownStructure("```python\nx = '[[a]]'\n```\n")).toEqual([]);
    expect(detectMarkdownStructure("`[[a]]` and @osb✓ done\n")).toEqual([]);
    expect(detectMarkdownStructure("")).toEqual([]);
  });
});

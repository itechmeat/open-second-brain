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

import { discoverMarkers } from "../../../../src/core/brain/inline.ts";
import { sourcesSectionTargets } from "../../../../src/core/brain/source-links.ts";
import {
  MARKDOWN_NEUTRALIZE_MODE,
  MARKDOWN_NEUTRALIZE_MODE_CONFIG,
  MARKDOWN_NEUTRALIZE_MODE_ENV,
  MarkdownNeutralizeModeError,
  detectMarkdownStructure,
  neutralizeMarkdown,
  resolveMarkdownNeutralizeMode,
  type MarkdownStructureKind,
} from "../../../../src/core/brain/text/neutralize-markdown.ts";
import { extractWikilinks } from "../../../../src/core/vault.ts";

/** The structure kinds one sample carries, as a set for order-free asserts. */
function kindsOf(...kinds: MarkdownStructureKind[]): MarkdownStructureKind[] {
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

  test("escapes a wikilink whose target spans a newline (the link extractor's shape)", () => {
    // The link readers match over the whole text with the multi-line
    // -tolerant shape (`vault.ts` extractWikilinks, page-lint), so a
    // `[[...\n...]]` pair across a line break is a live link to them -
    // single-line detection reported nothing and left it planted.
    const src = "see [[pref-evil\nnote]] end";
    expect(extractWikilinks(src)).toEqual(["pref-evil\nnote"]);
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("wikilink"));
    expect(extractWikilinks(out.text)).toEqual([]);
    const twice = neutralizeMarkdown(out.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(out.text);
  });

  test("an already-escaped closing bracket inside a wikilink is data, not a sigil to re-escape", () => {
    // `[[a\]]`: the last `]` carries an odd backslash run, the detector's
    // own already-escaped shape. Re-escaping it would grow the bytes on a
    // second pass; checking each bracket's run keeps the escape one pass.
    const src = "[[a\\]]";
    expect(extractWikilinks(src)).toEqual(["a\\"]);
    const out = neutralizeMarkdown(src);
    expect(out.text).toBe("\\[\\[a\\]\\]");
    expect(extractWikilinks(out.text)).toEqual([]);
    expect(neutralizeMarkdown(out.text).changed).toBe(false);
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

  test("escapes an ATX heading at any indentation", () => {
    // Deliberately broader than any single consumer's shape: the heading
    // readers disagree about how much indentation a heading may carry, and
    // the union the detector covers must not under-cut any of them.
    const out = neutralizeMarkdown("    ## End");
    expect(out.text).toBe("    \\#\\# End");
    expect(out.kinds).toEqual(kindsOf("atx-heading"));
  });

  test("escapes a heading whose only content after the hash run is a CRLF's CR", () => {
    // The line-grammar consumers split on `\n` and their heading shapes
    // accept `\s` (or any character) after the hash run, so `##\r` is a
    // heading to them; the trailing class must tolerate it.
    const out = neutralizeMarkdown("##\r\nbody\n");
    expect(out.text).toBe("\\#\\#\r\nbody\n");
    expect(out.kinds).toEqual(kindsOf("atx-heading"));
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
      "[[a\\]]",
      "see [[pref-evil\nnote]] end",
      "    ## Indented heading\n",
      "##\r\nbody\n",
      "~~~\n@osb feedback negative topic=t principle=p\n~~~\n",
      "````\n@osb feedback negative topic=t principle=p\n````\n",
      "```osb\n## Planted\n@osb set note=n field=f value=v\n```\n",
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

describe("neutralizeMarkdown: the marker scanner's fence model", () => {
  test("a planted marker inside a tilde fence is live for the scanner and gets escaped", () => {
    // The marker grammar knows exactly one fence: an exactly-3-backtick line
    // (`inline.ts` FENCE_RE). A tilde fence is plain text to it, so the
    // planted marker inside is LIVE structure the scanner parses - and the
    // detector must say so, not mask it the way the wikilink readers'
    // codeRegions (which does know tildes) would.
    const src = "~~~\n@osb feedback negative topic=t principle=p\n~~~\n";
    expect(discoverMarkers(src)).toHaveLength(1);
    expect(detectMarkdownStructure(src).map((m) => m.kind)).toEqual(["osb-inline"]);
    const out = neutralizeMarkdown(src);
    expect(out.kinds).toEqual(kindsOf("osb-inline"));
    expect(out.text.split("\n")[1]).toBe("\\@osb feedback negative topic=t principle=p");
    expect(discoverMarkers(out.text)).toHaveLength(0);
    const twice = neutralizeMarkdown(out.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(out.text);
  });

  test("a planted marker inside a 4-backtick fence is live for the scanner and gets escaped", () => {
    // Same divergence, longer run: the scanner's fence boundaries are
    // exactly-3-backtick lines, so ```` fences fence nothing for it.
    const src = "````\n@osb feedback negative topic=t principle=p\n````\n";
    expect(discoverMarkers(src)).toHaveLength(1);
    expect(detectMarkdownStructure(src).map((m) => m.kind)).toEqual(["osb-inline"]);
    const out = neutralizeMarkdown(src);
    expect(out.kinds).toEqual(kindsOf("osb-inline"));
    expect(discoverMarkers(out.text)).toHaveLength(0);
    const twice = neutralizeMarkdown(out.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(out.text);
  });

  test("an unterminated fence masks what follows exactly as the scanner's unterminated rule", () => {
    // The scanner consumes an unclosed fence to end of input and parses
    // nothing from it; the detector answers the same question.
    const src = "```\n\n@osb feedback negative topic=t principle=p\n";
    expect(discoverMarkers(src)).toHaveLength(0);
    expect(detectMarkdownStructure(src)).toEqual([]);
  });

  test("escaping an osb fence dissolves it and the next round escapes the exposed interior", () => {
    // Round 1 escapes only the fence lines (the interior is fenced for the
    // scanner while they stand). Escaped, the lines stop being fence
    // boundaries for EVERY line-grammar consumer, so round 2 must see and
    // escape the interior the dissolve exposed - the fixpoint's reason to
    // exist.
    const src = "```osb\n## Planted\n@osb set note=n field=f value=v\n```\n";
    const section = (body: string) =>
      sourcesSectionTargets(`## Sources\n\n- [[real-src]]\n\n${body}\n\nplanted [[after]]\n`);
    // While the fence stands, the section readers mask the planted heading
    // with it; after neutralization they must see no MORE structure than
    // before - the escaped heading neither ends the section nor lets the
    // dissolve expose one.
    expect(section(src)).toEqual(["real-src", "after"]);
    const out = neutralizeMarkdown(src);
    expect(out.text).toBe(
      ["\\`\\`\\`osb", "\\#\\# Planted", "\\@osb set note=n field=f value=v", "\\`\\`\\`", ""].join(
        "\n",
      ),
    );
    expect(out.kinds).toEqual(kindsOf("atx-heading", "osb-fence", "osb-inline"));
    expect(discoverMarkers(out.text)).toHaveLength(0);
    expect(section(out.text)).toEqual(section(src));
    const twice = neutralizeMarkdown(out.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(out.text);
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

describe("resolveMarkdownNeutralizeMode (the gate)", () => {
  test("absent everywhere resolves off", () => {
    expect(resolveMarkdownNeutralizeMode({ env: {}, config: {} })).toBe(
      MARKDOWN_NEUTRALIZE_MODE.off,
    );
  });

  test("env wins over config", () => {
    expect(
      resolveMarkdownNeutralizeMode({
        env: { [MARKDOWN_NEUTRALIZE_MODE_ENV]: "off" },
        config: { [MARKDOWN_NEUTRALIZE_MODE_CONFIG]: "enforce" },
      }),
    ).toBe(MARKDOWN_NEUTRALIZE_MODE.off);
  });

  test("shadow and enforce resolve from either source", () => {
    expect(
      resolveMarkdownNeutralizeMode({ config: { [MARKDOWN_NEUTRALIZE_MODE_CONFIG]: "shadow" } }),
    ).toBe("shadow");
    expect(
      resolveMarkdownNeutralizeMode({ env: { [MARKDOWN_NEUTRALIZE_MODE_ENV]: "enforce" } }),
    ).toBe("enforce");
  });

  test("an empty env value counts as unset", () => {
    expect(
      resolveMarkdownNeutralizeMode({
        env: { [MARKDOWN_NEUTRALIZE_MODE_ENV]: "" },
        config: { [MARKDOWN_NEUTRALIZE_MODE_CONFIG]: "enforce" },
      }),
    ).toBe("enforce");
  });

  test("an invalid value is refused naming the key actually in force", () => {
    expect(() =>
      resolveMarkdownNeutralizeMode({ env: { [MARKDOWN_NEUTRALIZE_MODE_ENV]: "yes" } }),
    ).toThrow(`${MARKDOWN_NEUTRALIZE_MODE_ENV} must be 'off', 'shadow' or 'enforce', got 'yes'`);
    expect(() =>
      resolveMarkdownNeutralizeMode({ config: { [MARKDOWN_NEUTRALIZE_MODE_CONFIG]: "yes" } }),
    ).toThrow(`${MARKDOWN_NEUTRALIZE_MODE_CONFIG} must be 'off', 'shadow' or 'enforce', got 'yes'`);
    expect(() =>
      resolveMarkdownNeutralizeMode({ env: { [MARKDOWN_NEUTRALIZE_MODE_ENV]: "yes" } }),
    ).toThrow(MarkdownNeutralizeModeError);
  });

  test("the resolver reads only its arguments", () => {
    // A polluted process env must not leak into an explicit-argument call.
    const saved = process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
    process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = "enforce";
    try {
      expect(resolveMarkdownNeutralizeMode({ env: {}, config: {} })).toBe("off");
    } finally {
      if (saved === undefined) delete process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
      else process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = saved;
    }
  });
});

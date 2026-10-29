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
  MarkdownNeutralizeFixpointError,
  MarkdownNeutralizeModeError,
  detectMarkdownStructure,
  neutralizeMarkdown,
  neutralizeMarkdownWithBound,
  resolveMarkdownNeutralizeMode,
  type MarkdownStructureKind,
} from "../../../../src/core/brain/text/neutralize-markdown.ts";
import { chunkMarkdown } from "../../../../src/core/search/chunker.ts";
import { extractWikilinkRichBodies } from "../../../../src/core/brain/link-graph/parse-wikilink.ts";
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

  test("an already-escaped closing bracket inside a wikilink is data: the span is not live", () => {
    // `[[a\]]`: the closing `]` carries an odd backslash run, so no link
    // reader extracts the span (isLiveWikilinkSpan fails on it) and no
    // consumer parses a link there - the detector applies the readers'
    // own live-span rule and leaves the bytes alone, adding zero bytes.
    // (The readers hold BOTH brackets to the rule, so the span is inert
    // even though its opening pair is unescaped.)
    const src = "[[a\\]]";
    expect(extractWikilinks(src)).toEqual([]);
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(src);
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
    // heading to them; the trailing class must tolerate it. The CRLF
    // itself folds to LF before detection (the line-break normalization)
    // and the fold is recorded in the kinds.
    const out = neutralizeMarkdown("##\r\nbody\n");
    expect(out.text).toBe("\\#\\#\nbody\n");
    expect(out.kinds).toEqual(kindsOf("atx-heading", "line-break"));
    // The standalone detector still scans unfolded bytes (the doctor's
    // audit runs it on stored pages), so the CR tolerance stays load-bearing there.
    const detected = detectMarkdownStructure("##\r\nbody\n");
    expect(detected.map((m) => m.kind)).toEqual(["atx-heading"]);
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

describe("neutralizeMarkdown: unusual line breaks are normalized first", () => {
  // CommonMark, Obsidian and every `/m`-regex line reader treat a bare CR,
  // NEL (U+0085), LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029)
  // as line ends, while the `\n`-splitting detectors (and OSB's own line
  // readers) do not - so `x\r# Planted` renders a heading the detector
  // would never see. The enforce-mode walk folds all of them to `\n`
  // before detection and records the rewrite in the result kinds, so the
  // `neutralized_markers` provenance names it. The capture and untrusted
  // ingest seams invoke the neutralizer only under `enforce` (their gate
  // branches precede every call), so `off` and `shadow` stay byte-identical
  // - asserted at the seam level in the capture and ingest suites.
  test("a planted heading behind a bare CR is caught and escaped", () => {
    const out = neutralizeMarkdown("x\r# Planted\n");
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("atx-heading", "line-break"));
    expect(out.text).toBe("x\n\\# Planted\n");
    expect(detectMarkdownStructure(out.text)).toEqual([]);
  });

  test("a planted marker behind NEL (U+0085) is caught and escaped", () => {
    const out = neutralizeMarkdown("x\u0085@osb feedback positive topic=t principle=p");
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("osb-inline", "line-break"));
    expect(out.text).toBe("x\n\\@osb feedback positive topic=t principle=p");
  });

  test("a planted heading behind LINE SEPARATOR (U+2028) is caught and escaped", () => {
    const out = neutralizeMarkdown("x\u2028# Planted\n");
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("atx-heading", "line-break"));
    expect(out.text).toBe("x\n\\# Planted\n");
  });

  test("a planted heading behind PARAGRAPH SEPARATOR (U+2029) is caught and escaped", () => {
    const out = neutralizeMarkdown("x\u2029# Planted\n");
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("atx-heading", "line-break"));
    expect(out.text).toBe("x\n\\# Planted\n");
  });

  test("a CRLF body folds to LF and the rewrite is recorded even with no structure", () => {
    const src = "plain\r\nprose\r\n";
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("line-break"));
    expect(out.text).toBe("plain\nprose\n");
    const twice = neutralizeMarkdown(out.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(out.text);
  });

  test("the normalized-and-escaped output is idempotent per separator", () => {
    for (const src of ["x\r# P\n", "x\u0085# P\n", "x\u2028# P\n", "x\u2029# P\n"]) {
      const once = neutralizeMarkdown(src);
      const twice = neutralizeMarkdown(once.text);
      expect(twice.changed).toBe(false);
      expect(twice.text).toBe(once.text);
    }
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

describe("neutralizeMarkdown: wikilink reader parity (escaped brackets)", () => {
  // The detector and extractWikilinks must answer "is this a link?" with
  // ONE truth: whatever the detector leaves (already-escaped data) the
  // extractor must find inert, so an enforce-mode write can never leave
  // bytes that still join the link graph - and the doctor's planted-rows
  // audit, which runs the same detection, counts exactly the rows the
  // readers would have extracted.
  const adversarial = [
    "\\[[pref-evil]] see",
    "\\[[pref-evil\nnote]] see",
    "\\\\[[pref-evil]] see",
    "[[pref-evil\\]] see",
    "[[pref-evil\nnote\\]] see",
  ];

  test("neutralize output of adversarial escaped-bracket inputs extracts zero links", () => {
    for (const src of adversarial) {
      const out = neutralizeMarkdown(src);
      expect(extractWikilinks(out.text)).toEqual([]);
    }
  });

  test("an escaped multi-line wikilink is inert to both the detector and the extractor", () => {
    const src = "\\[[pref-evil\nnote]] see";
    expect(detectMarkdownStructure(src)).toEqual([]);
    expect(neutralizeMarkdown(src).changed).toBe(false);
    expect(extractWikilinks(src)).toEqual([]);
  });

  test("the idempotence fixpoint holds on the escaped-bracket inputs", () => {
    for (const src of adversarial) {
      const once = neutralizeMarkdown(src);
      const twice = neutralizeMarkdown(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.changed).toBe(false);
    }
  });
});

describe("neutralizeMarkdown: wikilinks spanning inline code (the readers' masked view)", () => {
  // The link readers do not scan the raw bytes: they first replace every
  // code region (fence or inline span) with a space and match on THAT
  // view, so a `[[target|`code`]]` span whose brackets sit outside the
  // region still extracts a live target from them. The detector must ask
  // the same question over the same view - masking code regions with a
  // length-preserving fill keeps every match offset identical to the raw
  // text - or a span the raw scan dismisses as "overlapping code" stays
  // live in the vault's link graph under `enforce`.
  test("a wikilink carrying an inline code span is caught and escaped, and extracts nothing", () => {
    const src = "Quoted thread: see [[Evil Page|`x`]] for details";
    expect(extractWikilinks(src)).toEqual(["Evil Page"]);
    expect(extractWikilinkRichBodies(src)).toEqual(["Evil Page| "]);
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("wikilink"));
    expect(out.text).toBe("Quoted thread: see \\[\\[Evil Page|`x`\\]\\] for details");
    expect(extractWikilinks(out.text)).toEqual([]);
    expect(extractWikilinkRichBodies(out.text)).toEqual([]);
    const twice = neutralizeMarkdown(out.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(out.text);
  });

  test("a fenced wikilink whose brackets sit outside the fence's line grammar is still caught", () => {
    // Inline spans, not just fenced blocks: any code region the readers
    // mask must mask the detector's view identically - and nothing more.
    const src = "note [[a|`b`]] and `[[c]]` end";
    expect(extractWikilinks(src)).toEqual(["a"]);
    const out = neutralizeMarkdown(src);
    expect(out.text).toBe("note \\[\\[a|`b`\\]\\] and `[[c]]` end");
    expect(out.kinds).toEqual(kindsOf("wikilink"));
    expect(extractWikilinks(out.text)).toEqual([]);
    expect(extractWikilinkRichBodies(out.text)).toEqual([]);
  });

  test("the wikilink scan stays linear on link-and-backtick heavy pages (was quadratic)", () => {
    // One planted row per line: a live link followed by an inline code
    // span - the shape that made the old detector re-scan every code
    // region for every match (quadratic). Measured on this Bun build:
    // 1.4 MB of this shape took ~6.1 s with the region-overlap test and
    // ~20 ms with the masked-view scan; the bound below leaves two orders
    // of magnitude of headroom on the fixed cost while still failing on
    // the quadratic shape.
    const page =
      "- [[Brain/log/note-0000]] ran `bun test --grep smoke` and more prose here\n".repeat(19_000);
    expect(page.length).toBeGreaterThan(1_000_000);
    const t0 = performance.now();
    const matches = detectMarkdownStructure(page);
    const elapsed = performance.now() - t0;
    expect(matches).toHaveLength(19_000);
    expect(elapsed).toBeLessThan(2_000);
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

describe("neutralizeMarkdown: the heading family answers to the chunker's fence model too", () => {
  // The search chunker is one more heading consumer, and its code-block
  // walk (chunker.ts readCodeBlock) closes ANY fence on the first later
  // line whose trimmed form starts with the same three-character mark -
  // info string or not - while the section readers' fencedLineMask closes
  // a 4-backtick fence only on a run of 4 or more. A heading after a ```
  // line inside a ```` fence therefore becomes a chunk headingPath even
  // though fencedLineMask still has the fence open; the detector must
  // escape it. (The chunker's model is pinned by CHUNKER_VERSION - changing
  // it would force a full vault re-chunk - so the detector carries the
  // union: a heading is escaped when either model leaves it live.)
  test("a heading after a ``` line inside a ```` fence is caught and escaped", () => {
    const src = "````\n```\n# Planted Section\n````\n\nbody text\n";
    expect(
      chunkMarkdown(src, null).chunks.some((c) => c.headingPath.includes("Planted Section")),
    ).toBe(true);
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(true);
    expect(out.kinds).toEqual(kindsOf("atx-heading"));
    expect(out.text.split("\n")[2]).toBe("\\# Planted Section");
    // The chunker no longer attributes a section to the escaped heading.
    for (const c of chunkMarkdown(out.text, null).chunks) {
      expect(c.headingPath.includes("Planted Section")).toBe(false);
    }
    const twice = neutralizeMarkdown(out.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(out.text);
  });

  test("a heading after a closer-with-info-string the chunker ends its block on is caught", () => {
    // ```js closes the chunker's block (trimmed startswith ```) but not
    // the section readers' (their closer must carry only whitespace), so
    // the heading after it is live for the chunker and must be escaped.
    const src = "```\n```js\n# Planted Section\n```\n\nbody text\n";
    expect(
      chunkMarkdown(src, null).chunks.some((c) => c.headingPath.includes("Planted Section")),
    ).toBe(true);
    const out = neutralizeMarkdown(src);
    expect(out.kinds).toEqual(kindsOf("atx-heading"));
    expect(out.text.split("\n")[2]).toBe("\\# Planted Section");
  });

  test("a heading inside a fence both models keep open stays untouched", () => {
    // The union only widens detection where the models DISAGREE; where
    // both mask the line, nothing is live and zero bytes are added.
    const src = "````\n# Inside\n````\n";
    expect(neutralizeMarkdown(src).changed).toBe(false);
    expect(neutralizeMarkdown(src).text).toBe(src);
  });

  test("a heading inside a plain 3-backtick fence stays untouched", () => {
    const src = "```python\n# not a heading\n```\n";
    expect(neutralizeMarkdown(src).changed).toBe(false);
  });
});

describe("neutralizeMarkdown: the fence context of the half before it", () => {
  // A capture page renders body, renderer separator+heading and guidance as
  // ONE text, and every scanner runs on that one text. A fence the body
  // opens and the guidance's own bytes close (or leave open) therefore has
  // combined-page meaning that neither half's standalone scan can see - the
  // split-fence hole. The half's detection must run in the fence context the
  // preceding rendered bytes leave, in both directions: a row live on the
  // combined page is caught in the half, and a row the combined page masks
  // stays untouched in the half.
  const SEPARATOR = "\n\n## Guidance\n\n";
  const MARKER = "@osb feedback negative topic=t principle=p";

  test("a fence the preceding half opens no longer hides a marker the combined page parses", () => {
    const context = `x\n\`\`\`${SEPARATOR}`;
    const guidance = `\`\`\`\n${MARKER}`;
    // The combined page parses the marker: the body's fence swallows the
    // renderer heading and closes on the guidance's fence line.
    expect(discoverMarkers(context + guidance)).toHaveLength(1);
    // The guidance half alone saw an unterminated fence and reported
    // nothing - exactly the hole.
    expect(neutralizeMarkdown(guidance).changed).toBe(false);
    const out = neutralizeMarkdown(guidance, { precedingContext: context });
    expect(out.kinds).toEqual(kindsOf("osb-inline"));
    expect(out.text).toBe(`\`\`\`\n\\${MARKER}`);
    expect(discoverMarkers(context + out.text)).toHaveLength(0);
  });

  test("a marker the combined page masks stays byte-identical in the half", () => {
    // Consistency, the other direction: with the body's fence never closed,
    // the combined page's scanner parses nothing from the guidance, so the
    // half must not escape it either - the same fence masks both views.
    const context = `x\n\`\`\`${SEPARATOR}`;
    expect(discoverMarkers(context + MARKER)).toHaveLength(0);
    const out = neutralizeMarkdown(MARKER, { precedingContext: context });
    expect(out.changed).toBe(false);
    expect(out.text).toBe(MARKER);
  });

  test("a preceding half with no open fence leaves the call identical to the standalone one", () => {
    const context = `\`\`\`python\nx = 1\n\`\`\`${SEPARATOR}`;
    const guidance = "route to [[pref-sink]]\n\n## Planted\n\nthen @osb set note=n";
    const standalone = neutralizeMarkdown(guidance);
    const threaded = neutralizeMarkdown(guidance, { precedingContext: context });
    expect(threaded.text).toBe(standalone.text);
    expect(threaded.changed).toBe(standalone.changed);
    expect(threaded.kinds).toEqual(standalone.kinds);
  });

  test("the heading and wikilink families answer to the same cross-boundary fence state", () => {
    // The guidance's first fence line closes the body's fence on the
    // combined page - the link readers consume that run as the body
    // fence's closer - so the rows between the guidance's fences are live
    // for the section and link readers even though the guidance-half-alone
    // scan fenced them (there the first run opened its own fence and the
    // region spanned the wikilink).
    const context = `x\n\`\`\`${SEPARATOR}`;
    const guidance = "```\n## Planted\n[[planted-link]]\n```";
    const out = neutralizeMarkdown(guidance, { precedingContext: context });
    expect(out.kinds).toEqual(kindsOf("atx-heading", "wikilink"));
    expect(out.text).toBe("```\n\\#\\# Planted\n\\[\\[planted-link\\]\\]\n```");
    // Reader parity on the rendered page: nothing live survives.
    expect(extractWikilinks(context + out.text)).toEqual([]);
    expect(discoverMarkers(context + out.text)).toHaveLength(0);
  });

  test("the threaded call is idempotent under the same context", () => {
    const context = `x\n\`\`\`${SEPARATOR}`;
    const once = neutralizeMarkdown(`\`\`\`\n${MARKER}`, { precedingContext: context });
    const twice = neutralizeMarkdown(once.text, { precedingContext: context });
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });
});

describe("neutralizeMarkdown: the fixpoint bound fails closed", () => {
  /**
   * The loop's exit condition IS the doctrine: the output no longer
   * matches the detector. A bound exhausted with live structure remaining
   * used to fall through and return `changed: true` - shipping exactly the
   * bytes the module exists to neutralize, silently. It must refuse by
   * name instead. The bound is forced low through
   * {@link neutralizeMarkdownWithBound}, the seam that exists so tests can
   * reach the bound without awaiting an impossible input.
   */
  test("a bound exhausted with live structure remaining throws the named error", () => {
    // The two-round deep case: round one escapes only the ```osb fence
    // lines, and the dissolve they cause is what exposes the interior to
    // round two. With the bound forced to a single round the output still
    // carries the live heading - exactly the state the fall-through used
    // to return as a success.
    const src = "```osb\n## Planted\n@osb set note=n field=f value=v\n```\n";
    expect(() => neutralizeMarkdownWithBound(src, 0)).toThrow(MarkdownNeutralizeFixpointError);
    expect(() => neutralizeMarkdownWithBound(src, 0)).toThrow(/fixpoint/);
  });

  test("the production bound neutralizes the same input cleanly", () => {
    const src = "```osb\n## Planted\n@osb set note=n field=f value=v\n```\n";
    const out = neutralizeMarkdown(src);
    expect(out.changed).toBe(true);
    // The post-condition itself: the output no longer matches the detector.
    expect(detectMarkdownStructure(out.text)).toEqual([]);
  });

  test("a bound that allows exactly the converging number of rounds succeeds", () => {
    const src = "```osb\n## Planted\n@osb set note=n field=f value=v\n```\n";
    const out = neutralizeMarkdownWithBound(src, 1);
    expect(out.changed).toBe(true);
    expect(detectMarkdownStructure(out.text)).toEqual([]);
  });

  test("an input with no structure never touches the bound", () => {
    const out = neutralizeMarkdownWithBound("plain prose, nothing planted\n", 0);
    expect(out.changed).toBe(false);
    expect(out.text).toBe("plain prose, nothing planted\n");
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

/**
 * Tests for `src/core/brain/inline.ts` — the `@osb` marker parser
 * shared by §9 (vault scan) and §16 (session-text scan).
 *
 * Three layers:
 *   1. `parseInlineMarker(line, lineNo)` — single-line `@osb ...` syntax.
 *   2. `parseBlockMarker(body, fenceStartLine)` — YAML-like fenced
 *      block with info-string `osb`.
 *   3. `discoverMarkers(content)` — file-level orchestrator that walks
 *      lines, tracks fence state, and ignores already-checked markers.
 */

import { describe, expect, test } from "bun:test";

import {
  discoverMarkersDetailed,
  discoverMarkers,
  parseBlockMarker,
  parseInlineMarker,
} from "../../src/core/brain/inline.ts";

// ── Inline form ─────────────────────────────────────────────────────────────

describe("parseInlineMarker", () => {
  test("recognises positional kind + signal + key=value pairs", () => {
    const m = parseInlineMarker(
      `@osb feedback negative topic=mocking principle="don't mock DB"`,
      1,
    );
    expect(m).not.toBeNull();
    if (m === null) return;
    expect(m.kind).toBe("feedback");
    expect(m.signal).toBe("negative");
    expect(m.topic).toBe("mocking");
    expect(m.principle).toBe("don't mock DB");
    expect(m.originLine).toBe(1);
    expect(m.shape).toBe("inline");
  });

  test("parses quoted strings with embedded escapes", () => {
    const m = parseInlineMarker(
      `@osb feedback positive topic=t principle="line with \\"quotes\\" and \\\\backslash"`,
      5,
    );
    expect(m).not.toBeNull();
    if (m === null) return;
    expect(m.principle).toBe(`line with "quotes" and \\backslash`);
  });

  test("accepts unquoted single-word values", () => {
    const m = parseInlineMarker(
      "@osb feedback positive topic=foo principle=bar scope=writing",
      1,
    );
    expect(m).not.toBeNull();
    if (m === null) return;
    expect(m.topic).toBe("foo");
    expect(m.principle).toBe("bar");
    expect(m.scope).toBe("writing");
  });

  test("returns null when 'kind' is unknown", () => {
    expect(parseInlineMarker(`@osb foo bar topic=t principle=p`, 1)).toBeNull();
  });

  test("returns null when '@osb' is in the middle of a line", () => {
    expect(
      parseInlineMarker(`This is @osb feedback positive topic=t principle=p`, 1),
    ).toBeNull();
  });

  test("returns null when required field is missing", () => {
    // No `principle`.
    expect(parseInlineMarker(`@osb feedback positive topic=t`, 1)).toBeNull();
    // No `signal`.
    expect(parseInlineMarker(`@osb feedback topic=t principle=p`, 1)).toBeNull();
  });

  test("returns null when signal value is not in the enum", () => {
    expect(
      parseInlineMarker(`@osb feedback maybe topic=t principle=p`, 1),
    ).toBeNull();
  });

  test("accepts leading whitespace before '@osb'", () => {
    const m = parseInlineMarker(
      `   @osb feedback negative topic=t principle=p`,
      1,
    );
    expect(m).not.toBeNull();
  });

  test("captures optional agent / note / source", () => {
    const m = parseInlineMarker(
      `@osb feedback negative topic=t principle=p agent=claude source=[[Daily/2026-05-14]]`,
      1,
    );
    expect(m).not.toBeNull();
    if (m === null) return;
    expect(m.agent).toBe("claude");
    expect(m.source).toEqual(["[[Daily/2026-05-14]]"]);
  });
});

// ── Block form ──────────────────────────────────────────────────────────────

describe("parseBlockMarker", () => {
  test("parses a multi-line YAML body", () => {
    const body = [
      "kind: feedback",
      "signal: negative",
      "topic: t",
      "principle: long principle text",
      "scope: testing",
    ].join("\n");
    const m = parseBlockMarker(body, 5);
    expect(m).not.toBeNull();
    if (m === null) return;
    expect(m.kind).toBe("feedback");
    expect(m.signal).toBe("negative");
    expect(m.principle).toBe("long principle text");
    expect(m.scope).toBe("testing");
    expect(m.shape).toBe("block");
    expect(m.originLine).toBe(5);
  });

  test("returns null on unknown kind", () => {
    const body = [
      "kind: lol",
      "signal: negative",
      "topic: t",
      "principle: p",
    ].join("\n");
    expect(parseBlockMarker(body, 1)).toBeNull();
  });

  test("returns null when required field is missing", () => {
    const body = ["kind: feedback", "signal: negative", "topic: t"].join("\n");
    expect(parseBlockMarker(body, 1)).toBeNull();
  });

  test("ignores comments and blank lines", () => {
    const body = [
      "# leading comment",
      "kind: feedback",
      "",
      "signal: positive",
      "topic: t",
      "principle: p",
    ].join("\n");
    const m = parseBlockMarker(body, 1);
    expect(m).not.toBeNull();
  });
});

// ── File-level discovery ────────────────────────────────────────────────────

describe("discoverMarkers", () => {
  test("finds inline markers", () => {
    const text = [
      "Some note text",
      "@osb feedback negative topic=t principle=p",
      "More text",
    ].join("\n");
    const markers = discoverMarkers(text);
    expect(markers.length).toBe(1);
    expect(markers[0]!.shape).toBe("inline");
    expect(markers[0]!.originLine).toBe(2);
  });

  test("finds fenced 'osb' blocks", () => {
    const text = [
      "Before",
      "```osb",
      "kind: feedback",
      "signal: positive",
      "topic: t",
      "principle: p",
      "```",
      "After",
    ].join("\n");
    const markers = discoverMarkers(text);
    expect(markers.length).toBe(1);
    expect(markers[0]!.shape).toBe("block");
    expect(markers[0]!.originLine).toBe(2); // line with ```osb
  });

  test("ignores '@osb' inside non-osb fences (code samples in docs)", () => {
    const text = [
      "```python",
      "@osb feedback negative topic=t principle=p",
      "```",
    ].join("\n");
    expect(discoverMarkers(text).length).toBe(0);
  });

  test("ignores already-checked inline markers (@osb✓)", () => {
    const text = "@osb✓ [[sig-foo]] feedback negative topic=t principle=p";
    expect(discoverMarkers(text).length).toBe(0);
  });

  test("ignores already-checked fenced blocks (osb-checked)", () => {
    const text = [
      "```osb-checked",
      "<!-- @osb✓ [[sig-x]] -->",
      "kind: feedback",
      "signal: positive",
      "topic: t",
      "principle: p",
      "```",
    ].join("\n");
    expect(discoverMarkers(text).length).toBe(0);
  });

  test("finds multiple markers in document order", () => {
    const text = [
      "@osb feedback negative topic=a principle=p1",
      "...",
      "@osb feedback positive topic=b principle=p2",
      "...",
      "```osb",
      "kind: feedback",
      "signal: negative",
      "topic: c",
      "principle: p3",
      "```",
    ].join("\n");
    const markers = discoverMarkers(text);
    expect(markers.length).toBe(3);
    expect(markers.map((m) => m.topic)).toEqual(["a", "b", "c"]);
  });

  test("preserves verbatim originText for inline markers", () => {
    const text = `@osb feedback negative topic=t principle="don't mock"`;
    const markers = discoverMarkers(text);
    expect(markers.length).toBe(1);
    expect(markers[0]!.originText).toBe(text);
  });

  test("reports malformed marker attempts separately from prose", () => {
    const text = [
      "@osb is great prose, not a marker",
      "@osb feedback negative topic=t",
      "```osb",
      "kind: feedback",
      "signal: positive",
      "topic: t",
      "```",
    ].join("\n");
    const result = discoverMarkersDetailed(text);
    expect(result.markers.length).toBe(0);
    expect(result.malformed).toBe(2);
  });
});

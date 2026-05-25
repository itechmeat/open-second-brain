/**
 * Unit tests for `parseWikilinkRich` - the rich-parse helper that
 * returns `{target, anchor, block, alias}` from any Obsidian wikilink
 * shape. The existing `parseWikilink` / `normaliseWikilinkTarget`
 * (string-returning) helpers keep their contracts; this test set
 * locks in the additive richer surface introduced by v0.10.17.
 */

import { describe, expect, test } from "bun:test";

import { parseWikilinkRich } from "../../../../src/core/brain/link-graph/parse-wikilink.ts";

describe("parseWikilinkRich - bare target", () => {
  test("bare target inside brackets", () => {
    const r = parseWikilinkRich("[[Note]]");
    expect(r.target).toBe("Note");
    expect(r.anchor).toBeUndefined();
    expect(r.block).toBeUndefined();
    expect(r.alias).toBeUndefined();
  });

  test("bare target without brackets", () => {
    const r = parseWikilinkRich("Note");
    expect(r.target).toBe("Note");
  });

  test("trailing .md extension stripped", () => {
    const r = parseWikilinkRich("[[Note.md]]");
    expect(r.target).toBe("Note");
  });

  test("folder prefix collapses to basename", () => {
    const r = parseWikilinkRich("[[Folder/Note]]");
    expect(r.target).toBe("Note");
  });

  test("empty input returns empty target", () => {
    const r = parseWikilinkRich("");
    expect(r.target).toBe("");
  });
});

describe("parseWikilinkRich - heading anchor", () => {
  test("simple heading", () => {
    const r = parseWikilinkRich("[[Note#Heading]]");
    expect(r.target).toBe("Note");
    expect(r.anchor).toBe("Heading");
    expect(r.block).toBeUndefined();
  });

  test("heading with spaces", () => {
    const r = parseWikilinkRich("[[Note#Section Two]]");
    expect(r.target).toBe("Note");
    expect(r.anchor).toBe("Section Two");
  });

  test("heading with non-ASCII characters", () => {
    const r = parseWikilinkRich("[[Note#Раздел]]");
    expect(r.target).toBe("Note");
    expect(r.anchor).toBe("Раздел");
  });

  test("anchor on folder-prefixed target", () => {
    const r = parseWikilinkRich("[[Folder/Note#Heading]]");
    expect(r.target).toBe("Note");
    expect(r.anchor).toBe("Heading");
  });
});

describe("parseWikilinkRich - block anchor", () => {
  test("block id detected via caret sigil", () => {
    const r = parseWikilinkRich("[[Note#^abc123]]");
    expect(r.target).toBe("Note");
    expect(r.block).toBe("abc123");
    expect(r.anchor).toBeUndefined();
  });

  test("block id with hyphens preserved", () => {
    const r = parseWikilinkRich("[[Note#^block-id-x]]");
    expect(r.block).toBe("block-id-x");
  });
});

describe("parseWikilinkRich - alias", () => {
  test("alias preserved separately from target", () => {
    const r = parseWikilinkRich("[[Note|display name]]");
    expect(r.target).toBe("Note");
    expect(r.alias).toBe("display name");
  });

  test("alias plus anchor", () => {
    const r = parseWikilinkRich("[[Note#Heading|display]]");
    expect(r.target).toBe("Note");
    expect(r.anchor).toBe("Heading");
    expect(r.alias).toBe("display");
  });

  test("alias plus block id", () => {
    const r = parseWikilinkRich("[[Note#^abc|display]]");
    expect(r.target).toBe("Note");
    expect(r.block).toBe("abc");
    expect(r.alias).toBe("display");
  });
});

describe("parseWikilinkRich - immutability", () => {
  test("returned object is frozen", () => {
    const r = parseWikilinkRich("[[Note#H|alias]]");
    expect(Object.isFrozen(r)).toBe(true);
  });
});

/**
 * Wikilink output format kernel (Workspace Insight Suite, t_5f31b5f1):
 * pure functions that rewrite wikilink targets to a configured path
 * format - preserve (byte-identical), full (vault-relative key path),
 * short (shortest unambiguous suffix). Decorations (anchor, block,
 * alias) and code blocks are never touched; ambiguous and unresolved
 * targets stay as typed.
 */

import { expect, test } from "bun:test";

import {
  formatWikilinkBody,
  normalizeWikilinks,
  shortestUniqueSuffix,
} from "../../../src/core/brain/link-graph/format-wikilink.ts";

const PAGES = [
  "Brain/notes/alpha",
  "Brain/notes/deep/beta",
  "Brain/archive/beta",
  "Projects/gamma",
] as const;

// ── shortestUniqueSuffix ────────────────────────────────────────────────────

test("shortestUniqueSuffix returns the basename when unique", () => {
  expect(shortestUniqueSuffix("Brain/notes/alpha", PAGES)).toBe("alpha");
});

test("shortestUniqueSuffix grows until the suffix is unambiguous", () => {
  expect(shortestUniqueSuffix("Brain/notes/deep/beta", PAGES)).toBe("deep/beta");
  expect(shortestUniqueSuffix("Brain/archive/beta", PAGES)).toBe("archive/beta");
});

// ── formatWikilinkBody ──────────────────────────────────────────────────────

test("full mode rewrites a unique basename to its full key path", () => {
  expect(formatWikilinkBody("alpha", "full", PAGES)).toBe("Brain/notes/alpha");
  expect(formatWikilinkBody("gamma", "full", PAGES)).toBe("Projects/gamma");
});

test("full mode keeps decorations verbatim", () => {
  expect(formatWikilinkBody("alpha#Heading|shown", "full", PAGES)).toBe(
    "Brain/notes/alpha#Heading|shown",
  );
  expect(formatWikilinkBody("alpha#^blk", "full", PAGES)).toBe("Brain/notes/alpha#^blk");
});

test("short mode rewrites a full path to the shortest unambiguous suffix", () => {
  expect(formatWikilinkBody("Brain/notes/alpha", "short", PAGES)).toBe("alpha");
  expect(formatWikilinkBody("Brain/notes/deep/beta", "short", PAGES)).toBe("deep/beta");
});

test("an ambiguous bare target is left untouched in both modes", () => {
  expect(formatWikilinkBody("beta", "full", PAGES)).toBe("beta");
  expect(formatWikilinkBody("beta", "short", PAGES)).toBe("beta");
});

test("an unknown target is left untouched", () => {
  expect(formatWikilinkBody("ghost", "full", PAGES)).toBe("ghost");
});

test("a partial-path suffix resolves when unique", () => {
  expect(formatWikilinkBody("notes/deep/beta", "full", PAGES)).toBe("Brain/notes/deep/beta");
});

test("preserve mode is the identity", () => {
  expect(formatWikilinkBody("alpha", "preserve", PAGES)).toBe("alpha");
});

// ── normalizeWikilinks ──────────────────────────────────────────────────────

test("normalizeWikilinks rewrites links outside code blocks only", () => {
  const content = [
    "See [[alpha]] and [[beta]].",
    "```",
    "[[alpha]] inside a fence stays",
    "```",
    "Inline `[[alpha]]` stays too; [[gamma|G]] changes.",
  ].join("\n");
  const result = normalizeWikilinks(content, "full", PAGES);
  expect(result.content).toContain("[[Brain/notes/alpha]] and [[beta]].");
  expect(result.content).toContain("[[alpha]] inside a fence stays");
  expect(result.content).toContain("`[[alpha]]` stays too");
  expect(result.content).toContain("[[Projects/gamma|G]]");
  expect(result.changed).toBe(2);
  expect(result.ambiguous).toEqual(["beta"]);
});

test("normalizeWikilinks in preserve mode returns byte-identical content", () => {
  const content = "A [[alpha]] link and a [[Brain/archive/beta]] link.";
  const result = normalizeWikilinks(content, "preserve", PAGES);
  expect(result.content).toBe(content);
  expect(result.changed).toBe(0);
});

test("media embeds are never rewritten", () => {
  const content = "![[diagram.png]] and [[alpha]]";
  const result = normalizeWikilinks(content, "full", PAGES);
  expect(result.content).toContain("![[diagram.png]]");
  expect(result.content).toContain("[[Brain/notes/alpha]]");
});

test("an already-canonical link is not counted as a change", () => {
  const content = "[[Brain/notes/alpha]]";
  const result = normalizeWikilinks(content, "full", PAGES);
  expect(result.content).toBe(content);
  expect(result.changed).toBe(0);
});

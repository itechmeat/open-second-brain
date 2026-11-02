/**
 * The shared frontmatter read cache refuses, before any read, a
 * vault-relative path that resolves outside its vault.
 *
 * `readCachedFrontmatterEntry` is the one seam every ownership and
 * reachability verdict reads through (`isPathOwnerVisible`,
 * `isPathReadableAtReach`, recall injection), so containment has to
 * hold in the helper itself: a rel such as `../escape.md` joined onto
 * the vault would otherwise be probed - and its frontmatter parsed -
 * from a file BESIDE the vault.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  isPathOwnerVisible,
  readCachedFrontmatterEntry,
  type FrontmatterCache,
} from "../../../src/core/search/result-filters.ts";
import { posixRel } from "../../../src/core/path-safety.ts";

let vault: string;
let outsideDir: string;
let cache: FrontmatterCache;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-fm-cache-inside-"));
  outsideDir = mkdtempSync(join(tmpdir(), "o2b-fm-cache-outside-"));
  cache = new Map();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

/** The escape target: a real, readable file one level beside the vault. */
function escapeRel(): string {
  writeFileSync(
    join(outsideDir, "escape.md"),
    "---\nowner: agent-b\norigin_channel: cli\n---\n\noutside\n",
  );
  return join("..", basename(outsideDir), "escape.md");
}

test("a rel that resolves outside the vault is fail-closed unreadable without any read", () => {
  const rel = escapeRel();
  const entry = readCachedFrontmatterEntry(cache, vault, rel);
  // The outside file exists and carries frontmatter a read would have
  // surfaced, so an unreadable verdict with an empty map is the proof
  // the read never happened.
  expect(entry).toEqual({ meta: {}, unreadable: true });
  // The cache keys a rel by its folded POSIX spelling - the fold that
  // makes `notes\page.md` and `notes/page.md` one logical page sharing
  // one entry - so the refusal is cached under that spelling on every
  // platform, and a repeat probe through the raw spelling answers the
  // refusal again without ever growing a second entry.
  expect(cache.get(posixRel(rel))).toEqual({ meta: {}, unreadable: true });
  expect(readCachedFrontmatterEntry(cache, vault, rel)).toEqual({ meta: {}, unreadable: true });
  expect(cache.size).toBe(1);
});

test("isPathOwnerVisible inherits the refusal for an escaping rel", () => {
  const rel = escapeRel();
  // Even the outside file's own owner gets nothing: the refusal is the
  // unreadable verdict, not a parsed owner map.
  expect(isPathOwnerVisible(vault, rel, "agent-b", cache)).toBe(false);
});

test("a backslash spelling is judged by what it names on each platform", () => {
  const rel = escapeRel().replaceAll("/", "\\");
  // The literal backslash-named file INSIDE the vault, carrying a stamp
  // that differs from the outside file's: whichever file the probe
  // reads, the entry names it. POSIX only - on Windows the same
  // spelling folds into the escape (the backslashes are separators), so
  // this setup write would land on the OUTSIDE file and clobber the
  // stamp the contrast depends on; there the probe is refused before
  // any read and the literal file is never consulted.
  if (process.platform !== "win32") {
    writeFileSync(join(vault, rel), "---\nowner: agent-a\n---\n\nliteral\n");
  }
  const entry = readCachedFrontmatterEntry(cache, vault, rel);
  if (process.platform === "win32") {
    // The spelling folds into the escape, so the probe is refused
    // before any read and the literal file is never consulted.
    expect(entry).toEqual({ meta: {}, unreadable: true });
  } else {
    // Backslash is a filename character: the probe read the LITERAL
    // in-vault file (the folded spelling would have surfaced the
    // outside file's `owner: agent-b` instead).
    expect(entry.unreadable).toBe(false);
    expect(entry.meta["owner"]).toBe("agent-a");
  }
});

test("a contained rel still probes and caches normally", () => {
  writeFileSync(join(vault, "inside.md"), "---\nowner: agent-a\n---\n\ninside\n");
  const entry = readCachedFrontmatterEntry(cache, vault, "inside.md");
  expect(entry.unreadable).toBe(false);
  expect(entry.meta["owner"]).toBe("agent-a");
  expect(cache.size).toBe(1);
});

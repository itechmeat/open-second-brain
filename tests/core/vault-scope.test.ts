/**
 * Unit tests for `src/core/vault-scope/index.ts`.
 *
 * Anchored in docs/plans/2026-05-19-vault-scope-design.md §5.
 */

import { afterEach, beforeEach, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyVaultIgnoreRule,
  DEFAULT_VAULT_IGNORE_PATHS,
  inspectPath,
  matchIgnore,
  resolveVaultScope,
  walkVaultScope,
  type VaultIgnoreRule,
} from "../../src/core/vault-scope/index.ts";
// The cycle-safe leaf, imported directly: `pathCovers` is shared by modules
// that must not reach the resolver above it.
import { normalisePathSegments, pathCovers } from "../../src/core/vault-scope/defaults.ts";

test("DEFAULT_VAULT_IGNORE_PATHS contains the v0.10.9 baseline", () => {
  expect([...DEFAULT_VAULT_IGNORE_PATHS]).toEqual([
    ".git",
    "node_modules",
    ".open-second-brain",
    ".obsidian",
    ".trash",
    ".stversions",
    "Brain/.snapshots",
  ]);
});

test("DEFAULT_VAULT_IGNORE_PATHS is frozen", () => {
  expect(Object.isFrozen(DEFAULT_VAULT_IGNORE_PATHS)).toBe(true);
});

test("VaultIgnoreRule kind union covers the two semantic cases", () => {
  const a: VaultIgnoreRule = { raw: ".git", kind: "name" };
  const b: VaultIgnoreRule = { raw: "Brain/.snapshots", kind: "path" };
  expect(a.kind).toBe("name");
  expect(b.kind).toBe("path");
});

// ----- classifyVaultIgnoreRule normalisation -------------------------------

test("classifyVaultIgnoreRule strips trailing slash on path rules", () => {
  const r = classifyVaultIgnoreRule("Brain/.snapshots/");
  expect(r.raw).toBe("Brain/.snapshots");
  expect(r.kind).toBe("path");
});

test("classifyVaultIgnoreRule strips leading ./ on path rules", () => {
  const r = classifyVaultIgnoreRule("./Brain/.snapshots");
  expect(r.raw).toBe("Brain/.snapshots");
  expect(r.kind).toBe("path");
});

test("classifyVaultIgnoreRule collapses double slashes", () => {
  const r = classifyVaultIgnoreRule("Brain//.snapshots");
  expect(r.raw).toBe("Brain/.snapshots");
  expect(r.kind).toBe("path");
});

test("classifyVaultIgnoreRule preserves bare names verbatim", () => {
  const r = classifyVaultIgnoreRule(".git");
  expect(r.raw).toBe(".git");
  expect(r.kind).toBe("name");
});

// ----- pathCovers -----------------------------------------------------------
//
// The shared segment-wise coverage predicate (unit B1). Five modules carried
// their own copy of this test before it had a home: the write-binding prefix
// matcher, the index-admission lane check, the note-walk root narrowing, the
// index root-coverage scan and the snapshot manifest exclusion. The cases
// below are the union of the edge cases those five disagreed on, so the
// deduplication cannot quietly move any of them.

test("pathCovers: a prefix covers itself", () => {
  expect(pathCovers("Notes", "Notes")).toBe(true);
  expect(pathCovers("Brain/state", "Brain/state")).toBe(true);
});

test("pathCovers: a prefix covers its children at any depth", () => {
  expect(pathCovers("Notes", "Notes/idea.md")).toBe(true);
  expect(pathCovers("Notes", "Notes/2026/05/idea.md")).toBe(true);
});

test("pathCovers: the comparison is segment-wise, not textual", () => {
  // The whole reason this predicate exists: a character-prefix test would
  // let `Notes` cover a folder the operator never named.
  expect(pathCovers("Notes", "Notes-archive/idea.md")).toBe(false);
  expect(pathCovers("Notes", "Notesy")).toBe(false);
  expect(pathCovers("Brain/state", "Brain/stateful/x.md")).toBe(false);
  expect(pathCovers("Brain/state", "Brain/state-notes.md")).toBe(false);
});

test("pathCovers: a parent of the prefix is not covered by it", () => {
  expect(pathCovers("Notes/sub", "Notes")).toBe(false);
  expect(pathCovers("Notes/sub", "")).toBe(false);
});

test("pathCovers: the empty prefix covers the vault root and nothing else", () => {
  // A normalised target never starts with a separator, so the empty prefix
  // is the root itself rather than an accidental match-everything.
  expect(pathCovers("", "")).toBe(true);
  expect(pathCovers("", ".")).toBe(true);
  expect(pathCovers("", "Notes/idea.md")).toBe(false);
  expect(pathCovers("", "/Notes/idea.md")).toBe(false);
});

test("pathCovers: a prefix that kept its trailing slash covers nothing", () => {
  // Callers normalise their prefixes; one that did not is a declaration
  // this grammar cannot honour, and reading it as `Notes` would be a guess.
  expect(pathCovers("Notes/", "Notes/idea.md")).toBe(false);
  expect(pathCovers("Notes/", "Notes/")).toBe(false);
  expect(pathCovers("Notes/", "Notes")).toBe(false);
});

test("pathCovers: the target is normalised before comparison", () => {
  expect(pathCovers("Notes", "./Notes/idea.md")).toBe(true);
  expect(pathCovers("Notes", "Notes//idea.md")).toBe(true);
  expect(pathCovers("Notes", "Notes/")).toBe(true);
  expect(pathCovers("Notes", "/Notes/idea.md")).toBe(true);
  expect(pathCovers("Notes", "Notes/./idea.md")).toBe(true);
});

test("pathCovers: a backslash is an ordinary filename character", () => {
  // On POSIX `Projects\evil.md` is a one-segment name that lands at the
  // vault ROOT, so reading structure into it would admit a path the
  // declaration never covered.
  expect(pathCovers("Projects", "Projects\\evil.md")).toBe(false);
  expect(pathCovers("Projects", "Projects/evil.md")).toBe(true);
});

test("pathCovers: `..` is a segment like any other, never traversal", () => {
  // The manifest walk uses this to drop `..`-anchored entries; the
  // predicate must not resolve the segment away.
  expect(pathCovers("..", "..")).toBe(true);
  expect(pathCovers("..", "../outside.md")).toBe(true);
  expect(pathCovers("..", "..notes.md")).toBe(false);
  expect(pathCovers("Notes", "Notes/../evil.md")).toBe(true);
});

test("normalisePathSegments drops empty and `.` segments", () => {
  expect(normalisePathSegments("Notes/idea.md")).toBe("Notes/idea.md");
  expect(normalisePathSegments("./Notes//idea.md/")).toBe("Notes/idea.md");
  expect(normalisePathSegments("/Notes/./idea.md")).toBe("Notes/idea.md");
});

test("normalisePathSegments returns the empty string for a path with no segments", () => {
  for (const raw of ["", ".", "/", "///", "./", "/./"]) {
    expect(normalisePathSegments(raw)).toBe("");
  }
});

// ----- matchIgnore ----------------------------------------------------------

const rules: ReadonlyArray<VaultIgnoreRule> = [
  { raw: ".git", kind: "name" },
  { raw: "node_modules", kind: "name" },
  { raw: "Brain/.snapshots", kind: "path" },
];

test("matchIgnore returns excluded=false on a plain path", () => {
  const r = matchIgnore("Notes/idea.md", rules);
  expect(r.excluded).toBe(false);
  expect(r.rule).toBeNull();
  expect(r.matchedAt).toBeNull();
});

test("matchIgnore catches a bare-name rule at the root", () => {
  const r = matchIgnore(".git/HEAD", rules);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe(".git");
  expect(r.matchedAt).toBe(".git");
});

test("matchIgnore catches a bare-name rule at any depth", () => {
  const r = matchIgnore("deep/nested/.git/HEAD", rules);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe(".git");
  expect(r.matchedAt).toBe("deep/nested/.git");
});

test("matchIgnore catches a path rule by exact prefix", () => {
  const r = matchIgnore("Brain/.snapshots/2026-05-19.tar.zst", rules);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe("Brain/.snapshots");
  expect(r.matchedAt).toBe("Brain/.snapshots");
});

test("matchIgnore does NOT match a path rule on a prefix collision", () => {
  // "Brain/.snapshots-old" must NOT be eaten by "Brain/.snapshots".
  const r = matchIgnore("Brain/.snapshots-old/x.md", rules);
  expect(r.excluded).toBe(false);
});

test("matchIgnore on an empty relPath is excluded=false (vault root)", () => {
  const r = matchIgnore("", rules);
  expect(r.excluded).toBe(false);
});

test("matchIgnore with empty rules excludes nothing", () => {
  const r = matchIgnore(".git/HEAD", []);
  expect(r.excluded).toBe(false);
});

// ----- resolveVaultScope ---------------------------------------------------

let scopeVault: string;

beforeEach(() => {
  scopeVault = mkdtempSync(join(tmpdir(), "osb-scope-"));
  mkdirSync(join(scopeVault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(scopeVault, { recursive: true, force: true });
});

function writeBrain(body: string): void {
  writeFileSync(join(scopeVault, "Brain", "_brain.yaml"), body, "utf8");
}

test("resolveVaultScope: defaults when _brain.yaml is absent", () => {
  const scope = resolveVaultScope(scopeVault);
  expect(scope.source).toBe("defaults");
  expect(scope.ignorePaths).toContain(".obsidian");
  expect(scope.ignorePaths).toContain("Brain/.snapshots");
  expect(scope.rules.find((r) => r.raw === "Brain/.snapshots")?.kind).toBe("path");
  expect(scope.rules.find((r) => r.raw === ".obsidian")?.kind).toBe("name");
});

test("resolveVaultScope: reads vault.ignore_paths when present", () => {
  writeBrain(`schema_version: 1
vault:
  ignore_paths:
    - .git
    - my-cache
`);
  const scope = resolveVaultScope(scopeVault);
  expect(scope.source).toBe("_brain.yaml");
  expect(scope.ignorePaths).toEqual([".git", "my-cache"]);
  expect(scope.rules.map((r) => r.kind)).toEqual(["name", "name"]);
});

test("resolveVaultScope: explicit empty list excludes nothing", () => {
  writeBrain(`schema_version: 1
vault:
  ignore_paths:
`);
  const scope = resolveVaultScope(scopeVault);
  expect(scope.source).toBe("_brain.yaml");
  expect(scope.ignorePaths).toEqual([]);
  expect(scope.rules).toEqual([]);
});

test("resolveVaultScope: absent vault block falls back to defaults", () => {
  writeBrain(`schema_version: 1\n`);
  const scope = resolveVaultScope(scopeVault);
  expect(scope.source).toBe("defaults");
});

test("resolveVaultScope: vault block without ignore_paths falls back to defaults", () => {
  writeBrain(`schema_version: 1
vault:
  some_future_key: 42
`);
  const scope = resolveVaultScope(scopeVault);
  expect(scope.source).toBe("defaults");
});

test("resolveVaultScope: invalid _brain.yaml fails closed instead of defaulting", () => {
  writeBrain("schema_version: 1\n  nested_without_parent: 1\n");
  expect(() => resolveVaultScope(scopeVault)).toThrow(/unexpected indentation/);
});

test("resolveVaultScope: returns an immutable object", () => {
  const scope = resolveVaultScope(scopeVault);
  expect(Object.isFrozen(scope)).toBe(true);
  expect(Object.isFrozen(scope.rules)).toBe(true);
  expect(Object.isFrozen(scope.ignorePaths)).toBe(true);
});

// ----- walkVaultScope ------------------------------------------------------

test("walkVaultScope: counts included files+dirs and reports excluded subtree once", () => {
  mkdirSync(join(scopeVault, "Notes"), { recursive: true });
  writeFileSync(join(scopeVault, "Notes", "a.md"), "x");
  writeFileSync(join(scopeVault, "Notes", "b.md"), "x");
  mkdirSync(join(scopeVault, ".obsidian", "plugins", "foo"), { recursive: true });
  writeFileSync(join(scopeVault, ".obsidian", "app.json"), "{}");
  writeFileSync(join(scopeVault, ".obsidian", "plugins", "foo", "note.md"), "x");

  const scope = resolveVaultScope(scopeVault);
  const walk = walkVaultScope(scopeVault, scope);

  expect(walk.includedFiles).toBeGreaterThanOrEqual(2);
  const obsidianHit = walk.excludedDirs.find((d) => d.relPath === ".obsidian");
  expect(obsidianHit).toBeTruthy();
  expect(obsidianHit?.rule.raw).toBe(".obsidian");
  // Subtree descendants must NOT be reported separately.
  expect(walk.excludedDirs.filter((d) => d.relPath.startsWith(".obsidian/"))).toHaveLength(0);
});

test("walkVaultScope: file-level rule excludes a single file but not the parent", () => {
  writeFileSync(join(scopeVault, "note.md"), "x");
  writeFileSync(join(scopeVault, "secret.md"), "x");
  const scope = {
    ignorePaths: ["secret.md"],
    rules: [{ raw: "secret.md", kind: "path" as const }],
    source: "_brain.yaml" as const,
  };
  const walk = walkVaultScope(scopeVault, scope);
  expect(walk.excludedFiles.map((f) => f.relPath)).toContain("secret.md");
  expect(walk.includedFiles).toBe(1);
});

test("walkVaultScope: empty vault yields zero counts", () => {
  rmSync(join(scopeVault, "Brain"), { recursive: true, force: true });
  const scope = resolveVaultScope(scopeVault);
  const walk = walkVaultScope(scopeVault, scope);
  expect(walk.includedFiles).toBe(0);
  expect(walk.excludedDirs).toEqual([]);
});

test("walkVaultScope: symlinked file escaping vault is not counted (symmetric with search walker)", () => {
  const outside = mkdtempSync(join(tmpdir(), "osb-scope-outside-"));
  try {
    writeFileSync(join(outside, "leak.md"), "secret");
    writeFileSync(join(scopeVault, "real.md"), "x");
    symlinkSync(join(outside, "leak.md"), join(scopeVault, "evil.md"));
    const scope = resolveVaultScope(scopeVault);
    const walk = walkVaultScope(scopeVault, scope);
    // `real.md` plus the Brain config file should count; `evil.md`
    // resolves outside the vault and must be dropped before being
    // counted.
    expect(walk.includedFiles).toBeLessThanOrEqual(2);
    expect(walk.excludedFiles.map((f) => f.relPath)).not.toContain("evil.md");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// ----- inspectPath ---------------------------------------------------------

test("inspectPath: included path that exists on disk", () => {
  writeFileSync(join(scopeVault, "idea.md"), "x");
  const scope = resolveVaultScope(scopeVault);
  const r = inspectPath("idea.md", scope, scopeVault);
  expect(r.excluded).toBe(false);
  expect(r.rule).toBeNull();
  expect(r.matchedAt).toBeNull();
  expect(r.relPath).toBe("idea.md");
  expect(r.source).toBe("defaults");
  expect(r.existsOnDisk).toBe(true);
});

test("inspectPath: included path that does NOT exist on disk reports existsOnDisk=false", () => {
  const scope = resolveVaultScope(scopeVault);
  const r = inspectPath("Notes/hypothetical.md", scope, scopeVault);
  expect(r.excluded).toBe(false);
  expect(r.existsOnDisk).toBe(false);
});

test("inspectPath: excluded by name rule reports the matched directory", () => {
  const scope = resolveVaultScope(scopeVault);
  const r = inspectPath(".obsidian/plugins/foo/note.md", scope, scopeVault);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe(".obsidian");
  expect(r.rule?.kind).toBe("name");
  expect(r.matchedAt).toBe(".obsidian");
  // The file does not exist on disk; the rule decision is still meaningful.
  expect(r.existsOnDisk).toBe(false);
});

test("inspectPath: excluded by path rule on exact match", () => {
  const scope = resolveVaultScope(scopeVault);
  const r = inspectPath("Brain/.snapshots/2026-05-19.tar.zst", scope, scopeVault);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe("Brain/.snapshots");
  expect(r.rule?.kind).toBe("path");
});

test("inspectPath: strips leading ./ and surrounding slashes", () => {
  const scope = resolveVaultScope(scopeVault);
  const r = inspectPath("/./Notes/idea.md/", scope, scopeVault);
  expect(r.relPath).toBe("Notes/idea.md");
  expect(r.excluded).toBe(false);
});

test("inspectPath: throws on .. traversal", () => {
  const scope = resolveVaultScope(scopeVault);
  expect(() => inspectPath("../outside", scope, scopeVault)).toThrow(/traverse/);
});

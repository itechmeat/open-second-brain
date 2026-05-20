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
  expect(
    walk.excludedDirs.filter((d) => d.relPath.startsWith(".obsidian/")),
  ).toHaveLength(0);
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

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
  inspectPath,
  matchRules,
  matchScope,
  mayDescend,
  resolveVaultScope,
  walkVaultScope,
  type VaultScope,
} from "../../src/core/vault-scope/index.ts";
// The cycle-safe leaf, imported directly: `pathCovers` is shared by modules
// that must not reach the resolver above it.
import {
  classifyVaultPathRule,
  DEFAULT_VAULT_IGNORE_PATHS,
  normalisePathSegments,
  pathCovers,
  type VaultPathRule,
  type VaultScopeRules,
} from "../../src/core/vault-scope/defaults.ts";

/** Build a `VaultScope` by hand, the way a resolver would. */
function scopeOf(ignore: ReadonlyArray<string>, include: ReadonlyArray<string> | null): VaultScope {
  return {
    ignorePaths: ignore,
    includePaths: include,
    rules: {
      ignore: ignore.map(classifyVaultPathRule),
      include: include === null ? null : include.map(classifyVaultPathRule),
    },
    source: "_brain.yaml",
    declared: { ignore: true, include: include !== null },
  };
}

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

test("VaultPathRule kind union covers the two semantic cases", () => {
  const a: VaultPathRule = { raw: ".git", kind: "name" };
  const b: VaultPathRule = { raw: "Brain/.snapshots", kind: "path" };
  expect(a.kind).toBe("name");
  expect(b.kind).toBe("path");
});

// ----- classifyVaultPathRule normalisation ---------------------------------

test("classifyVaultPathRule strips trailing slash on path rules", () => {
  const r = classifyVaultPathRule("Brain/.snapshots/");
  expect(r.raw).toBe("Brain/.snapshots");
  expect(r.kind).toBe("path");
});

test("classifyVaultPathRule strips leading ./ on path rules", () => {
  const r = classifyVaultPathRule("./Brain/.snapshots");
  expect(r.raw).toBe("Brain/.snapshots");
  expect(r.kind).toBe("path");
});

test("classifyVaultPathRule collapses double slashes", () => {
  const r = classifyVaultPathRule("Brain//.snapshots");
  expect(r.raw).toBe("Brain/.snapshots");
  expect(r.kind).toBe("path");
});

test("classifyVaultPathRule preserves bare names verbatim", () => {
  const r = classifyVaultPathRule(".git");
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

// ----- matchRules (polarity-free) -------------------------------------------
//
// The matcher answers ONE question - "does any of these rules cover this
// path" - and knows nothing about what a match means. Both polarities read
// the same grammar through it, which is why the include side needs no second
// implementation and cannot drift from the exclude side.

const rules: ReadonlyArray<VaultPathRule> = [
  { raw: ".git", kind: "name" },
  { raw: "node_modules", kind: "name" },
  { raw: "Brain/.snapshots", kind: "path" },
];

test("matchRules returns matched=false on a path no rule covers", () => {
  const r = matchRules("Notes/idea.md", rules);
  expect(r.matched).toBe(false);
  expect(r.rule).toBeNull();
  expect(r.matchedAt).toBeNull();
});

test("matchRules catches a bare-name rule at the root", () => {
  const r = matchRules(".git/HEAD", rules);
  expect(r.matched).toBe(true);
  expect(r.rule?.raw).toBe(".git");
  expect(r.matchedAt).toBe(".git");
});

test("matchRules catches a bare-name rule at any depth", () => {
  const r = matchRules("deep/nested/.git/HEAD", rules);
  expect(r.matched).toBe(true);
  expect(r.rule?.raw).toBe(".git");
  expect(r.matchedAt).toBe("deep/nested/.git");
});

test("matchRules catches a path rule by exact prefix", () => {
  const r = matchRules("Brain/.snapshots/2026-05-19.tar.zst", rules);
  expect(r.matched).toBe(true);
  expect(r.rule?.raw).toBe("Brain/.snapshots");
  expect(r.matchedAt).toBe("Brain/.snapshots");
});

test("matchRules does NOT match a path rule on a prefix collision", () => {
  // "Brain/.snapshots-old" must NOT be eaten by "Brain/.snapshots".
  expect(matchRules("Brain/.snapshots-old/x.md", rules).matched).toBe(false);
});

test("matchRules on an empty relPath matches nothing (vault root)", () => {
  expect(matchRules("", rules).matched).toBe(false);
});

test("matchRules with no rules matches nothing", () => {
  expect(matchRules(".git/HEAD", []).matched).toBe(false);
});

// ----- matchScope (the composed verdict) -----------------------------------

const excludeOnly: VaultScopeRules = { ignore: rules, include: null };
const withInclude: VaultScopeRules = {
  ignore: rules,
  include: [
    { raw: "Brain", kind: "name" },
    { raw: "Notes/Daily", kind: "path" },
  ],
};

test("matchScope: no allowlist declared means exclusion decides alone", () => {
  expect(matchScope("Notes/idea.md", excludeOnly)).toEqual({
    inScope: true,
    reason: null,
    rule: null,
    matchedAt: null,
  });
  const refused = matchScope(".git/HEAD", excludeOnly);
  expect(refused.inScope).toBe(false);
  expect(refused.reason).toBe("ignored");
  expect(refused.rule?.raw).toBe(".git");
  expect(refused.matchedAt).toBe(".git");
});

test("matchScope: a declared allowlist admits only what it names", () => {
  expect(matchScope("Brain/preferences/p.md", withInclude).inScope).toBe(true);
  expect(matchScope("Notes/Daily/2026-05-19.md", withInclude).inScope).toBe(true);
  const outside = matchScope("Notes/idea.md", withInclude);
  expect(outside.inScope).toBe(false);
  expect(outside.reason).toBe("not-included");
  // Nothing REFUSED it by name: there is no rule to blame, only the
  // absence of one that admits.
  expect(outside.rule).toBeNull();
});

test("matchScope: the allowlist narrows segment-wise, never textually", () => {
  expect(matchScope("Notes/Daily-archive/x.md", withInclude).inScope).toBe(false);
  expect(matchScope("Brainstorm/x.md", withInclude).inScope).toBe(false);
});

test("matchScope: exclusion still wins inside an included root", () => {
  const both = matchScope("Brain/.snapshots/2026-05-19.tar.zst", withInclude);
  expect(both.inScope).toBe(false);
  // The refusal names the polarity an operator can act on: the entry
  // they wrote under ignore_paths, not the allowlist that would have
  // admitted the path.
  expect(both.reason).toBe("ignored");
  expect(both.rule?.raw).toBe("Brain/.snapshots");
});

test("matchScope: the vault root is in scope under an allowlist", () => {
  // The root is not "a path outside every include root" - it is the
  // container of all of them, and a walker that refused it would walk
  // nothing at all.
  expect(matchScope("", withInclude).inScope).toBe(true);
  expect(matchScope("", excludeOnly).inScope).toBe(true);
});

test("matchScope: an allowlist entry matches at any depth, like the exclude grammar", () => {
  // One grammar, both polarities: a slashless entry is a NAME rule. The
  // depth-agnostic reading is inherited deliberately rather than given a
  // second syntax nobody asked for.
  expect(matchScope("projects/Brain/notes.md", withInclude).inScope).toBe(true);
});

// ----- mayDescend ----------------------------------------------------------

const pathInclude: VaultScopeRules = {
  ignore: rules,
  include: [{ raw: "Notes/Daily", kind: "path" }],
};

test("mayDescend: the allowlist narrows FILES, so a parent of a root is descended", () => {
  // `Notes` holds no included file itself, but `Notes/Daily` lives under
  // it. A walker that stopped here would never reach the declared root.
  expect(mayDescend("Notes", pathInclude)).toBe(true);
  expect(mayDescend("Notes/Daily", pathInclude)).toBe(true);
  expect(mayDescend("Notes/Daily/2026", pathInclude)).toBe(true);
});

test("mayDescend: a directory that can hold no included file is not descended", () => {
  expect(mayDescend("Archive", pathInclude)).toBe(false);
  expect(mayDescend("Notes/Weekly", pathInclude)).toBe(false);
});

test("mayDescend: an excluded directory is never descended, either polarity", () => {
  expect(mayDescend("Brain/.snapshots", withInclude)).toBe(false);
  expect(mayDescend("node_modules", excludeOnly)).toBe(false);
});

test("mayDescend: without an allowlist only exclusion stops descent", () => {
  expect(mayDescend("Archive", excludeOnly)).toBe(true);
  expect(mayDescend("", excludeOnly)).toBe(true);
});

test("mayDescend: the vault root is always descended", () => {
  expect(mayDescend("", pathInclude)).toBe(true);
});

test("mayDescend: a name-kind include root can appear at any depth, so descent continues", () => {
  // `Brain` is a name rule: `projects/Brain/` is included, so no
  // directory can be ruled out on the way there.
  expect(mayDescend("projects", withInclude)).toBe(true);
  expect(mayDescend("", withInclude)).toBe(true);
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
  expect(scope.rules.ignore.find((r) => r.raw === "Brain/.snapshots")?.kind).toBe("path");
  expect(scope.rules.ignore.find((r) => r.raw === ".obsidian")?.kind).toBe("name");
});

test("resolveVaultScope: an undeclared allowlist is null, never an empty array", () => {
  // The distinction is the whole feature: `null` is "no allowlist", and
  // an empty array would read as "admit nothing".
  expect(resolveVaultScope(scopeVault).includePaths).toBeNull();
  expect(resolveVaultScope(scopeVault).rules.include).toBeNull();
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
  expect(scope.rules.ignore.map((r) => r.kind)).toEqual(["name", "name"]);
  expect(scope.includePaths).toBeNull();
});

test("resolveVaultScope: reads vault.include_paths when present", () => {
  writeBrain(`schema_version: 1
vault:
  include_paths:
    - Brain
    - Notes/Daily
`);
  const scope = resolveVaultScope(scopeVault);
  expect(scope.source).toBe("_brain.yaml");
  expect(scope.includePaths).toEqual(["Brain", "Notes/Daily"]);
  expect(scope.rules.include?.map((r) => r.kind)).toEqual(["name", "path"]);
  // An allowlist alone does not disable the built-in exclusions: the two
  // keys are independent, and a vault that declared only include_paths
  // still skips `.git` and friends.
  expect(scope.ignorePaths).toEqual([...DEFAULT_VAULT_IGNORE_PATHS]);
});

test("resolveVaultScope: explicit empty list excludes nothing", () => {
  writeBrain(`schema_version: 1
vault:
  ignore_paths:
`);
  const scope = resolveVaultScope(scopeVault);
  expect(scope.source).toBe("_brain.yaml");
  expect(scope.ignorePaths).toEqual([]);
  expect(scope.rules.ignore).toEqual([]);
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
  expect(Object.isFrozen(scope.rules.ignore)).toBe(true);
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
  expect(obsidianHit?.rule?.raw).toBe(".obsidian");
  expect(obsidianHit?.reason).toBe("ignored");
  // Subtree descendants must NOT be reported separately.
  expect(walk.excludedDirs.filter((d) => d.relPath.startsWith(".obsidian/"))).toHaveLength(0);
});

test("walkVaultScope: file-level rule excludes a single file but not the parent", () => {
  writeFileSync(join(scopeVault, "note.md"), "x");
  writeFileSync(join(scopeVault, "secret.md"), "x");
  const walk = walkVaultScope(scopeVault, scopeOf(["secret.md"], null));
  expect(walk.excludedFiles.map((f) => f.relPath)).toContain("secret.md");
  expect(walk.includedFiles).toBe(1);
});

test("walkVaultScope: an allowlist walks only the named roots, minus exclusions", () => {
  writeFileSync(join(scopeVault, "top.md"), "x");
  mkdirSync(join(scopeVault, "Notes"), { recursive: true });
  writeFileSync(join(scopeVault, "Notes", "idea.md"), "x");
  mkdirSync(join(scopeVault, "Notes", "private"), { recursive: true });
  writeFileSync(join(scopeVault, "Notes", "private", "diary.md"), "x");
  mkdirSync(join(scopeVault, "Archive"), { recursive: true });
  writeFileSync(join(scopeVault, "Archive", "old.md"), "x");

  const walk = walkVaultScope(scopeVault, scopeOf(["Notes/private"], ["Notes"]));

  // `Notes/idea.md` only: `Archive/old.md` and `top.md` are outside the
  // allowlist, `Notes/private` is excluded inside it.
  expect(walk.includedFiles).toBe(1);
  expect(walk.excludedFiles.map((f) => f.relPath).toSorted()).toEqual(["Archive/old.md", "top.md"]);
  expect(walk.excludedFiles.find((f) => f.relPath === "top.md")?.reason).toBe("not-included");
  expect(walk.excludedDirs.find((d) => d.relPath === "Notes/private")?.reason).toBe("ignored");
  // `Archive` itself is DESCENDED, not pruned: `Notes` is a bare name,
  // which matches at any depth, so a nested `Archive/Notes/` would be in
  // scope and no directory can be ruled out on the way to one.
  expect(walk.excludedDirs.find((d) => d.relPath === "Archive")).toBeUndefined();
});

test("walkVaultScope: a path-kind include root prunes whole directories", () => {
  writeFileSync(join(scopeVault, "top.md"), "x");
  mkdirSync(join(scopeVault, "Notes", "Daily"), { recursive: true });
  writeFileSync(join(scopeVault, "Notes", "Daily", "2026-05-19.md"), "x");
  mkdirSync(join(scopeVault, "Archive"), { recursive: true });
  writeFileSync(join(scopeVault, "Archive", "old.md"), "x");

  const walk = walkVaultScope(scopeVault, scopeOf([], ["Notes/Daily"]));

  expect(walk.includedFiles).toBe(1);
  // Named a path, so the root is exactly one place: `Archive` cannot
  // hold an included file and is refused whole, while `Notes` is
  // descended because the declared root lives under it.
  expect(walk.excludedDirs.find((d) => d.relPath === "Archive")?.reason).toBe("not-included");
  expect(walk.excludedDirs.find((d) => d.relPath === "Notes")).toBeUndefined();
});

test("walkVaultScope: index-admission refusals are reported, not counted as included", () => {
  // The adjacent defect this release fixes: the search walker refuses the
  // exact-state lane and `o2b vault status` did not, so the two disagreed
  // about the same vault and status over-reported index coverage.
  mkdirSync(join(scopeVault, "Brain", "state"), { recursive: true });
  writeFileSync(join(scopeVault, "Brain", "state", "live.md"), "x");
  const walk = walkVaultScope(scopeVault, resolveVaultScope(scopeVault));
  expect(walk.includedFiles).toBe(0);
  const lane = walk.excludedDirs.find((d) => d.relPath === "Brain/state");
  expect(lane?.reason).toBe("not-admitted");
  expect(lane?.rule).toBeNull();
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

test("inspectPath: a path outside the allowlist is excluded, naming that polarity", () => {
  const r = inspectPath("Archive/old.md", scopeOf([], ["Notes"]), scopeVault);
  expect(r.excluded).toBe(true);
  expect(r.reason).toBe("not-included");
  expect(r.rule).toBeNull();
});

test("inspectPath: the vault root is in scope under an allowlist", () => {
  const r = inspectPath("", scopeOf([], ["Notes"]), scopeVault);
  expect(r.excluded).toBe(false);
  expect(r.reason).toBeNull();
});

test("inspectPath: a lane-owned path is in scope but not admitted to the index", () => {
  // Two independent verdicts. Vault scope admits `Brain/state`; the
  // index refuses it. Collapsing them would tell an operator their
  // exact-state file is searchable.
  const scope = resolveVaultScope(scopeVault);
  const r = inspectPath("Brain/state/live.md", scope, scopeVault);
  expect(r.excluded).toBe(false);
  expect(r.indexAdmitted).toBe(false);
  expect(r.admissionReason).toBe("exact-state-lane");
});

test("inspectPath: an ordinary path is admitted to the index", () => {
  const scope = resolveVaultScope(scopeVault);
  const r = inspectPath("Notes/idea.md", scope, scopeVault);
  expect(r.indexAdmitted).toBe(true);
  expect(r.admissionReason).toBeNull();
});

test("inspectPath: excluded by name rule reports the matched directory", () => {
  const scope = resolveVaultScope(scopeVault);
  const r = inspectPath(".obsidian/plugins/foo/note.md", scope, scopeVault);
  expect(r.excluded).toBe(true);
  expect(r.reason).toBe("ignored");
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

// ----- absent include_paths: today's behaviour, byte for byte ---------------
//
// The most important test in this unit. Every literal below was RECORDED
// from the implementation as it stood before `vault.include_paths` existed
// (v1.45.1, one fixture vault, three walkers), so the assertion is a
// measurement rather than a restatement of the new code. A vault that never
// mentions the key must be walked exactly as it was.
//
// The one deliberate difference is stated in its own test rather than
// folded in here: `Brain/state` is now refused by the index-admission
// filter that `walkVaultScope` previously omitted.

const FIXTURE_FILES: ReadonlyArray<string> = [
  "Brain/_brain.yaml",
  "Brain/preferences/pref-a.md",
  "Brain/.snapshots/2026-01-01.txt",
  "Notes/idea.md",
  "Notes/deep/nested.md",
  "Notes-archive/old.md",
  "Journal/2026/entry.md",
  "top.md",
  ".obsidian/app.json",
  ".git/HEAD",
  "node_modules/pkg/readme.md",
];

function buildFixtureVault(root: string): void {
  for (const rel of FIXTURE_FILES) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, rel === "Brain/_brain.yaml" ? "schema_version: 1\n" : "x");
  }
}

test("absent include_paths: the fixture vault walks exactly as it did before the key existed", () => {
  buildFixtureVault(scopeVault);
  const scope = resolveVaultScope(scopeVault);
  const walk = walkVaultScope(scopeVault, scope);

  expect(scope.source).toBe("defaults");
  expect(scope.includePaths).toBeNull();
  expect(walk.includedFiles).toBe(7);
  expect(walk.includedDirs).toBe(7);
  expect(walk.excludedDirs.map((d) => [d.relPath, d.rule?.raw ?? null])).toEqual([
    [".git", ".git"],
    [".obsidian", ".obsidian"],
    ["Brain/.snapshots", "Brain/.snapshots"],
    ["node_modules", "node_modules"],
  ]);
  expect(walk.excludedFiles).toEqual([]);
});

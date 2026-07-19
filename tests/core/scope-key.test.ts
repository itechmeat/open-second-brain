import { test, expect } from "bun:test";

import {
  canonicalSourceSetKey,
  compositeScopeKey,
  rrfKey,
  scopeAxisReachable,
  scopeFromFrontmatter,
} from "../../src/core/scope-key.ts";

test("scopeFromFrontmatter reads and normalizes the three axes", () => {
  const scope = scopeFromFrontmatter({
    owner: " Claude-Dev ",
    session: "Feat/Agent Surface",
    project: "Open Second Brain",
  });
  expect(scope.owner).toBe("claude-dev");
  expect(scope.session).toBe("feat-agent-surface");
  expect(scope.project).toBe("open-second-brain");
});

test("absent scope axes are null and produce an empty composite key", () => {
  const scope = scopeFromFrontmatter({});
  expect(scope).toEqual({ owner: null, session: null, project: null });
  // Empty key: a scopeless page keys byte-identically to the pre-scope world.
  expect(compositeScopeKey(scope)).toBe("");
});

test("composite key distinguishes scopes and collapses identical scopes", () => {
  const a = compositeScopeKey(scopeFromFrontmatter({ session: "s1" }));
  const b = compositeScopeKey(scopeFromFrontmatter({ session: "s2" }));
  const aAgain = compositeScopeKey(scopeFromFrontmatter({ session: "S1" }));
  expect(a).not.toBe(b);
  expect(a).toBe(aAgain);
  // Different axes with the same slug value must not collide.
  expect(compositeScopeKey(scopeFromFrontmatter({ owner: "x" }))).not.toBe(
    compositeScopeKey(scopeFromFrontmatter({ project: "x" })),
  );
});

test("scopeAxisReachable: a null request reaches every page (no filtering)", () => {
  expect(scopeAxisReachable("s1", null)).toBe(true);
  expect(scopeAxisReachable(null, null)).toBe(true);
});

test("scopeAxisReachable: a scoped request reaches only its own scope and unscoped pages", () => {
  expect(scopeAxisReachable("s1", "s1")).toBe(true);
  expect(scopeAxisReachable(null, "s1")).toBe(true); // unscoped page is shared
  expect(scopeAxisReachable("s2", "s1")).toBe(false);
});

test("rrfKey carries source identity so cross-origin chunk ids never collide", () => {
  const a = rrfKey({ origin: "vaultA", path: "note.md", chunkId: 7 });
  const b = rrfKey({ origin: "vaultB", path: "note.md", chunkId: 7 });
  expect(a).not.toBe(b);
  // Same origin + same chunk is the same source identity.
  expect(rrfKey({ origin: "vaultA", path: "note.md", chunkId: 7 })).toBe(a);
  // A null origin (single-vault) is stable and distinct from a labelled one.
  expect(rrfKey({ origin: null, path: "note.md", chunkId: 7 })).not.toBe(a);
});

test("canonicalSourceSetKey is order-independent and dedupes origins", () => {
  expect(canonicalSourceSetKey(["b", "a", "a"])).toBe(canonicalSourceSetKey(["a", "b"]));
  expect(canonicalSourceSetKey([])).toBe(canonicalSourceSetKey([]));
  expect(canonicalSourceSetKey(["a"])).not.toBe(canonicalSourceSetKey(["a", "b"]));
});

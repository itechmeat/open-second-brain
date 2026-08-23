/**
 * The zero-embed link-candidate manifest (nothing-writes-silently, unit E).
 *
 * Claims pinned here:
 *
 *   1. The manifest is built from the vault's own basenames and nothing
 *      else: no embedding provider, no vector store, no search index is
 *      reachable from this module by any import path.
 *   2. A vault inside the bound reports every basename it holds, says the
 *      list is whole, and names how it was chosen.
 *   3. A vault over the bound NAMES the total it could not carry rather
 *      than handing back a short list that reads as the whole vault.
 *   4. A query ranks the kept subset by the vault's own deterministic
 *      token overlap; without one the subset is alphabetical, and both
 *      selections are named on the manifest.
 *   5. A limit that is not a positive integer is refused by name.
 *   5a. A basename the caller may not see is DROPPED AND UNCOUNTED - the
 *      IDENTICAL TO ABSENT convention: a total that included hidden pages
 *      would tell one agent how many of another's memories exist.
 *   6. The schema hint states the bound honestly in all three cases -
 *      whole vault, truncated subset, and a vault with no notes at all.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import {
  buildLinkCandidateManifest,
  LINK_CANDIDATE_LIMIT,
  LinkCandidateError,
  linkCandidateSchemaHint,
} from "../../../../src/core/brain/notes/link-candidates.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MODULE_REL = "src/core/brain/notes/link-candidates.ts";

/** Roots no zero-embed module may reach, by any chain of imports. */
const FORBIDDEN_ROOTS: ReadonlyArray<string> = Object.freeze([
  "src/core/search/embeddings",
  "src/core/search/store",
  "src/core/search/indexer.ts",
]);

/** The unfiltered caller - what `ownerScopeView(vault, null)` hands back. */
const ALL_VISIBLE = Object.freeze({ visible: () => true });

function vaultWith(names: ReadonlyArray<string>): string {
  const vault = mkdtempSync(join(tmpdir(), "o2b-link-candidates-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  for (const name of names) {
    const abs = join(vault, `${name}.md`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `# ${name}\n`);
  }
  return vault;
}

/** Every `src/` module reachable from `entry`, entry included. */
function importClosure(entry: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = resolve(dirname(join(REPO_ROOT, rel)), match[1]!);
      queue.push(relative(REPO_ROOT, target).split("\\").join("/"));
    }
  }
  return [...seen].toSorted();
}

describe("the manifest is zero-embed by construction", () => {
  test("no provider, vector store or index module is reachable from it", () => {
    const closure = importClosure(MODULE_REL);
    const reached = closure.filter((path) =>
      FORBIDDEN_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)),
    );
    expect(reached.join("\n")).toBe("");
    // …and the walk has to have found something, or it proves nothing.
    expect(closure.length).toBeGreaterThan(1);
  });
});

describe("a vault inside the bound", () => {
  test("reports every basename, whole and named as whole", () => {
    const vault = vaultWith(["beta", "alpha", "notes/gamma"]);
    const manifest = buildLinkCandidateManifest(vault, ALL_VISIBLE);
    expect(manifest.candidates).toEqual(["alpha", "beta", "gamma"]);
    expect(manifest.total).toBe(3);
    expect(manifest.truncated).toBe(false);
    expect(manifest.selection).toBe("all");
  });

  test("is frozen, so an envelope cannot be edited after it is built", () => {
    const manifest = buildLinkCandidateManifest(vaultWith(["alpha"]), ALL_VISIBLE);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.candidates)).toBe(true);
  });
});

describe("a vault over the bound", () => {
  const names = Array.from({ length: 12 }, (_, i) => `note-${String(i).padStart(2, "0")}`);

  test("names the total it could not carry rather than reading as the whole vault", () => {
    const manifest = buildLinkCandidateManifest(vaultWith(names), { ...ALL_VISIBLE, limit: 4 });
    expect(manifest.candidates).toHaveLength(4);
    expect(manifest.total).toBe(12);
    expect(manifest.truncated).toBe(true);
    expect(manifest.selection).toBe("alphabetical");
    expect(manifest.candidates).toEqual(["note-00", "note-01", "note-02", "note-03"]);
  });

  test("a query ranks the kept subset by the vault's own token overlap", () => {
    const vault = vaultWith([...names, "ada-lovelace", "charles-babbage"]);
    const manifest = buildLinkCandidateManifest(vault, {
      ...ALL_VISIBLE,
      limit: 2,
      query: "Ada Lovelace",
    });
    expect(manifest.selection).toBe("relevance");
    expect(manifest.candidates[0]).toBe("ada-lovelace");
    expect(manifest.total).toBe(14);
    expect(manifest.truncated).toBe(true);
  });

  test("ranking is deterministic: the same vault and query give the same list", () => {
    const vault = vaultWith([...names, "ada-lovelace"]);
    const first = buildLinkCandidateManifest(vault, { ...ALL_VISIBLE, limit: 3, query: "ada" });
    const second = buildLinkCandidateManifest(vault, { ...ALL_VISIBLE, limit: 3, query: "ada" });
    expect(first.candidates).toEqual(second.candidates);
  });
});

describe("a candidate the caller may not see", () => {
  test("is dropped, and does not survive in the total either", () => {
    const vault = vaultWith(["pref-mine", "pref-theirs", "shared"]);
    const manifest = buildLinkCandidateManifest(vault, {
      visible: (rel) => rel !== "pref-theirs.md",
    });
    expect(manifest.candidates).toEqual(["pref-mine", "shared"]);
    expect(manifest.total).toBe(2);
    expect(manifest.truncated).toBe(false);
  });

  test("cannot reappear through the ranking path either", () => {
    const names = Array.from({ length: 9 }, (_, i) => `note-${i}`);
    const manifest = buildLinkCandidateManifest(vaultWith([...names, "pref-theirs"]), {
      visible: (rel) => rel !== "pref-theirs.md",
      query: "pref theirs",
      limit: 3,
    });
    expect(manifest.candidates).not.toContain("pref-theirs");
    expect(manifest.total).toBe(9);
  });
});

describe("the bound itself", () => {
  test("the default is the named constant, not a literal at the call site", () => {
    expect(LINK_CANDIDATE_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(LINK_CANDIDATE_LIMIT)).toBe(true);
  });

  test("a limit that is not a positive integer is refused by name", () => {
    const vault = vaultWith(["alpha"]);
    expect(() => buildLinkCandidateManifest(vault, { ...ALL_VISIBLE, limit: 0 })).toThrow(
      LinkCandidateError,
    );
    expect(() => buildLinkCandidateManifest(vault, { ...ALL_VISIBLE, limit: 0 })).toThrow(/limit/);
    expect(() => buildLinkCandidateManifest(vault, { ...ALL_VISIBLE, limit: -3 })).toThrow(/limit/);
    expect(() => buildLinkCandidateManifest(vault, { ...ALL_VISIBLE, limit: 2.5 })).toThrow(
      /limit/,
    );
    expect(() => buildLinkCandidateManifest(vault, { ...ALL_VISIBLE, limit: Number.NaN })).toThrow(
      /limit/,
    );
  });
});

describe("the schema hint says what the list is", () => {
  test("a whole-vault manifest says the list is the whole vault", () => {
    const hint = linkCandidateSchemaHint(
      buildLinkCandidateManifest(vaultWith(["alpha", "beta"]), ALL_VISIBLE),
    );
    expect(hint).toContain("link_candidates");
    expect(hint).toContain("2");
    expect(hint).not.toContain("of the");
  });

  test("a truncated manifest says how much it left out", () => {
    const names = Array.from({ length: 9 }, (_, i) => `note-${i}`);
    const hint = linkCandidateSchemaHint(
      buildLinkCandidateManifest(vaultWith(names), { ...ALL_VISIBLE, limit: 3 }),
    );
    expect(hint).toContain("3");
    expect(hint).toContain("9");
  });

  test("an empty vault says so rather than claiming a complete list of nothing", () => {
    const hint = linkCandidateSchemaHint(buildLinkCandidateManifest(vaultWith([]), ALL_VISIBLE));
    expect(hint).toMatch(/no notes/);
  });
});

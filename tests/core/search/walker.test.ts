import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkVault } from "../../../src/core/search/walker.ts";
import { createTempVault, writeMd, writeSymlink, makeConfig } from "../../helpers/search-fixtures.ts";

let vault: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("walker");
  vault = v.vault;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function collect(cfg: ReturnType<typeof makeConfig>): string[] {
  const out: string[] = [];
  for (const f of walkVault(cfg)) out.push(f.relPath);
  return out.sort();
}

test("returns *.md files relative to vault, POSIX paths", () => {
  writeMd(vault, "a.md", "# a");
  writeMd(vault, "b/c.md", "# c");
  writeMd(vault, "b/d/e.md", "# e");
  const cfg = makeConfig({ vault, dbPath: join(vault, "x.sqlite") });
  expect(collect(cfg)).toEqual(["a.md", "b/c.md", "b/d/e.md"]);
});

test("skips non-md files", () => {
  writeMd(vault, "keep.md", "x");
  writeMd(vault, "drop.txt", "x");
  writeMd(vault, "Notes/README", "x");
  const cfg = makeConfig({ vault, dbPath: join(vault, "x.sqlite") });
  expect(collect(cfg)).toEqual(["keep.md"]);
});

test("skips ignored bare directory names anywhere in tree", () => {
  writeMd(vault, "keep.md", "x");
  writeMd(vault, ".git/dropped.md", "x");
  writeMd(vault, "node_modules/lib/index.md", "x");
  writeMd(vault, "deep/.git/also-dropped.md", "x");
  const cfg = makeConfig({ vault, dbPath: join(vault, "x.sqlite") });
  expect(collect(cfg)).toEqual(["keep.md"]);
});

test("skips ignored relative-path directories but keeps sibling subtrees", () => {
  writeMd(vault, "keep.md", "x");
  // `Brain/.snapshots` is a path-style rule in the default set.
  writeMd(vault, "Brain/.snapshots/2026-05-19.md", "x");
  // `Brain/active.md` is a sibling under the same parent — must NOT
  // be eaten by the snapshots rule.
  writeMd(vault, "Brain/active.md", "x");
  const cfg = makeConfig({ vault, dbPath: join(vault, "x.sqlite") });
  expect(collect(cfg)).toEqual(["Brain/active.md", "keep.md"]);
});

test("v0.10.9 default: full .obsidian directory is excluded", () => {
  writeMd(vault, "keep.md", "x");
  writeMd(vault, ".obsidian/cache/cached.md", "x");
  writeMd(vault, ".obsidian/plugins/foo/note.md", "x");
  writeMd(vault, ".obsidian/app.md", "x");
  const cfg = makeConfig({ vault, dbPath: join(vault, "x.sqlite") });
  expect(collect(cfg)).toEqual(["keep.md"]);
});

test("ignores symlinks pointing outside vault", () => {
  const outside = mkdtempSync(join(tmpdir(), "osb-walker-out-"));
  writeFileSync(join(outside, "leak.md"), "secret");
  mkdirSync(join(vault, "inside"), { recursive: true });

  // Symlink file → outside file
  writeSymlink(vault, "evil.md", join(outside, "leak.md"));
  // Symlink dir → outside dir
  writeSymlink(vault, "linked-dir", outside);

  writeMd(vault, "real.md", "x");
  const cfg = makeConfig({ vault, dbPath: join(vault, "x.sqlite") });
  const found = collect(cfg);
  expect(found).toContain("real.md");
  expect(found).not.toContain("evil.md");
  expect(found.find((p) => p.startsWith("linked-dir/"))).toBeUndefined();
  rmSync(outside, { recursive: true, force: true });
});

test("hidden non-ignored dirs are still walked", () => {
  writeMd(vault, ".hiddendir/note.md", "x");
  writeMd(vault, "normal.md", "x");
  const cfg = makeConfig({ vault, dbPath: join(vault, "x.sqlite"), ignorePaths: [".git"] });
  expect(collect(cfg)).toEqual([".hiddendir/note.md", "normal.md"]);
});

test("empty directories produce zero files", () => {
  mkdirSync(join(vault, "empty"), { recursive: true });
  const cfg = makeConfig({ vault, dbPath: join(vault, "x.sqlite") });
  expect(collect(cfg)).toEqual([]);
});

/**
 * Guard: every loop that walks up the parent folders with `dirname` stops
 * where `dirname` stops moving, never on a POSIX-only root test.
 *
 * `dirname("/")` is `"/"`, but `dirname("D:\\")` is `"D:\\"`: a walk that
 * ends on `d !== "/"` or `d.length > 1` ends on Linux and macOS and spins
 * forever on Windows. A synchronous spin also starves the test runner's
 * own timeout, so a Windows CI shard hangs until the job limit cancels
 * it, which is how a shard of the automatic store migration tests was
 * lost. The one condition that ends on every platform is the fixed point
 * `d !== dirname(d)` (or `parent === current`, then `break`).
 *
 * ## What counts as a walk
 *
 * A `for (let <v> = …; <condition>; <v> = dirname(<v>))` header. Its
 * condition has to call `dirname` too (the fixed point), or its body has to
 * leave on `dirname(<v>) === <v>` (as `linkBelowVault` in `local-state.ts`
 * does, beside its own stop at the vault). A `while` walk is
 * not read here: the one in `src/` (`existingAncestor` in `migrate.ts`)
 * breaks on `parent === current`, and this census is where that form gets
 * added the day a second one appears.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The roots the census walks. */
const SWEPT_ROOTS = Object.freeze(["src", "tests", "hooks", "scripts"]);

const SELF = "tests/core/architecture/ancestor-walk-root-census.test.ts";

/** A `for` header that steps a variable to its parent folder. */
const DIRNAME_STEP =
  /for\s*\(\s*let\s+(\w+)\s*=[^;]*;([^;]*);\s*\1\s*=\s*dirname\(\s*\1\s*\)\s*\)/g;

function sourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** The braced body that starts after `from`, or "" for a one-statement loop. */
function bodyOf(text: string, from: number): string {
  const open = text.indexOf("{", from);
  if (open === -1 || text.slice(from, open).trim() !== "") return "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** `file:line` of every parent walk whose condition is not the fixed point. */
function rootUnsafeWalks(text: string, file: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(DIRNAME_STEP)) {
    const variable = match[1] ?? "";
    const condition = match[2] ?? "";
    if (/\bdirname\(/.test(condition)) continue;
    if (
      bodyOf(text, (match.index ?? 0) + match[0].length).includes(
        `dirname(${variable}) === ${variable}`,
      )
    ) {
      continue;
    }
    const line = text.slice(0, match.index).split("\n").length;
    found.push(`${file}:${line}`);
  }
  return found;
}

describe("guard: a parent-folder walk ends on every platform", () => {
  test("the detector sees a POSIX-only stop and passes the fixed point", () => {
    expect(
      rootUnsafeWalks("for (let d = dirname(p); d.length > 1; d = dirname(d)) {}", "a.ts"),
    ).toEqual(["a.ts:1"]);
    expect(rootUnsafeWalks('for (let d = p; d !== "/"; d = dirname(d)) {}', "b.ts")).toEqual([
      "b.ts:1",
    ]);
    expect(rootUnsafeWalks("for (let d = p; d !== dirname(d); d = dirname(d)) {}", "c.ts")).toEqual(
      [],
    );
    expect(
      rootUnsafeWalks(
        "for (let d = p; d !== root; d = dirname(d)) {\n  if (dirname(d) === d) return false;\n}",
        "d.ts",
      ),
    ).toEqual([]);
  });

  test("no walk in the tree stops on a POSIX-only root test", () => {
    const offenders: string[] = [];
    for (const root of SWEPT_ROOTS) {
      for (const path of sourceFiles(join(REPO_ROOT, root), [])) {
        const file = relative(REPO_ROOT, path).split("\\").join("/");
        // This file spells the forbidden shapes as the detector's samples.
        if (file === SELF) continue;
        offenders.push(...rootUnsafeWalks(readFileSync(path, "utf8"), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

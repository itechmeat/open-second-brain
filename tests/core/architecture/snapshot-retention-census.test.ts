/**
 * Every Brain snapshot obeys `snapshots.retention_count`.
 *
 * Retention is enforced in exactly one place: `takeSnapshot` in
 * `src/core/brain/snapshot-gate.ts` writes the archive and prunes around
 * it. A module that calls `createSnapshot` directly writes an archive no
 * prune ever follows, which is how upgrade archives once grew to 911
 * copies on a live install and how promote-host-memory archives escaped
 * retention until it was routed through the gate.
 *
 * So the direct callers are counted. `snapshot.ts` defines the function
 * and `snapshot-gate.ts` is the gate; any other module calling it fails
 * here until it goes through `takeSnapshot` (or `withDestructiveSnapshot`,
 * which calls it). The source is read through the shared lexer's code
 * view, so a call named in a comment or a string is not counted, and the
 * gate's own call is required to be found, so the census cannot pass over
 * a pattern that stopped matching.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { lexCode } from "../../helpers/source-lexer.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** A call of `createSnapshot`, not its definition or a longer name. */
const DIRECT_CALL_RE = /(?<![\w.$])createSnapshot\s*\(/g;
const DEFINITION_RE = /function\s+createSnapshot\s*\(/g;

/** Modules allowed to call `createSnapshot` directly, with the reason. */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  "src/core/brain/snapshot.ts": "defines createSnapshot",
  "src/core/brain/snapshot-gate.ts": "takeSnapshot: the archive and the prune around it",
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:ts|mts|cts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** How many direct calls `text` makes, definitions excluded. */
function directCalls(text: string): number {
  const code = lexCode(text);
  const calls = code.match(DIRECT_CALL_RE)?.length ?? 0;
  const definitions = code.match(DEFINITION_RE)?.length ?? 0;
  return calls - definitions;
}

describe("snapshot retention census", () => {
  const callers = sourceFiles(SRC_ROOT)
    .map((path) => ({
      rel: relative(REPO_ROOT, path).split("\\").join("/"),
      calls: directCalls(readFileSync(path, "utf8")),
    }))
    .filter((f) => f.calls > 0);

  test("only the gate calls createSnapshot directly", () => {
    const offenders = callers.map((f) => f.rel).filter((rel) => !(rel in ALLOWED));
    expect(offenders).toEqual([]);
  });

  test("the census finds the gate's own call, so its pattern still matches", () => {
    expect(callers.map((f) => f.rel)).toContain("src/core/brain/snapshot-gate.ts");
  });

  test("a call in a comment or string is not counted, a real one is", () => {
    expect(directCalls('// createSnapshot(vault)\nconst s = "createSnapshot(x)";\n')).toBe(0);
    expect(directCalls("export function createSnapshot(v: string) {}\n")).toBe(0);
    expect(directCalls("createSnapshot(vault, id, { reason });\n")).toBe(1);
  });
});

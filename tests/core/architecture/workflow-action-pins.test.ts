/**
 * Every action a workflow runs is pinned to a full commit SHA.
 *
 * A tag (`@v2`) is a mutable pointer in someone else's repository: whoever
 * can move it chooses the code that runs in CI and in the release job,
 * with this repository's token. A 40-hex commit cannot be moved. The
 * trailing `# vX.Y.Z` comment keeps the pin reviewable and is what
 * update tooling reads, so it is required too.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

const USES_RE = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/;
const PINNED_RE = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /^\s*#\s*v\d+\.\d+\.\d+\s*$/;

function usesLines(): ReadonlyArray<{ file: string; line: number; ref: string; rest: string }> {
  const out: Array<{ file: string; line: number; ref: string; rest: string }> = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = readFileSync(join(WORKFLOWS, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      const m = USES_RE.exec(text);
      if (m !== null) out.push({ file, line: i + 1, ref: m[1]!, rest: m[2]! });
    });
  }
  return out;
}

describe("workflow actions are pinned", () => {
  const all = usesLines();

  test("the workflows use at least one action (the scan is looking at them)", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  test("every remote action is a full commit SHA with a version comment", () => {
    const loose = all
      // A local action (`./.github/actions/x`) is this repository's own code.
      .filter((u) => !u.ref.startsWith("./"))
      .filter((u) => !PINNED_RE.test(u.ref) || !VERSION_COMMENT_RE.test(u.rest))
      .map((u) => `${u.file}:${u.line} ${u.ref}${u.rest}`);
    expect(loose).toEqual([]);
  });
});

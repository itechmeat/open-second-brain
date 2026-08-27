/**
 * `o2b brain page-dedup` end to end, over the repro from GitHub #180.
 *
 * The issue was filed against the CLI, and the CLI is where the damage
 * happened: the second `--apply` of a cron loop re-merged a pair it had
 * already merged. The core tests own the predicate; this file owns what
 * an operator actually types.
 *
 * Claims pinned here:
 *
 *  1. The first `--apply` merges the pair and stamps `merged_into`.
 *  2. The dry run that follows it reports ZERO clusters for that pair -
 *     the finished cluster is gone from the listing, not merely ranked
 *     lower.
 *  3. A second `--apply` merges nothing and writes nothing. The fixture
 *     carries no `created_at`, so the canonical ordering falls back to
 *     the mtime the first merge moved - the exact condition under which
 *     the second pass used to reverse the pair and write a merge cycle
 *     into the vault.
 *  4. Neither page ends up in a cycle, so `brain lint --consolidate` can
 *     still resolve every link to either of them.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-page-dedup-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  atomicWriteFileSync(join(tmp, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(tmp, "config.yaml") });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** One preference with no `created_at`, as a legacy / hand-authored page. */
function writePref(slug: string, body: string): string {
  const path = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  writeFileSync(
    path,
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      "topic: em-dashes",
      "_status: confirmed",
      "principle: never use em dashes",
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function prefText(slug: string): string {
  return readFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), "utf8");
}

async function pageDedup(extra: string[]): Promise<Record<string, unknown>> {
  const res = await runCli(["brain", "page-dedup", "--vault", vault, "--json", ...extra]);
  expect(res.returncode).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

test("an applied merge is not proposed again, and a rerun writes no cycle", async () => {
  const aPath = writePref("a", "see also [[pref-b]]");
  writePref("b", "duplicate of the rule above");

  const first = await pageDedup(["--apply", "--yes"]);
  expect(first["clusters"]).toBe(1);
  expect(first["merged"]).toBe(1);
  expect(first["wikilinks_updated"]).toBe(1);
  expect(prefText("b")).toContain("merged_into: pref-a");

  // The wikilink rewrite touched `pref-a`, so its mtime is now newer
  // than `pref-b`'s - the ordering flip that used to reverse the pair.
  const second = await pageDedup([]);
  expect(second["candidates"]).toEqual([]);
  expect(second["scanned"]).toBe(2);

  const reapply = await pageDedup(["--apply", "--yes"]);
  expect(reapply["clusters"]).toBe(0);
  expect(reapply["merged"]).toBe(0);
  expect(readFileSync(aPath, "utf8")).not.toContain("merged_into");
  expect(prefText("b")).toContain("merged_into: pref-a");

  const lint = await runCli(["brain", "lint", "--consolidate", "--vault", vault]);
  expect(lint.returncode).toBe(0);
  expect(lint.stdout).not.toContain("merge cycle detected");
});

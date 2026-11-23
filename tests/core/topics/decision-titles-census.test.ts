/**
 * Census: a decision's title is taken from its page through one owner,
 * `topics/decision-titles.ts` (`decisionEventTitle` over the titles
 * `decisionTitlesOf` folds, which judges completeness and privacy). Any
 * other source file that folds decision pages itself, or calls
 * `decisionTitlesOf` without stating whether its read is complete, would be
 * a site that could name a shared event with the wrong version's title.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const OWNER = "src/core/topics/decision-titles.ts";

function sources(): string[] {
  return [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: ROOT })].map((p) =>
    p.split("\\").join("/"),
  );
}

test("only the owner folds decision pages for their titles", () => {
  const folding = sources().filter((rel) => {
    if (rel === OWNER) return false;
    const text = readFileSync(join(ROOT, rel), "utf8");
    return /lane["']?\]?\s*===\s*["']decisions["']|DECISIONS_LANE/.test(text);
  });
  expect(folding).toEqual([]);
}, 30_000);

test("every call of decisionTitlesOf states the completeness of its read", () => {
  for (const rel of sources()) {
    if (rel === OWNER) continue;
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const match of text.matchAll(/decisionTitlesOf\(([^)]*)\)/gs)) {
      expect(match[1], `${rel}: ${match[0]}`).toContain("complete:");
    }
  }
});

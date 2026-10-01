/**
 * Every retrieval-trail code a `--json` or `brain_search` answer can carry
 * has its own row in the trail table of `docs/cli-reference.md`, and so
 * does every rerank failure category `detail.category` can name, so a
 * code or category shipped without its documentation fails here, not in
 * a reader's client.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RERANK_FAILURE_CATEGORIES } from "../../src/core/search/rerank/failure.ts";
import { RETRIEVAL_DEGRADATION_CODES } from "../../src/core/search/retrieval-trail.ts";

const CLI_REFERENCE = readFileSync(
  join(import.meta.dir, "..", "..", "docs", "cli-reference.md"),
  "utf8",
);

/** The table whose header row is `header`, up to the blank line after it. */
function tableUnder(header: string): string {
  const start = CLI_REFERENCE.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = CLI_REFERENCE.indexOf("\n\n", start);
  return CLI_REFERENCE.slice(start, end === -1 ? undefined : end);
}

/** The tokens of `tokens` that head no row of `table`. */
function withoutRow(table: string, tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  return tokens.filter((token) => !table.includes(`\n| \`${token}\` |`));
}

test("every retrieval degradation code has a row in the trail table", () => {
  const table = tableUnder("| Code | The narrowing it reports |");
  expect(withoutRow(table, RETRIEVAL_DEGRADATION_CODES)).toEqual([]);
});

test("every rerank failure category has a row in the category table", () => {
  const table = tableUnder("| Category | The failure it names |");
  expect(withoutRow(table, RERANK_FAILURE_CATEGORIES)).toEqual([]);
});

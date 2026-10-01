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

/** The tokens of `tokens` that head no table row in the CLI reference. */
function withoutRow(tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  return tokens.filter((token) => !CLI_REFERENCE.includes(`| \`${token}\` |`));
}

test("every retrieval degradation code has a row in the trail table", () => {
  expect(withoutRow(RETRIEVAL_DEGRADATION_CODES)).toEqual([]);
});

test("every rerank failure category has a row in the category table", () => {
  expect(withoutRow(RERANK_FAILURE_CATEGORIES)).toEqual([]);
});

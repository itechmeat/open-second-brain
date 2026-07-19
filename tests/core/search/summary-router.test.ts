/**
 * Summary-search router integration (R1, t_7b96f242). A vault that declares
 * an artifact kind in its schema pack routes structurally summary-shaped
 * queries to the summary surface (`outcome.surface === "summary"`), while
 * every non-summary query is byte-identical to today: `outcome.surface` is
 * absent and the ranked results are unchanged.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

function writeSchemaPack(v: string, body: string): void {
  mkdirSync(join(v, "Brain"), { recursive: true });
  writeFileSync(join(v, "Brain", "_brain.yaml"), body, "utf8");
}

beforeEach(async () => {
  ({ vault, dbPath, cleanup } = createTempVault("summary-router"));
  writeSchemaPack(
    vault,
    ["schema_version: 1", "schema:", "  page_types: [note, summary]", ""].join("\n"),
  );
  writeMd(vault, "postgres.md", "# Postgres\n\nBackup and restore of the Postgres database.\n");
  writeMd(vault, "deploy.md", "# Deploy\n\nHow to configure staging deployment pipelines.\n");
  await indexVault(makeConfig({ vault, dbPath }));
});

afterEach(() => cleanup());

test("an artifact-kind query routes to the summary surface", async () => {
  const outcome = await search(makeConfig({ vault, dbPath }), {
    query: "kind:summary postgres",
    limit: 5,
  });
  expect(outcome.surface).toBe("summary");
});

test("a source-targeted query routes to the summary surface", async () => {
  const outcome = await search(makeConfig({ vault, dbPath }), {
    query: "source:postgres.md",
    limit: 5,
  });
  expect(outcome.surface).toBe("summary");
});

test("a plain query is byte-identical: no surface field, unchanged results", async () => {
  const outcome = await search(makeConfig({ vault, dbPath }), {
    query: "postgres backup",
    limit: 5,
  });
  expect(outcome.surface).toBeUndefined();
  expect(outcome.results.length).toBeGreaterThan(0);
  expect(outcome.results[0]!.path).toBe("postgres.md");
});

test("an unknown artifact kind does not route to the summary surface", async () => {
  const outcome = await search(makeConfig({ vault, dbPath }), {
    query: "kind:invoice postgres",
    limit: 5,
  });
  expect(outcome.surface).toBeUndefined();
});

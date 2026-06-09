/**
 * End-to-end entity-boosted retrieval: among two documents that match
 * the query's keyword equally, the one that also names the query's
 * entity ranks higher and exposes an entity_match reason.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault, search } from "../../../src/core/search/index.ts";
import { makeConfig, createTempVault } from "../../helpers/search-fixtures.ts";

let tmp: ReturnType<typeof createTempVault>;

beforeEach(async () => {
  tmp = createTempVault("entity-boost");
  mkdirSync(join(tmp.vault, "notes"), { recursive: true });
  // Both notes contain the keyword tokens (vector, store) so the
  // FTS AND-query retrieves both equally. Only with-entity names the
  // capitalized entity "Vector Store"; plain uses the same words in lower
  // case, so only with-entity carries the entity the query also names.
  writeFileSync(
    join(tmp.vault, "notes", "with-entity.md"),
    "---\ntitle: With Entity\n---\n\nThe vector flow runs through Vector Store to store vector data.\n",
  );
  writeFileSync(
    join(tmp.vault, "notes", "plain.md"),
    "---\ntitle: Plain\n---\n\nThe vector system will store vector data generically on demand.\n",
  );
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
  await indexVault(config, {});
});

afterEach(() => {
  tmp.cleanup();
});

test("a doc naming the query entity ranks above an equal keyword-only doc", async () => {
  // maxHops 0 isolates the entity signal from traversal.
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
  const out = await search(config, { query: "vector Vector Store", limit: 10 });
  const withEntity = out.results.findIndex((r) => r.path === "notes/with-entity.md");
  const plain = out.results.findIndex((r) => r.path === "notes/plain.md");
  expect(withEntity).toBeGreaterThanOrEqual(0);
  expect(plain).toBeGreaterThanOrEqual(0);
  expect(withEntity).toBeLessThan(plain); // entity doc ranks first
  const top = out.results[withEntity]!;
  expect(top.reasons.some((x) => x.startsWith("entity_match"))).toBe(true);
});

/**
 * End-to-end link-graph traversal: a document that does NOT match the
 * query but is linked from a strong hit is surfaced via traversal, and
 * disabling traversal (maxHops 0) hides it again.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault, search } from "../../../src/core/search/index.ts";
import { makeConfig, createTempVault } from "../../helpers/search-fixtures.ts";

let tmp: ReturnType<typeof createTempVault>;

beforeEach(async () => {
  tmp = createTempVault("traversal-recall");
  mkdirSync(join(tmp.vault, "notes"), { recursive: true });
  // hub.md matches "kingfisher" and links to spoke.md, which talks about
  // something else entirely (no query-term overlap).
  writeFileSync(
    join(tmp.vault, "notes", "hub.md"),
    "---\ntitle: Hub\n---\n\nThe kingfisher dives fast. See [[notes/spoke.md|spoke]] for the related note.\n",
  );
  writeFileSync(
    join(tmp.vault, "notes", "spoke.md"),
    "---\ntitle: Spoke\n---\n\nUnrelated content about migration patterns and tides.\n",
  );
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath });
  await indexVault(config, {});
});

afterEach(() => {
  tmp.cleanup();
});

test("a linked-but-non-matching doc is surfaced by traversal", async () => {
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath });
  const out = await search(config, { query: "kingfisher", limit: 10 });
  const paths = out.results.map((r) => r.path);
  expect(paths).toContain("notes/hub.md");
  expect(paths).toContain("notes/spoke.md");
  const spoke = out.results.find((r) => r.path === "notes/spoke.md")!;
  expect(spoke.searchType).toBe("link");
  expect(spoke.reasons.some((x) => x.startsWith("link_traversal"))).toBe(true);
});

test("maxHops 0 hides the linked-but-non-matching doc", async () => {
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
  const out = await search(config, { query: "kingfisher", limit: 10 });
  const paths = out.results.map((r) => r.path);
  expect(paths).toContain("notes/hub.md");
  expect(paths).not.toContain("notes/spoke.md");
});

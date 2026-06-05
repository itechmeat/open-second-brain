/**
 * Tier drift detection (t_3f92d3f1, part 2): the indexer seeds a
 * tiered-frontmatter snapshot per framework-kind document and, on
 * later runs, stages a tier_drift finding when an identity field's
 * value changed against the snapshot. The snapshot keeps the expected
 * value, so repeated reindexes never absorb a hand-edit; system-tier
 * fields update silently because framework writers mutate them
 * legitimately on every pass.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("tier-drift"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
});

afterEach(() => {
  cleanup();
});

function writePref(id: string, createdAt = "2026-05-01T00:00:00Z", body = "Use spaces.\n"): void {
  writeMd(
    vault,
    "Brain/preferences/pref-spaces.md",
    `---\nkind: brain-preference\nid: ${id}\ncreated_at: ${createdAt}\ntopic: style\n---\n\n${body}`,
  );
}

async function drift(): Promise<ReturnType<Store["listTierDrift"]>> {
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "read" });
  try {
    return store.listTierDrift();
  } finally {
    await store.close();
  }
}

test("a hand-edited identity field stages drift the reindex never absorbs", async () => {
  const config = makeConfig({ vault, dbPath });
  writePref("pref-spaces");
  const first = await indexVault(config);
  expect(first.tierDrift).toHaveLength(0);
  expect(await drift()).toHaveLength(0);

  // Hand-edit the join key.
  writePref("pref-tabs");
  const second = await indexVault(config);
  expect(second.tierDrift).toEqual([
    {
      path: "Brain/preferences/pref-spaces.md",
      field: "id",
      expected: "pref-spaces",
      actual: "pref-tabs",
    },
  ]);
  const rows = await drift();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ field: "id", expected: "pref-spaces", actual: "pref-tabs" });

  // A third run with the same hand-edit still reports against the
  // ORIGINAL expected value - the snapshot did not absorb the edit.
  // (The body must change SIZE: the indexer's mtime+size fastpath
  // skips same-second same-size rewrites.)
  writePref("pref-tabs", "2026-05-01T00:00:00Z", "Use considerably more spaces!\n");
  const third = await indexVault(config);
  expect(third.tierDrift).toEqual([
    {
      path: "Brain/preferences/pref-spaces.md",
      field: "id",
      expected: "pref-spaces",
      actual: "pref-tabs",
    },
  ]);
});

test("restoring the original value clears the drift on the next run", async () => {
  const config = makeConfig({ vault, dbPath });
  writePref("pref-spaces");
  await indexVault(config);
  writePref("pref-tabs");
  await indexVault(config);
  expect(await drift()).toHaveLength(1);

  writePref("pref-spaces", "2026-05-01T00:00:00Z", "Use spaces - restored by hand.\n");
  const healed = await indexVault(config);
  expect(healed.tierDrift).toHaveLength(0);
  expect(await drift()).toHaveLength(0);
});

test("deleting an identity field stages drift with a null actual", async () => {
  const config = makeConfig({ vault, dbPath });
  writePref("pref-spaces");
  await indexVault(config);
  writeMd(
    vault,
    "Brain/preferences/pref-spaces.md",
    "---\nkind: brain-preference\ncreated_at: 2026-05-01T00:00:00Z\ntopic: style\n---\n\nNo id anymore.\n",
  );
  const stats = await indexVault(config);
  expect(stats.tierDrift).toEqual([
    {
      path: "Brain/preferences/pref-spaces.md",
      field: "id",
      expected: "pref-spaces",
      actual: null,
    },
  ]);
});

test("system-tier changes update the snapshot without staging drift", async () => {
  const config = makeConfig({ vault, dbPath });
  writePref("pref-spaces", "2026-05-01T00:00:00Z");
  await indexVault(config);
  writePref("pref-spaces", "2026-06-01T12:00:00Z", "Use spaces, refreshed by the framework.\n");
  const stats = await indexVault(config);
  expect(stats.tierDrift).toHaveLength(0);
  expect(await drift()).toHaveLength(0);
});

test("unknown kinds never seed snapshots or drift", async () => {
  const config = makeConfig({ vault, dbPath });
  writeMd(vault, "notes/list.md", "---\nkind: shopping-list\nid: original\n---\n\nMilk.\n");
  await indexVault(config);
  writeMd(vault, "notes/list.md", "---\nkind: shopping-list\nid: changed\n---\n\nMilk.\n");
  const stats = await indexVault(config);
  expect(stats.tierDrift).toHaveLength(0);
  expect(await drift()).toHaveLength(0);
});

test("deleting the document drops its drift rows", async () => {
  const config = makeConfig({ vault, dbPath });
  writePref("pref-spaces");
  await indexVault(config);
  writePref("pref-tabs");
  await indexVault(config);
  expect(await drift()).toHaveLength(1);

  const { rmSync } = await import("node:fs");
  rmSync(join(vault, "Brain", "preferences", "pref-spaces.md"));
  await indexVault(config);
  expect(await drift()).toHaveLength(0);
});

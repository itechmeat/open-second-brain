/**
 * Indexer alias extraction (link-recall-intelligence, Task 3):
 * frontmatter `aliases:` arrays land in `doc_aliases` during the
 * incremental pass, the alias resolve pass materializes
 * `target_document_id` after exact-path resolution, the run's
 * `IndexStats.aliasResolved` counts it, and a non-empty run leaves
 * one `index` metric record for the dashboard contract.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-idx-alias-"));
  config = makeConfig({ vault, dbPath: join(vault, "index.sqlite") });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

async function aliasLinkTarget(sourcePath: string): Promise<number | null> {
  const store = await Store.open(config, { mode: "read" });
  try {
    // Same private-db introspection idiom as time-range.test.ts.
    const row = (store as any).db
      .query(
        "SELECT l.target_document_id AS t FROM links l " +
          "JOIN documents d ON d.id = l.source_document_id WHERE d.path = ?",
      )
      .get(sourcePath) as { t: number | null } | null;
    return row?.t ?? null;
  } finally {
    await store.close();
  }
}

test("a wikilink to a declared alias materializes through the index run", async () => {
  writeFileSync(
    join(vault, "project-alpha.md"),
    '---\ntitle: Project Alpha\naliases: ["PA", "Alpha"]\n---\n\n# Project Alpha\n\nThe canonical page.\n',
  );
  writeFileSync(join(vault, "source.md"), "# Source\n\nSee [[PA]] for details.\n");

  const stats = await indexVault(config);
  expect(stats.aliasResolved).toBe(1);
  expect(await aliasLinkTarget("source.md")).not.toBeNull();

  const metrics = listMetrics(vault, { surface: "index" });
  expect(metrics).toHaveLength(1);
  expect(metrics[0]!.payload).toMatchObject({
    added: 2,
    alias_resolved: 1,
    relation_violations: 0,
    tier_drift: 0,
  });
});

test("removing the alias un-materializes on the next run", async () => {
  writeFileSync(
    join(vault, "project-alpha.md"),
    '---\ntitle: Project Alpha\naliases: ["PA"]\n---\n\n# Project Alpha\n\nBody one.\n',
  );
  writeFileSync(join(vault, "source.md"), "# Source\n\nSee [[PA]].\n");
  await indexVault(config);
  expect(await aliasLinkTarget("source.md")).not.toBeNull();

  // Different body length so the mtime+size fastpath cannot skip the
  // rewrite inside the same second.
  writeFileSync(
    join(vault, "project-alpha.md"),
    "---\ntitle: Project Alpha\n---\n\n# Project Alpha\n\nBody two, now without any alias declared.\n",
  );
  const second = await indexVault(config);
  expect(second.aliasResolved).toBe(0);
  expect(await aliasLinkTarget("source.md")).toBeNull();
});

test("non-array and non-string alias values are skipped quietly", async () => {
  writeFileSync(
    join(vault, "odd.md"),
    "---\ntitle: Odd\naliases: just-a-string\n---\n\n# Odd\n\nBody.\n",
  );
  writeFileSync(
    join(vault, "mixed.md"),
    "---\ntitle: Mixed\naliases: [ok-alias, 42]\n---\n\n# Mixed\n\nBody.\n",
  );
  writeFileSync(join(vault, "src.md"), "# Src\n\n[[ok-alias]] and [[just-a-string]].\n");
  const stats = await indexVault(config);
  expect(stats.aliasResolved).toBe(1);
  expect(stats.errors).toEqual([]);
});

test("an unchanged vault run emits no metric record", async () => {
  writeFileSync(join(vault, "a.md"), "# A\n\nBody.\n");
  await indexVault(config);
  await indexVault(config);
  expect(listMetrics(vault, { surface: "index" })).toHaveLength(1);
});

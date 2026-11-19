/**
 * Files this product itself leaves beside a legacy file (change
 * migration-sync-conflict-copies, follow-up): the search index store's
 * family (the parked `.bak` and `.old`, the `.new` staging, the
 * restore's staged store, each with its journals), the temp files its
 * writers rename onto their targets, and lock siblings. Each one next to
 * its original never stops the dry run and goes by its original's rule;
 * an unknown file still stops it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { planMigrationDryRun } from "../../../src/core/store-migration/dry-run.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { removeLegacyTree } from "../../../src/core/store-migration/removal.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
const INDEX = ".open-second-brain/brain.sqlite";

/** Every file the search store layer can leave beside the index, spelled out. */
const STORE_FAMILY: ReadonlyArray<string> = [".new", ".bak", ".old", ".restore-4242-0a1b2c3d"]
  .flatMap((db) => ["", "-wal", "-shm", "-journal"].map((j) => `${INDEX}${db}${j}`))
  .concat([`${INDEX}-wal`, `${INDEX}-shm`, `${INDEX}-journal`]);

/** [original, sibling] pairs: a writer's temp file or lock beside a file a mapping reads. */
const WRITER_SIBLINGS: ReadonlyArray<readonly [string, string]> = [
  // An atomic write of fs-atomic.ts.
  ["Brain/pinned.md", "Brain/.pinned.md.4242.1763560000000.0a1b.tmp"],
  // A lane page's archive copy staged beside its target (recompile.ts).
  ["Brain/procedures/deploy.md", "Brain/procedures/deploy.md.4242.tmp"],
  // The maintenance journal compaction (maintenance/journal.ts).
  [
    ".open-second-brain/maintenance-runs.dev-a.jsonl",
    ".open-second-brain/maintenance-runs.dev-a.jsonl.tmp",
  ],
  // The freshen-state file's staging and a writer's lock on it.
  [".open-second-brain/freshen-state.json", ".open-second-brain/freshen-state.json.tmp"],
  [".open-second-brain/freshen-state.json", ".open-second-brain/freshen-state.json.lock"],
  // The freshen child's claim (left by a start whose process died) and its
  // pending marker, kept beside its state (search/freshen.ts).
  [".open-second-brain/freshen-state.json", ".open-second-brain/freshen.claim"],
  [".open-second-brain/freshen-state.json", ".open-second-brain/freshen-pending.json"],
  // A sync tool's conflict copy of a writer's atomic temp file: transient too.
  [
    "Brain/pinned.md",
    "Brain/.pinned.md.4242.1763560000000.0a1b.sync-conflict-20261119-120000-ABCDEFG.tmp",
  ],
];

/**
 * Files that only look like a writer's temp file: no file of the name it
 * would be renamed onto exists, so each one is the person's own file in a
 * lane that takes any file, and is imported like any other.
 */
const MUST_STILL_BE_IMPORTED: ReadonlyArray<string> = [
  "Brain/.archives/draft.tmp",
  "Brain/.archives/notes.4242.tmp",
];

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

function planted(): MigrationBench {
  const b = makeMigrationBench("osb-sibling-families-");
  for (const rel of STORE_FAMILY) b.fx.write(rel, "SQLite format 3\0");
  for (const [original, sibling] of WRITER_SIBLINGS) {
    if (!existsSync(join(b.vault, ...original.split("/")))) b.fx.write(original, "{}\n");
    b.fx.write(sibling, "{}\n");
  }
  return b;
}

describe("files the product leaves beside a legacy file", () => {
  test("the dry run maps every one and counts the index family under the search index", () => {
    bench = planted();
    const plan = planMigrationDryRun(bench.vault);
    expect(plan.unmapped.map((u) => u.path)).toEqual([]);
    expect(plan.ok).toBe(true);
    const index = plan.surfaces.find((s) => s.id === "search_index")!;
    // The fixture's own index plus every family member, sized, never read.
    expect(index.files).toBe(1 + STORE_FAMILY.length);
    expect(index.partitions).toBeNull();
  });

  test.each(WRITER_SIBLINGS.map(([o, s]) => [s, o]))(
    "%s beside %s is never an item of its own",
    (sibling) => {
      bench = planted();
      expect(runMigration(bench.vault, FAST).ok).toBe(true);
      const keys = [...bench.byKey().keys()];
      expect(keys.filter((k) => k.startsWith(sibling))).toEqual([]);
    },
  );

  test.each(MUST_STILL_BE_IMPORTED.map((rel) => [rel]))(
    "%s, with nothing it would become, is still imported",
    (rel) => {
      bench = makeMigrationBench("osb-sibling-families-");
      bench.fx.write(rel, "the person's own file\n");
      expect(planMigrationDryRun(bench.vault).unmapped).toEqual([]);
      expect(runMigration(bench.vault, FAST).ok).toBe(true);
      expect(bench.byKey().get(rel)).toHaveLength(1);
    },
  );

  test("the removal leaves the index family out of its archive, as it does the index", () => {
    bench = planted();
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const removed = removeLegacyTree(bench.vault, bench.store(), { agent: "t", force: true });
    expect(removed.removed).toBe(true);
    if (!removed.removed) return;
    for (const rel of [INDEX, ...STORE_FAMILY]) {
      expect(existsSync(join(bench.vault, ...rel.split("/")))).toBe(false);
      expect([rel, removed.skipped.includes(rel)]).toEqual([rel, true]);
    }
  });

  test.each([
    [".open-second-brain/brain.sqlite.bak.tar"],
    [".open-second-brain/brain.sqlite-notes.md"],
    ["Brain/log/stray.tmp"],
    ["Brain/log/stray.4242.tmp"],
  ])("an unknown file %s still stops the run", (rel) => {
    bench = makeMigrationBench("osb-sibling-families-");
    bench.fx.write(rel, "x\n");
    const plan = planMigrationDryRun(bench.vault);
    expect(plan.unmapped.map((u) => u.path)).toEqual([rel]);
    expect(plan.ok).toBe(false);
  });
});

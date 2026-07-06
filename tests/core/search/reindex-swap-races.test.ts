/**
 * Index-swap hardening (t_f27d80fe). Two interlocking races around the
 * `reindexVault` rebuild + rename swap, both silent-data-loss class:
 *
 *   A.1 — two concurrent reindex runs. The pre-fix code unlinked and
 *         re-seeded the shared `.new` staging path with NO lock held, so a
 *         second run could destroy the first's in-progress staging DB and
 *         then have its empty seed swapped over the live index
 *         (INDEX_UNREADABLE, search stays broken until a manual reindex).
 *
 *   A.2 — a read opening in the swap window between `rename(db -> bak)` and
 *         `rename(new -> db)`. The lockless crash-restore preamble on
 *         `Store.open` saw "db missing, bak present", concluded a prior
 *         reindex crashed, and restored the STALE `.bak` over the fresh
 *         index — discarding the whole rebuild.
 *
 * The fix serialises reindexes on the LIVE db-path writer lock and gates
 * the crash-restore on that same lock. The genuine crash-recovery path
 * (no live holder) is exercised by indexer.test.ts's ".bak auto-restore".
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, rmSync } from "node:fs";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { acquireWriterLock, Store } from "../../../src/core/search/store.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { IndexStats } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("reindex-swap-races");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("A.1: two overlapping reindex runs leave a complete, readable index", async () => {
  const docs = 8;
  for (let i = 0; i < docs; i++) writeMd(vault, `n${i}.md`, `# N${i}\n\nbody number ${i} words`);
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg); // seed a live index so the swap / .bak path engages

  // Launch a second reindex DURING the first's build phase (while it holds
  // the live-path writer lock). With the fix it serialises on that lock;
  // without it, its synchronous pre-lock `tryUnlink(.new)` destroyed the
  // first run's staging DB mid-build.
  let second: Promise<IndexStats | Error> | null = null;
  const firstStats = await reindexVault(cfg, {
    onFile: () => {
      if (!second) {
        second = reindexVault(cfg).catch((e: unknown) =>
          e instanceof Error ? e : new Error(String(e)),
        );
      }
    },
  });
  const secondResult: IndexStats | Error | null = second ? await second : null;

  expect(firstStats.added).toBeGreaterThanOrEqual(docs);

  // The second contender either rebuilt cleanly (took the lock once the
  // first released) or fast-failed with INDEX_LOCKED — never corruption.
  if (secondResult !== null && secondResult instanceof Error) {
    expect(secondResult).toBeInstanceOf(SearchError);
    expect((secondResult as SearchError).code).toBe("INDEX_LOCKED");
  }

  // The surviving live index is complete and READABLE — no empty seed was
  // swapped in, so no INDEX_UNREADABLE.
  const store = await Store.open(cfg, { mode: "read" });
  try {
    expect(store.listDocuments().size).toBe(docs);
  } finally {
    await store.close();
  }
  // Staging file cleaned up by the swap.
  expect(existsSync(`${dbPath}.new`)).toBe(false);
});

test("A.2: a read during the swap window does not restore stale .bak over the fresh index", async () => {
  writeMd(vault, "a.md", "# A\n\nalpha content");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg); // live index present
  // Fabricate a `.bak` snapshot, as a prior reindex swap would leave.
  cpSync(dbPath, `${dbPath}.bak`);

  // Simulate a reindex mid-swap: hold the LIVE-path writer lock with the
  // live db momentarily absent — the exact window between rename(db->bak)
  // and rename(new->db).
  const release = await acquireWriterLock(dbPath);
  try {
    rmSync(dbPath);

    // A concurrent read must NOT restore `.bak` while a writer holds the
    // lock: doing so would clobber the about-to-be-swapped-in fresh index.
    // It skips the restore and reports the transient missing state honestly.
    await expect(Store.open(cfg, { mode: "read" })).rejects.toMatchObject({
      code: "INDEX_MISSING",
    });

    // Crucially, `.bak` was left intact — not consumed by a spurious restore.
    expect(existsSync(`${dbPath}.bak`)).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  } finally {
    await release();
  }
});

test("A.2: crash-restore still fires when no writer holds the lock (genuine crash)", async () => {
  writeMd(vault, "a.md", "# A\n\nalpha content");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  cpSync(dbPath, `${dbPath}.bak`);

  // No live writer: db absent + bak present is a genuine crashed-reindex
  // signature, so the next open restores immediately.
  rmSync(dbPath);
  const store = await Store.open(cfg, { mode: "read" });
  try {
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.bak`)).toBe(false); // consumed by the restore
  } finally {
    await store.close();
  }
});

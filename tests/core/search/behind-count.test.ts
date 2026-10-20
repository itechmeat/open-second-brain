/**
 * The measured index-behind count (t_e4438152): a stat-only walk diffed
 * against the stored documents classifies what the next incremental run
 * would add, update or delete - measured live, before that run happens.
 *
 * Deliberate upper-bound semantics pinned here: a touch-only file (same
 * bytes, bumped mtime) counts as changed, because the walk never reads
 * content - it replicates the incremental fastpath's mtime+size
 * comparison, not the hash fallback.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexBehindCount, indexVault } from "../../../src/core/search/indexer.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let config: ResolvedSearchConfig;

/** A fixed past instant, so stored and on-disk mtimes never race the clock. */
const T0 = Date.now() - 60_000;
/** A distinct second, so a stat-only comparison sees the change. */
const T1 = new Date(T0 + 10_000);
const T0_DATE = new Date(T0);

beforeEach(async () => {
  const v = createTempVault("behind-count");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  config = makeConfig({ vault, dbPath });
  for (const rel of ["notes/heron.md", "notes/second.md", "notes/third.md"]) {
    utimesSync(writeMd(vault, rel, `# ${rel}\n\nseed body.\n`), T0_DATE, T0_DATE);
  }
  await indexVault(config);
});

afterEach(() => cleanup());

test("a freshly indexed vault measures zero behind", async () => {
  expect(await indexBehindCount(config)).toEqual({
    behind: 0,
    unindexed: 0,
    changed: 0,
    deleted: 0,
  });
});

test("added, edited, touch-only and deleted files classify exactly", async () => {
  // Edited: new bytes AND a bumped mtime - the file the next run must read.
  utimesSync(writeMd(vault, "notes/heron.md", "# heron\n\nedited body.\n"), T1, T1);
  // Touch-only: same bytes, bumped mtime. Counts as changed - the walk is
  // stat-only, so this is an upper bound on what the run would spend.
  utimesSync(join(vault, "notes", "second.md"), T1, T1);
  // Deleted from disk; the index still holds the row.
  rmSync(join(vault, "notes", "third.md"));
  // Added: on disk, never indexed.
  writeMd(vault, "notes/fresh.md", "# fresh\n\nnew body.\n");

  expect(await indexBehindCount(config)).toEqual({
    behind: 4,
    unindexed: 1,
    changed: 2,
    deleted: 1,
  });
});

test("ignored paths and admission-lane paths are not counted", async () => {
  writeMd(vault, "node_modules/leak.md", "# leak\n");
  writeMd(vault, "Brain/state/ledger.md", "# ledger\n");
  expect(await indexBehindCount(config)).toEqual({
    behind: 0,
    unindexed: 0,
    changed: 0,
    deleted: 0,
  });
});

test("a missing index is not measured, not zero", async () => {
  const bare = mkdtempSync(join(tmpdir(), "osb-behind-bare-"));
  try {
    const bareConfig = makeConfig({
      vault: bare,
      dbPath: join(bare, ".open-second-brain", "brain.sqlite"),
    });
    expect(await indexBehindCount(bareConfig)).toBeNull();
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

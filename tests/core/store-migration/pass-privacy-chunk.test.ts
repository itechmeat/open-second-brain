/**
 * A page reference's privacy verdict inside one migration pass is never
 * older than one import batch (review of change
 * migration-sync-conflict-copies): a preference page another machine makes
 * private while the pass runs makes every row judged after the next batch
 * private, as a per-row judge would.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { convertPass, dualWritePool } from "../../../src/core/store-migration/convert.ts";
import { loadJournal, migrationDir } from "../../../src/core/store-migration/journal.ts";
import { journalScopeFor } from "../../../src/core/store-migration/backup.ts";
import { neverHeld } from "../../helpers/held-partitions.ts";
import { resetFreezeMarkerCache } from "../../../src/core/brain/freeze-marker.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

const SHARD = "Brain/log/2026-11-05.dev-a.jsonl";

test("a page made private between two batches makes the later rows private", () => {
  bench = makeMigrationBench("osb-pass-privacy-");
  const b = bench;
  const rows = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({
      ts: `2026-11-05T10:0${i}:00Z`,
      kind: "apply-evidence",
      payload: { pref_id: "pref-open", n: i },
      prev: null,
      h: "0".repeat(64),
    }),
  );
  b.fx.write(SHARD, rows.join("\n") + "\n");
  let flipped = false;
  const result = runMigration(b.vault, {
    settleMs: 0,
    importBatchItems: 2,
    hooks: {
      afterItemAppended: () => {
        if (flipped || !b.byKey().has(`${SHARD}#1`)) return;
        // Another machine makes the preference private; sync delivers it.
        b.fx.write(
          "Brain/preferences/pref-open.md",
          "---\nid: pref-open\nprinciple: Open rule\nstatus: active\nvisibility: private\n---\nBody.\n",
        );
        flipped = true;
      },
    },
  });
  expect(result.ok).toBe(true);
  expect(flipped).toBe(true);
  const byKey = b.byKey();
  const partitionOf = (line: number) => byKey.get(`${SHARD}#${line}`)?.[0]?.partition;
  // Judged in the batch before the change: as the page was then.
  expect(partitionOf(1)).toBe("shared");
  // Every row of a later batch sees the private page.
  expect([3, 4, 5, 6, 7, 8].map(partitionOf)).toEqual(Array(6).fill("private"));
});

test("rows the journal already holds count toward the batch, so a resume sees the change too", () => {
  bench = makeMigrationBench("osb-pass-privacy-");
  const b = bench;
  const rows = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({
      ts: `2026-11-05T10:0${i}:00Z`,
      kind: "apply-evidence",
      payload: { pref_id: "pref-open", n: i },
      prev: null,
      h: "0".repeat(64),
    }),
  );
  b.fx.write(SHARD, rows.join("\n") + "\n");
  // A run that stops once the first four rows are in, as a crash would.
  expect(() =>
    runMigration(b.vault, {
      settleMs: 0,
      importBatchItems: 2,
      hooks: {
        afterItemAppended: () => {
          if (b.byKey().has(`${SHARD}#4`)) throw new Error("stopped");
        },
      },
    }),
  ).toThrow("stopped");
  resetFreezeMarkerCache();
  // The resume skips rows 1 to 4, which the journal holds; while it does,
  // another machine makes the preference private.
  let flipped = false;
  const result = runMigration(b.vault, {
    settleMs: 0,
    resume: true,
    importBatchItems: 2,
    hooks: {
      afterItemVisited: (key) => {
        if (flipped || key !== `${SHARD}#4`) return;
        b.fx.write(
          "Brain/preferences/pref-open.md",
          "---\nid: pref-open\nprinciple: Open rule\nstatus: active\nvisibility: private\n---\nBody.\n",
        );
        flipped = true;
      },
    },
  });
  expect(result.ok).toBe(true);
  expect(flipped).toBe(true);
  const byKey = b.byKey();
  const partitionOf = (line: number) => byKey.get(`${SHARD}#${line}`)?.[0]?.partition;
  expect([1, 2, 3, 4].map(partitionOf)).toEqual(Array(4).fill("shared"));
  expect([5, 6, 7, 8].map(partitionOf)).toEqual(Array(4).fill("private"));
});

const ROW = (n: number): string =>
  JSON.stringify({
    ts: `2026-11-06T10:0${n}:00Z`,
    kind: "note",
    payload: { text: `visited ${n}` },
    prev: null,
    h: "0".repeat(64),
  });
const LATE = "Brain/log/2026-11-06.dev-a.jsonl";

/** How many items one pass over the switched bench's tree visits. */
function visits(b: MigrationBench): number {
  const store = b.store();
  const dir = migrationDir(store);
  const scope = journalScopeFor(b.vault, store.device, dir);
  const journal = loadJournal(dir, store, scope);
  let n = 0;
  convertPass({
    vault: b.vault,
    store,
    vaultId: null,
    agent: "t",
    dir,
    journal,
    scope,
    pool: dualWritePool(store, journal, scope),
    hooks: { afterItemVisited: () => (n += 1) },
  });
  return n;
}

describe("every item a pass reaches counts toward the batch, whatever becomes of it", () => {
  test.each([
    [
      "a row the journal already holds",
      (b: MigrationBench) => {
        b.fx.write(LATE, `${ROW(1)}\n`);
        visits(b); // imports it
      },
    ],
    [
      "a copy row identical to its original's",
      (b: MigrationBench) => {
        b.fx.write(LATE, `${ROW(1)}\n`);
        visits(b);
        b.fx.write(
          LATE.replace(".jsonl", ".sync-conflict-20261106-100000-ABCDEFG.jsonl"),
          `${ROW(1)}\n`,
        );
      },
    ],
    ["an unparseable line", (b: MigrationBench) => b.fx.write(LATE, "{not json\n")],
    [
      "an item held back for a partition this machine does not hold",
      (b: MigrationBench) => {
        b.fx.write(
          LATE,
          `${JSON.stringify({ ts: "2026-11-06T10:00:00Z", kind: "apply-evidence", payload: { pref_id: "pref-secret" }, prev: null, h: "0".repeat(64) })}\n`,
        );
        neverHeld(b.storeRoot);
      },
    ],
    [
      "a sync temp file",
      (b: MigrationBench) => b.fx.write("Brain/inbox/.syncthing.sig-x.md.tmp", "x\n"),
    ],
    [
      "a conflict copy dropped with its original",
      (b: MigrationBench) =>
        b.fx.write(
          ".open-second-brain/freshen-state.sync-conflict-20261106-100000-ABCDEFG.json",
          "{}\n",
        ),
    ],
  ])("%s", (_case, plant) => {
    bench = makeMigrationBench("osb-pass-visits-");
    expect(runMigration(bench.vault, { settleMs: 0 }).ok).toBe(true);
    const before = visits(bench);
    plant(bench);
    const after = visits(bench);
    // The base tree's items, plus the one planted (and, for a journaled
    // row or a copy of one, the row the step before put there).
    expect(after - before).toBe(_case.startsWith("a copy row") ? 2 : 1);
  });
});

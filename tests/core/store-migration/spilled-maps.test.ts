/**
 * A run whose maps with one entry per legacy item or store record moved
 * to its scratch file (change migration-memory-peak: the journal, the
 * items a pass saw, the store's checksums, the restored tree's identity)
 * imports, verifies, imports a late write, resumes after a kill and rolls
 * back exactly as a run that kept them in memory, and leaves no scratch
 * file behind. The threshold is set low so the small fixture vault runs
 * the on-disk maps.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resetFreezeMarkerCache } from "../../../src/core/brain/freeze-marker.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { compareRecords } from "../../../src/core/store/envelope.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { migrateStore, rollback } from "../../../src/core/store-migration/outcome.ts";
import { SCRATCH_DIR } from "../../../src/core/store-migration/spill-map.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
const SPILLED = { settleMs: 0, spillAt: 2 } as const;
const KILL_CHILD = join(import.meta.dir, "fixtures", "kill-child.ts");

let benches: MigrationBench[] = [];
afterEach(() => {
  for (const made of benches.toReversed()) made.cleanup();
  benches = [];
});

function makeBench(): MigrationBench {
  const made = makeMigrationBench("osb-spilled-");
  benches.push(made);
  return made;
}

/** A migrated vault's keys with how many records each became. */
function imported(b: MigrationBench): Array<[string, number]> {
  return [...b.byKey()]
    .map(([key, records]) => [key, records.length] as [string, number])
    .toSorted();
}

const scratchLeft = (b: MigrationBench): string[] => {
  const folder = join(migrationDir(b.store()), SCRATCH_DIR);
  return existsSync(folder) ? readdirSync(folder) : [];
};

/** A record written to the store after the switch, which a rollback writes back. */
function writeAfterSwitch(b: MigrationBench, at = Date.now() + 60_000): string {
  return appendRecord(
    b.store(),
    {
      partition: "shared",
      stream: "log",
      kind: "log-event",
      agent: "t",
      body: { timestamp: new Date(at).toISOString(), event_type: "note", body: { text: "new" } },
    },
    { now: () => at },
  ).record.id;
}

/** A late legacy row written after the switch, by a machine still on the legacy layout. */
const LATE_ROW =
  JSON.stringify({
    ts: "2026-11-19T10:00:00Z",
    kind: "note",
    payload: { text: "late write" },
    prev: null,
    h: "0".repeat(64),
  }) + "\n";

test("a spilled run imports, takes a late write and rolls back as an in-memory run does", () => {
  const memory = makeBench();
  const memoryRun = runMigration(memory.vault, FAST);
  appendFileSync(join(memory.vault, "Brain", "log", "2026-11-01.dev-a.jsonl"), LATE_ROW);
  const memoryLate = migrateStore(memory.vault, FAST);
  const memoryKeys = imported(memory);
  writeAfterSwitch(memory);
  const memoryBack = rollback(memory.vault);
  memory.cleanup();
  benches = benches.filter((b) => b !== memory);

  const spilled = makeBench();
  const spilledRun = runMigration(spilled.vault, SPILLED);
  expect(spilledRun.ok).toBe(true);
  expect(spilledRun.gaps).toEqual([]);
  expect(spilledRun.imported).toBe(memoryRun.imported);
  expect(scratchLeft(spilled)).toEqual([]);

  appendFileSync(join(spilled.vault, "Brain", "log", "2026-11-01.dev-a.jsonl"), LATE_ROW);
  const late = migrateStore(spilled.vault, SPILLED);
  expect(late.mode).toBe("transition");
  expect(late.mode === "transition" && late.imported).toBe(1);
  expect(memoryLate.mode === "transition" && memoryLate.imported).toBe(1);
  // Every item once, as the in-memory run imported it.
  expect(imported(spilled)).toEqual(memoryKeys);
  expect(imported(spilled).every(([, n]) => n >= 1)).toBe(true);
  expect(scratchLeft(spilled)).toEqual([]);

  writeAfterSwitch(spilled);
  // Three more, stamped out of the order of their wall times; the spilled
  // rollback writes them back in fold order.
  const base = Date.now() + 120_000;
  const third = writeAfterSwitch(spilled, base + 3_000);
  const first = writeAfterSwitch(spilled, base + 1_000);
  const second = writeAfterSwitch(spilled, base + 2_000);
  const back = rollback(spilled.vault, { spillAt: 2 });
  expect(memoryBack.replayed.length).toBeGreaterThan(0);
  expect(back.replayed.length).toBe(memoryBack.replayed.length + 3);
  const byId = new Map(spilled.records().map((r) => [r.id, r]));
  const inFoldOrder = [first, second, third].toSorted((a, b) =>
    compareRecords(byId.get(a)!, byId.get(b)!),
  );
  expect(back.replayed.slice(-3)).toEqual(inFoldOrder);
  // The whole write-back is in fold order.
  const replayedRecords = back.replayed.map((id) => byId.get(id)!);
  expect(replayedRecords).toEqual(replayedRecords.toSorted(compareRecords));
  expect(back.no_legacy_form).toEqual(memoryBack.no_legacy_form);
  expect(back.ledger_rows_kept).toEqual(memoryBack.ledger_rows_kept);
  expect(back.refused).toEqual(memoryBack.refused);
  expect(scratchLeft(spilled)).toEqual([]);
});

test("a spilled run killed half way resumes once, and the scratch it left is removed", () => {
  const expected = makeBench();
  expect(runMigration(expected.vault, FAST).ok).toBe(true);
  const keys = imported(expected).map(([key]) => key);

  const b = makeBench();
  const child = Bun.spawnSync(
    [process.execPath, "run", KILL_CHILD, "migrate-spilled", b.vault, "5"],
    { env: { ...process.env, ...b.env }, stdout: "ignore", stderr: "pipe" },
  );
  expect(child.success).toBe(false);
  expect(child.exitCode).not.toBe(3);
  resetFreezeMarkerCache();
  // The killed run's scratch file is still there.
  expect(scratchLeft(b).some((name) => name.endsWith(".sqlite"))).toBe(true);

  const result = runMigration(b.vault, { ...SPILLED, resume: true });
  expect(result.ok).toBe(true);
  expect(result.gaps).toEqual([]);
  expect(imported(b).map(([key]) => key)).toEqual(keys);
  for (const [key, records] of b.byKey()) expect([key, records.length]).toEqual([key, 1]);
  expect(scratchLeft(b)).toEqual([]);
});

test("a resumed run that keeps its maps in memory still removes the scratch a killed run left", () => {
  const b = makeBench();
  const child = Bun.spawnSync(
    [process.execPath, "run", KILL_CHILD, "migrate-spilled", b.vault, "5"],
    { env: { ...process.env, ...b.env }, stdout: "ignore", stderr: "pipe" },
  );
  expect(child.success).toBe(false);
  resetFreezeMarkerCache();
  expect(scratchLeft(b).some((name) => name.endsWith(".sqlite"))).toBe(true);
  // The default threshold: the small vault's maps never move to disk.
  const result = runMigration(b.vault, { ...FAST, resume: true });
  expect(result.ok).toBe(true);
  expect(scratchLeft(b)).toEqual([]);
});

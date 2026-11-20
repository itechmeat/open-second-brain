/**
 * The store a migration fills is never read whole (change migration-
 * memory-peak): the migration, the import of a late legacy write, the
 * rollback and the removal of the legacy tree read the store record by
 * record. One shard (this device's `log` shard of the month it migrated)
 * holds every record the migration imported, so a read that collected it
 * would hold the whole store; this test fails on any such read.
 */
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import * as reader from "../../../src/core/store/reader.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { migrateStore, removeLegacy, rollback } from "../../../src/core/store-migration/outcome.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
const ROWS = 300;

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

function row(i: number): string {
  return JSON.stringify({
    ts: `2026-11-07T10:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
    kind: "note",
    payload: { text: `row ${i}` },
    prev: null,
    h: "0".repeat(64),
  });
}

/** A bench whose legacy log holds `ROWS` more rows than the fixture's. */
function bigBench(): MigrationBench {
  const made = makeMigrationBench("osb-streamed-reads-");
  writeFileSync(
    join(made.vault, "Brain", "log", "2026-11-07.dev-a.jsonl"),
    Array.from({ length: ROWS }, (_, i) => row(i)).join("\n") + "\n",
  );
  return made;
}

/** The most records any whole read of a store `log` shard returned while `body` ran. */
function largestLogShardRead(storeRoot: string, body: () => void): number {
  let largest = 0;
  const logShards = join(storeRoot, "shared", "log") + sep;
  const real = reader.readShard;
  const spy = spyOn(reader, "readShard").mockImplementation(((...args: Parameters<typeof real>) => {
    const read = real(...args);
    if (args[0].startsWith(logShards)) largest = Math.max(largest, read.records.length);
    return read;
  }) as typeof real);
  try {
    body();
  } finally {
    spy.mockRestore();
  }
  return largest;
}

test("the migration, a late import and a rollback read the store record by record", () => {
  bench = bigBench();
  const b = bench;
  const largest = largestLogShardRead(b.storeRoot, () => {
    expect(runMigration(b.vault, FAST).ok).toBe(true);
    appendFileSync(join(b.vault, "Brain", "log", "2026-11-07.dev-a.jsonl"), row(ROWS) + "\n");
    const late = migrateStore(b.vault, FAST);
    expect(late.mode === "transition" && late.imported).toBe(1);
    rollback(b.vault);
  });
  expect(largest).toBeLessThan(ROWS);
});

test("the removal of the legacy tree reads the store record by record", () => {
  bench = bigBench();
  const b = bench;
  expect(runMigration(b.vault, FAST).ok).toBe(true);
  const largest = largestLogShardRead(b.storeRoot, () => {
    expect(removeLegacy(b.vault, { force: true }).removed).toBe(true);
  });
  expect(largest).toBeLessThan(ROWS);
});

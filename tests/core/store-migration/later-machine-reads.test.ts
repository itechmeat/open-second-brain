/**
 * The later machine's migration reads the store a fixed number of times,
 * whatever the number of legacy items (change migration-sync-conflict-
 * copies, follow-up 7): its journal, its dual-write pool, its verification
 * and the switch's checks each read every shard once, shard by shard, and
 * nothing is read per item. A per-item read would make the count grow
 * with the items; this test fails on that, never on wall time.
 */
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";

import * as reader from "../../../src/core/store/reader.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

/** Shard reads of B's migration, after A migrated a vault with `rows` extra log rows. */
function laterMachineShardReads(rows: number): { reads: number; imported: number } {
  fleet = makeFleet(["dev-a", "dev-b"]);
  const text =
    Array.from({ length: rows }, (_, i) =>
      JSON.stringify({
        ts: `2026-11-07T10:00:${String(i % 60).padStart(2, "0")}Z`,
        kind: "note",
        payload: { text: `row ${i}` },
        prev: null,
        h: "0".repeat(64),
      }),
    ).join("\n") + "\n";
  const a = fleet.machine("dev-a");
  const b = fleet.machine("dev-b");
  // The same synced legacy tree on both machines.
  a.write("Brain/log/2026-11-07.dev-a.jsonl", text);
  b.write("Brain/log/2026-11-07.dev-a.jsonl", text);
  a.use();
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  fleet.syncStore("dev-a", "dev-b");
  // The vault identity marker the first migration wrote arrives by sync.
  fleet.syncVaultFile("dev-a", "dev-b", "Brain/vault-id.json");
  b.use();
  let reads = 0;
  // A shard is read whole (`readShard`) or record by record (`scanShard`).
  const realRead = reader.readShard;
  const realScan = reader.scanShard;
  const spies = [
    spyOn(reader, "readShard").mockImplementation(((...args: Parameters<typeof realRead>) => {
      reads += 1;
      return realRead(...args);
    }) as typeof realRead),
    spyOn(reader, "scanShard").mockImplementation(((...args: Parameters<typeof realScan>) => {
      reads += 1;
      return realScan(...args);
    }) as typeof realScan),
  ];
  try {
    const result = runMigration(b.vault, FAST);
    expect(result.ok).toBe(true);
    return { reads, imported: result.imported };
  } finally {
    for (const spy of spies) spy.mockRestore();
    fleet.cleanup();
    fleet = null;
  }
}

test("the later machine reads each shard a fixed number of times, not once per item", () => {
  const small = laterMachineShardReads(40);
  const large = laterMachineShardReads(400);
  // Ten times the items, the same shards: the same reads.
  expect(large.reads).toBe(small.reads);
  expect(small.reads).toBeGreaterThan(0);
});

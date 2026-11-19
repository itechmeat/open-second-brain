/**
 * The store's held records are read into one list without spreading a
 * shard into a call: a shard of several hundred thousand records (a real
 * vault's migrated Brain log in one month) must not overflow the call's
 * argument limit.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import { appendRecords } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { heldRecords, heldRecordsByPartition } from "../../../src/core/store-migration/journal.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeTestStore, type TestStore } from "../../helpers/test-store.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let scratch: TestStore | null = null;
afterEach(() => {
  scratch?.cleanup();
  scratch = null;
});

test("a shard above 200,000 records reads whole", () => {
  scratch = makeTestStore("osb-held-large-");
  const store = openStore({ root: scratch.root, device: "dev-a" });
  const n = 210_000;
  const now = Date.UTC(2026, 10, 6);
  for (let start = 0; start < n; start += 30_000) {
    const inputs = Array.from({ length: Math.min(30_000, n - start) }, (_, i) => ({
      partition: "shared" as const,
      stream: "log" as const,
      kind: "note",
      agent: "t",
      body: { n: start + i },
    }));
    appendRecords(store, inputs, { now: () => now });
  }
  expect(heldRecordsByPartition(store).get("shared")!.length).toBe(n);
  expect(heldRecords(store).length).toBe(n);
});

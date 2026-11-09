/**
 * The dual-written copies a migration or transition import matches legacy
 * items against (`dualWritePool`): a record a device wrote while switched
 * to the store is native, so it never stands in for a legacy item with the
 * same content, which would then never be imported.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { contentKey, dualWritePool } from "../../../src/core/store-migration/convert.ts";
import { journalScope } from "../../../src/core/store-migration/journal-scope.ts";
import { makeTestStore, type TestStore } from "../../helpers/test-store.ts";

let scratch: TestStore;
let store: StoreHandle;
let clock: number;
beforeEach(() => {
  scratch = makeTestStore("osb-dual-pool-");
  store = openStore({ root: scratch.root, device: "dev-a" });
  clock = Date.UTC(2026, 10, 8, 9);
});
afterEach(() => scratch.cleanup());

function append(kind: string, body: Record<string, unknown>): StoreRecord {
  clock += 1000;
  const at = clock;
  return appendRecord(
    store,
    { partition: "shared", stream: "settings", kind, agent: "t", body },
    { now: () => at },
  ).record;
}

const PIN = { text: "pinned rule" };
/** A run on dev-a for the vault it migrates first (no backup yet). */
const SCOPE = journalScope({ vault_id: null, path: "/vaults/a" }, null, "dev-a");

describe("dualWritePool", () => {
  test("holds copies written on the legacy layout, not records written while switched", () => {
    const before = append("pinned-context-set", PIN);
    append("device-switched", { authority: "human", device: "dev-a" });
    append("pinned-context-set", PIN);
    const pool = dualWritePool(store, new Map(), SCOPE);
    expect(pool.get(contentKey(before.kind, before.body))?.map((r) => r.id)).toEqual([before.id]);
  });

  test("a device rolled back writes copies again", () => {
    append("device-switched", { authority: "human", device: "dev-a" });
    append("device-unswitched", { authority: "human", device: "dev-a" });
    const after = append("pinned-context-set", PIN);
    const pool = dualWritePool(store, new Map(), SCOPE);
    expect(pool.get(contentKey(after.kind, after.body))?.map((r) => r.id)).toEqual([after.id]);
  });
});

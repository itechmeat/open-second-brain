/**
 * One operation, one partition (phase 1 privacy rule): every record of one
 * `appendStoreRecords` call lands where its most private record would, and
 * a machine without that partition writes none of them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { PartitionUnavailableError } from "../../../src/core/store/appender.ts";
import { appendStoreRecords, type DualWriteRecord } from "../../../src/core/store/dual-write.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeTestStore, type TestStore } from "../../helpers/test-store.ts";

let store: TestStore | null = null;
afterEach(() => {
  store?.cleanup();
  store = null;
});

const open: DualWriteRecord = { stream: "events", kind: "note", private: false, body: { n: 1 } };
const secret: DualWriteRecord = { stream: "events", kind: "note", private: true, body: { n: 2 } };

const kinds = (root: string, partition: "shared" | "private"): number[] =>
  readPartition(join(root, partition)).flatMap((s) => s.all.map((r) => r.body["n"] as number));

describe("appendStoreRecords", () => {
  test("a private record takes its siblings into private", () => {
    store = makeTestStore("osb-batch-partition-");
    appendStoreRecords(openStore({ root: store.root, device: "dev-a" }), [open, secret], {});
    expect(kinds(store.root, "shared")).toEqual([]);
    expect(kinds(store.root, "private").toSorted()).toEqual([1, 2]);
  });

  test("without the private partition nothing of the operation is written", () => {
    store = makeTestStore("osb-batch-partition-", { partitions: ["shared"] });
    expect(() =>
      appendStoreRecords(openStore({ root: store!.root, device: "dev-a" }), [open, secret], {}),
    ).toThrow(PartitionUnavailableError);
    expect(kinds(store.root, "shared")).toEqual([]);
  });
});

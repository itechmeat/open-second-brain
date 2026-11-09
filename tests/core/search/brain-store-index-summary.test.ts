/**
 * `readStoreIndexSummary` (`brain-store/index-summary.ts`): how far the
 * search index has caught up with the brain store, read without writing:
 * records indexed, shards read, and when catch-up last moved a watermark.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readStoreIndexSummary } from "../../../src/core/search/brain-store/index-summary.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

let fx: StoreIndexFixture;
beforeEach(() => {
  fx = makeStoreIndexFixture("osb-store-index-summary-");
});
afterEach(() => fx.cleanup());

describe("readStoreIndexSummary", () => {
  test("no index file: reported as absent, and none is created", () => {
    const path = join(fx.parent, "missing", "brain.sqlite");
    expect(readStoreIndexSummary(path)).toEqual({
      exists: false,
      recordsIndexed: null,
      shardsRead: null,
      lastCatchUpAt: null,
    });
    expect(existsSync(path)).toBe(false);
  });

  test("an index built before any record counts nothing and has no catch-up time", async () => {
    fx.open(LOCAL_DEVICE);
    fx.writeNote("notes/a.md", "# A\n\nA note.\n");
    const config = fx.config();
    await indexVault(config);
    expect(readStoreIndexSummary(config.dbPath)).toEqual({
      exists: true,
      recordsIndexed: 0,
      shardsRead: 0,
      lastCatchUpAt: null,
    });
  });

  test("records ingested from two shards are counted, with the time of the last catch-up", async () => {
    fx.open(LOCAL_DEVICE);
    fx.writeNote("notes/a.md", "# A\n\nA note.\n");
    const config = fx.config();
    await indexVault(config);
    const before = Date.now();
    for (const device of [LOCAL_DEVICE, REMOTE_DEVICE]) {
      appendRecord(fx.open(device), {
        partition: "shared",
        stream: "events",
        kind: "decision",
        agent: "agent",
        body: { text: `decision from ${device}` },
      });
    }
    expect((await catchUpBrainStore(config, { force: true })).added).toBe(2);
    const summary = readStoreIndexSummary(config.dbPath);
    expect(summary.exists).toBe(true);
    expect(summary.recordsIndexed).toBe(2);
    expect(summary.shardsRead).toBe(2);
    expect(summary.lastCatchUpAt).not.toBeNull();
    expect(Date.parse(summary.lastCatchUpAt!)).toBeGreaterThanOrEqual(before);
  });
});

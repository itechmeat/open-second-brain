/**
 * Private-partition lane entries are withheld below local reach: what the
 * reference resolution costs while a `private` shard is unreadable
 * (change `lane-private-partition-reach`, the closure round). A fold that
 * may miss a record is cached nowhere, so each read of it re-reads every
 * shard; one resolution scope reads it once, however many references it
 * judges. Counted, not timed.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { reachView } from "../../src/core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import * as foldCache from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** Whole-fold reads of one remote view judging `count` distinct unresolved references. */
function wholeFoldReads(e: LaneEnv, count: number): { reads: number; visible: number } {
  const original = foldCache.wholeLaneStoreFold;
  let reads = 0;
  const spy = spyOn(foldCache, "wholeLaneStoreFold").mockImplementation((configPath?: string) => {
    reads += 1;
    return original(configPath);
  });
  try {
    const view = reachView(e.vault, TRANSPORT_REACH.remote);
    let visible = 0;
    for (let i = 0; i < count; i += 1) if (view.visible(`zqcost-${count}-${i}`)) visible += 1;
    return { reads, visible };
  } finally {
    spy.mockRestore();
  }
}

describe("private-partition lane entries are withheld below local reach: resolution cost", () => {
  test("one scope reads a degraded whole fold once, however many references it judges", () => {
    lane = makeLaneEnv("store", "osb-lane-cost-");
    const e = lane;
    const path = join(e.vault, "Brain", "decisions", "zqcosthidden.md");
    writeLanePage(e.vault, path, { title: "zqcost" }, `body ${REGION}\n`);
    expect(laneEntryInPrivate(e.vault, path)).toBe(true);
    dropPrivateEvents(e);
    const few = wholeFoldReads(e, 5);
    const many = wholeFoldReads(e, 50);
    // Every unresolved reference is withheld while the fold may miss a record.
    expect({ few: few.visible, many: many.visible }).toEqual({ few: 0, many: 0 });
    expect(many.reads).toBe(few.reads);
    expect(many.reads).toBeLessThanOrEqual(2);
  });
});

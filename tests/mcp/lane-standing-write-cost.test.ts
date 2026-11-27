/**
 * What a store-held lane write costs in lane fold builds (change
 * `tool-lane-write-keeps-standing`, section 4, the read-back): every
 * store-held lane write is read back from a fresh fold after the store
 * write. On a store holding a few hundred lane entries, one write and a
 * batch of twenty writes are counted in whole-fold builds (a fold of every
 * partition read from the shards, not served from the cache) and in lane
 * records folded. Counted, not timed; the bounds are the measured numbers:
 * at most two builds per write, and a batch linear in its size.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { appendRecords } from "../../src/core/store/appender.ts";
import * as laneRecords from "../../src/core/store/lane-records.ts";
import { writeLanePage } from "../../src/core/store/lane-pages.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const SEEDED = 300;

/** A store-only machine whose `decisions` lane holds `SEEDED` shared entries. */
function seeded(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-write-cost-");
  lane = e;
  const inputs = Array.from({ length: SEEDED }, (_, i) => {
    const record = laneRecords.laneEntryRecord({
      lane: "decisions",
      entry: `zqcost-${String(i).padStart(3, "0")}.md`,
      fields: { kind: "note" },
      text: `# zqcost ${i}\n`,
      authority: "agent",
      private: false,
    });
    return {
      partition: "shared" as const,
      stream: record.stream,
      kind: record.kind,
      agent: "tester",
      body: record.body,
    };
  });
  appendRecords(openStore({ root: e.env.storeRoot, device: "dev-a" }), inputs);
  return e;
}

/** Whole-fold builds and lane records folded while `run` writes. */
function counted(run: () => void): { builds: number; folded: number } {
  const original = laneRecords.foldLaneEntries;
  let builds = 0;
  let folded = 0;
  const spy = spyOn(laneRecords, "foldLaneEntries").mockImplementation((input) => {
    const records = [...input];
    if (new Error().stack?.includes("foldOf") === true) {
      builds += 1;
      folded += records.length;
    }
    return original(records);
  });
  try {
    run();
    return { builds, folded };
  } finally {
    spy.mockRestore();
  }
}

function overwrite(e: LaneEnv, i: number, round: number): void {
  const path = join(e.vault, "Brain", "decisions", `zqcost-${String(i).padStart(3, "0")}.md`);
  writeLanePage(e.vault, path, { kind: "note" }, `# zqcost ${i} round ${round}\n`);
}

describe("a store-held lane write: fold builds", () => {
  test("one write and a batch of twenty writes, on a store of a few hundred lane entries", () => {
    const e = seeded();
    // Warm: the first read of the store builds the fold once.
    overwrite(e, 0, 0);
    const one = counted(() => overwrite(e, 1, 1));
    const twenty = counted(() => {
      for (let i = 0; i < 20; i += 1) overwrite(e, 10 + i, 1);
    });
    // Measured (2.0.5): one write builds the fold twice (the builder's read
    // of the store the previous write changed, and the read-back's fresh
    // fold) and folds 603 records; twenty writes build it 40 times and
    // fold 12480 records. Before the read-back: 1 build and 301 records,
    // 20 builds and 6230 records.
    // The counter sees the builder's fold at least (a broken spy reads 0).
    expect(one.builds).toBeGreaterThanOrEqual(1);
    expect(one.builds).toBeLessThanOrEqual(2);
    expect(one.folded).toBeLessThanOrEqual(603);
    expect(twenty.builds).toBeLessThanOrEqual(20 * one.builds);
    expect(twenty.builds).toBeLessThanOrEqual(40);
    expect(twenty.folded).toBeLessThanOrEqual(12480);
  });
});

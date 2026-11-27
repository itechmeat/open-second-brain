/**
 * Judging the references of an answer reads the lane fold once per
 * reference (change `lane-reach-residuals`, package 3, design R15): below
 * local reach on a store-only machine the fold of every partition is read
 * at most once for each distinct bare id or `Brain/` path of a report,
 * and never for a string that cannot name a lane entry.
 *
 * The reads are counted with a spy on the fold cache module's export.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { reachView } from "../../src/core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import * as foldCache from "../../src/core/store/lane-fold-cache.ts";
import { writeLanePage } from "../../src/core/store/lane-pages.ts";
import { LANE_ENTRY_ID_MAX } from "../../src/core/store/lane-records.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const COUNT = 6;
const BARE = Array.from({ length: COUNT }, (_, i) => `zqcostid${i}`);
const PATHS = Array.from({ length: COUNT }, (_, i) => `Brain/decisions/zqcostpath${i}.md`);
const NOT_LANE = [
  "",
  "zqline one\nzqline two",
  "z".repeat(LANE_ENTRY_ID_MAX + 20),
  "Notes/zqoutside.md",
  "Other/zqoutside/deeper.md",
  "zqfirst\nzqsecond\nzqthird",
];

/** The fold reads one call of `fn` makes. */
function reads(spy: { mock: { calls: unknown[] } }, fn: () => void): number {
  const before = spy.mock.calls.length;
  fn();
  return spy.mock.calls.length - before;
}

describe("the references of one report below local reach", () => {
  test("each distinct reference reads the fold at most once, and a string that cannot name a lane entry never", () => {
    const e = makeLaneEnv("store", "osb-lane-ref-cost-");
    lane = e;
    writeLanePage(
      e.vault,
      join(e.vault, "Brain", "decisions", "zqcostheld.md"),
      { kind: "note" },
      `# held\n\n${REGION}\n`,
    );
    const view = reachView(e.vault, TRANSPORT_REACH.remote);
    const spy = spyOn(foldCache, "wholeLaneStoreFold");
    try {
      const bare = reads(spy, () => BARE.forEach((ref) => view.visible(ref)));
      const paths = reads(spy, () => PATHS.forEach((ref) => view.visible(ref)));
      const other = reads(spy, () => NOT_LANE.forEach((ref) => view.visible(ref)));
      process.stdout.write(`fold reads: bare=${bare} paths=${paths} other=${other}\n`);
      expect({
        bareAtMostOnce: bare <= BARE.length,
        pathsAtMostOnce: paths <= PATHS.length,
        other,
      }).toEqual({ bareAtMostOnce: true, pathsAtMostOnce: true, other: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  test("control: the spy sees the fold reads of a reference view", () => {
    const e = makeLaneEnv("store", "osb-lane-ref-cost-");
    lane = e;
    const view = reachView(e.vault, TRANSPORT_REACH.remote);
    const spy = spyOn(foldCache, "wholeLaneStoreFold");
    try {
      expect(reads(spy, () => view.visible("zqcostseen"))).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});

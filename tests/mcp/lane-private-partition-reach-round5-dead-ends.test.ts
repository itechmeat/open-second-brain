/**
 * The trim of dead ends whose archive slot a private entry holds (fifth
 * closure round, finding 12, its trim half).
 *
 * Recording a dead end past the cap moves the oldest readable entries to
 * `archive/`. The trim is maintenance of the lane: below local reach an
 * archive slot held in `private` is not overwritten and does not fail the
 * call after its entry is written; the entry archives to the next free
 * suffix of its id.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { deadEndsDir, recordDeadEnd } from "../../src/core/brain/dead-ends.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import {
  laneEntryInPrivate,
  lanePageExists,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

describe("a dead-end trim whose archive slot a private entry holds", () => {
  test("a remote record archives the overflow beside the private entry and keeps it", () => {
    const e = makeLaneEnv("store", "osb-lane-round5-dead-ends-");
    lanes.push(e);
    const first = recordDeadEnd(e.vault, {
      approach: "Zqtrim first approach",
      reason: "it failed",
      agent: "tester",
      now: new Date("2026-11-01T10:00:00Z"),
    });
    const held = join(deadEndsDir(e.vault), "archive", `${first.entry.id}.md`);
    writeLaneText(
      e.vault,
      held,
      `---\nkind: brain-dead-end\nid: ${first.entry.id}\n---\n\nheld ${REGION}\n`,
    );
    expect(laneEntryInPrivate(e.vault, held)).toBe(true);
    const heldBefore = JSON.stringify(e.laneRecords("private"));
    const result = withPrivateWithheld(true, () =>
      recordDeadEnd(e.vault, {
        approach: "Zqtrim second approach",
        reason: "it failed too",
        agent: "tester",
        now: new Date("2026-11-20T10:00:00Z"),
        maxActive: 1,
      }),
    );
    expect(result.archived).toEqual([first.entry.id]);
    expect(lanePageExists(e.vault, first.entry.path)).toBe(false);
    expect(
      lanePageExists(e.vault, join(deadEndsDir(e.vault), "archive", `${first.entry.id}-2.md`)),
    ).toBe(true);
    expect(JSON.stringify(e.laneRecords("private"))).toBe(heldBefore);
  });
});

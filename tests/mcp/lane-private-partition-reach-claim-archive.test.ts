/**
 * A remote trim of the dead-end overflow keeps an archive slot that a
 * shared archived entry occupies: the entry archives to the next free
 * suffix of its id, and the shared archived page keeps its text.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { deadEndsDir, recordDeadEnd } from "../../src/core/brain/dead-ends.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import {
  laneEntryInPrivate,
  lanePageExists,
  readLaneText,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

describe("a dead-end trim beside an occupied archive slot", () => {
  test("a remote record keeps an occupied shared archive slot", () => {
    const e = makeLaneEnv("store", "osb-lane-claim-archive-");
    lanes.push(e);
    const first = recordDeadEnd(e.vault, {
      approach: "Zqclaim first approach",
      reason: "it failed",
      agent: "tester",
      now: new Date("2026-11-01T10:00:00Z"),
    });
    const archive = join(deadEndsDir(e.vault), "archive");
    writeLaneText(
      e.vault,
      join(archive, `${first.entry.id}.md`),
      `---\nkind: brain-dead-end\nid: ${first.entry.id}\n---\n\nheld ${REGION}\n`,
    );
    const occupied = join(archive, `${first.entry.id}-2.md`);
    const occupiedText = "---\nkind: brain-dead-end\nid: zqshared\n---\n\nshared archived entry\n";
    writeLaneText(e.vault, occupied, occupiedText);
    expect(laneEntryInPrivate(e.vault, occupied)).toBe(false);
    expect(lanePageExists(e.vault, join(archive, `${first.entry.id}-3.md`))).toBe(false);
    const sharedBefore = JSON.stringify(e.laneRecords("shared"));
    const result = withPrivateWithheld(true, () =>
      recordDeadEnd(e.vault, {
        approach: "Zqclaim second approach",
        reason: "it failed too",
        agent: "tester",
        now: new Date("2026-11-20T10:00:00Z"),
        maxActive: 1,
      }),
    );
    expect(result.archived).toEqual([first.entry.id]);
    expect(lanePageExists(e.vault, first.entry.path)).toBe(false);
    expect(readLaneText(e.vault, occupied)).toBe(occupiedText);
    expect(lanePageExists(e.vault, join(archive, `${first.entry.id}-3.md`))).toBe(true);
    expect(JSON.stringify(e.laneRecords("shared"))).not.toBe(sharedBefore);
  });
});

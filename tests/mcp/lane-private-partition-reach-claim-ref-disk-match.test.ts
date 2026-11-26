/**
 * A bare id that names a lane entry held in `private` while a legacy
 * file of the same stem is on disk: the reference view of a caller below
 * local reach hides the id, as the write-side judge holds its row.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readerRefView } from "../../src/core/brain/artifact-ref-view.ts";
import { isPathReadableAtReach } from "../../src/core/search/result-filters.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { logRefsNamePrivatePage } from "../../src/core/store/reference-privacy.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const ID = "zqclaimdisk";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** The reference view of a request below local reach. */
function remoteView(e: LaneEnv) {
  return readerRefView(
    e.vault,
    (rel) => isPathReadableAtReach(e.vault, rel, TRANSPORT_REACH.remote, new Map()),
    true,
  );
}

/** A lane entry `ID` held in `private`, beside a legacy file of the same stem. */
function seed(e: LaneEnv, laneRel: string, diskRel: string): void {
  writeLanePage(e.vault, join(e.vault, laneRel), { kind: "note" }, `# held\n\n${REGION}\n`);
  expect(laneEntryInPrivate(e.vault, join(e.vault, laneRel))).toBe(true);
  mkdirSync(join(e.vault, diskRel, ".."), { recursive: true });
  writeFileSync(join(e.vault, diskRel), "---\nkind: note\n---\n\n# legacy\n");
}

describe("a bare id of a private lane entry beside a legacy file of the same stem", () => {
  test("a remote reference view hides the id the write-side judge holds", () => {
    const e = makeLaneEnv("store", "osb-lane-claim-ref-disk-match-");
    lane = e;
    seed(e, `Brain/decisions/${ID}.md`, `Brain/sources/${ID}.md`);
    const judged = logRefsNamePrivatePage(e.vault, [ID]);
    const visible = remoteView(e).visible(ID);
    expect({ judged, visible }).toEqual({ judged: true, visible: false });
  });
});

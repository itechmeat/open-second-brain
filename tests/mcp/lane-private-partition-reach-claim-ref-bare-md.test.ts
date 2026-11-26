/**
 * A bare reference ending in `.md` that names a lane entry held in
 * `private` by its id: the reference view of a caller below local reach
 * hides it, as the write-side judge holds its row.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readerRefView } from "../../src/core/brain/artifact-ref-view.ts";
import { isPathReadableAtReach } from "../../src/core/search/result-filters.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import {
  laneEntryInPrivate,
  lanePageExists,
  writeLanePage,
} from "../../src/core/store/lane-pages.ts";
import { logRefsNamePrivatePage } from "../../src/core/store/reference-privacy.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const ID = "zqclaimmd.md";

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

describe("a bare reference ending in .md that names a private lane entry by id", () => {
  test("a remote reference view hides the id the write-side judge holds", () => {
    const e = makeLaneEnv("store", "osb-lane-claim-ref-bare-md-");
    lane = e;
    writeLanePage(
      e.vault,
      join(e.vault, "Brain", "procedures", `${ID}.md`),
      { kind: "note" },
      `# held\n\n${REGION}\n`,
    );
    expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", "procedures", `${ID}.md`))).toBe(
      true,
    );
    expect(lanePageExists(e.vault, join(e.vault, ID))).toBe(false);
    const judged = logRefsNamePrivatePage(e.vault, [ID]);
    const visible = remoteView(e).visible(ID);
    expect({ judged, visible }).toEqual({ judged: true, visible: false });
  });
});

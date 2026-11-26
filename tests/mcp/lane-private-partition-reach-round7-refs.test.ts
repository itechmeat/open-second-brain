/**
 * A bare id that names a lane entry held in `private` while a legacy
 * file of the same stem is on disk: every reference view that withholds
 * private entries hides the id, whatever path binds it - the reach view
 * of the MCP tools as well as the per-reader view - and fails closed
 * while the fold of every partition may miss a record. A local caller
 * sees the id as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readerRefView } from "../../src/core/brain/artifact-ref-view.ts";
import { reachView } from "../../src/core/brain/reach-view.ts";
import { isPathReadableAtReach } from "../../src/core/search/result-filters.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";

const ID = "zqround7refs";
const OPEN = "Brain/notes/zqround7open.md";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** A lane entry `ID` held in `private`, beside a legacy file of the same stem. */
function seed(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-round7-refs-");
  lane = e;
  const laneRel = `Brain/decisions/${ID}.md`;
  const diskRel = `Brain/sources/${ID}.md`;
  writeLanePage(e.vault, join(e.vault, laneRel), { kind: "note" }, `# held\n\n${REGION}\n`);
  expect(laneEntryInPrivate(e.vault, join(e.vault, laneRel))).toBe(true);
  mkdirSync(join(e.vault, diskRel, ".."), { recursive: true });
  writeFileSync(join(e.vault, diskRel), "---\nkind: note\n---\n\n# legacy\n");
  mkdirSync(join(e.vault, "Brain/notes"), { recursive: true });
  writeFileSync(join(e.vault, OPEN), "---\nkind: note\n---\n\n# open\n");
  return e;
}

/** The reference view of a request below local reach, bound to `reach`. */
function remoteReader(e: LaneEnv) {
  return readerRefView(
    e.vault,
    (rel) => isPathReadableAtReach(e.vault, rel, TRANSPORT_REACH.remote, new Map()),
    true,
  );
}

describe("a bare id of a private lane entry beside a legacy file of the same stem", () => {
  test("the reach view of a remote caller hides the id and its rows", () => {
    const e = seed();
    const view = reachView(e.vault, TRANSPORT_REACH.remote);
    expect(view.withholdsPrivate).toBe(true);
    expect({
      visible: view.visible(ID),
      row: view.row(OPEN, ID),
      kept: view.keep([{ ref: ID }, { ref: OPEN }], (r) => [r.ref]).length,
    }).toEqual({ visible: false, row: false, kept: 1 });
  });

  test("the reach view hides the id while the fold may miss a record", () => {
    const e = seed();
    dropPrivateEvents(e);
    expect(reachView(e.vault, TRANSPORT_REACH.remote).visible(ID)).toBe(false);
    expect(remoteReader(e).visible(ID)).toBe(false);
  });

  test("the per-reader view of a remote caller hides the id", () => {
    const e = seed();
    expect(remoteReader(e).visible(ID)).toBe(false);
  });

  test("a local caller sees the id as before", () => {
    const e = seed();
    const local = reachView(e.vault, TRANSPORT_REACH.local);
    const reader = readerRefView(
      e.vault,
      (rel) => isPathReadableAtReach(e.vault, rel, TRANSPORT_REACH.local, new Map()),
      false,
    );
    expect({
      reach: local.visible(ID),
      reader: reader.visible(ID),
    }).toEqual({ reach: true, reader: true });
  });
});

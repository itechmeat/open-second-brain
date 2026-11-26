/**
 * The counts of a `brain_procedural_memory` reconcile below local reach
 * after a private procedure was removed (eighth closure round, finding 1).
 *
 * Each test seeds one procedure page in `private` and one in `shared`
 * on a machine whose lane pages live in the store, with the file the
 * private page had before the switch still on disk (the store never
 * changes `Brain/`), indexes both through a local reconcile, then removes
 * the private page locally: the winning record of its key is a removal
 * held in `private`. A remote reconcile still rebuilds the index on the
 * whole fold, but its `removed` count must not name the private
 * procedure's removal (the file on disk must not answer for it); a local
 * reconcile afterwards finds nothing left to remove. The same removal
 * followed by a local reconcile on a twin store is the control: a local
 * caller counts it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { listProceduralMemory, proceduralEntryId } from "../../src/core/brain/procedural-memory.ts";
import { reachView } from "../../src/core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { withPrivateShown } from "../../src/core/store/caller-reach.ts";
import {
  laneEntryInPrivate,
  removeLanePage,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { lanePlaceOf } from "../../src/core/store/lane-paths.ts";
import { winnerHeldInPrivate } from "../../src/core/store/lane-reach-guard.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const HELD = "Brain/procedures/zqround8-held.md";
const SHARED = "Brain/procedures/zqround8-shared.md";
const HELD_ID = proceduralEntryId(HELD);
const SHARED_ID = proceduralEntryId(SHARED);

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** A procedure page's text. */
function procedure(title: string, held: boolean): string {
  return [
    "---",
    "kind: brain-procedure",
    "tags: [docs]",
    "triggers: [release]",
    `title: ${title}`,
    "---",
    `# ${title}`,
    "",
    `zqround8 step ${held ? REGION : "shared"}`,
    "",
  ].join("\n");
}

/** The ids of the machine's index, as a local reader sees it. */
function indexedIds(e: LaneEnv): string[] {
  return withPrivateShown(() => listProceduralMemory(e.vault, e.env.configPath))
    .map((entry) => entry.id)
    .toSorted();
}

/**
 * Both procedures indexed through a local reconcile, the private page's
 * pre-switch file left on disk, then the private page removed locally.
 */
async function seeded(prefix: string): Promise<LaneEnv> {
  const e = makeLaneEnv("store", `osb-lane-round8-procedural-${prefix}-`);
  lanes.push(e);
  const heldText = procedure("Zqround8 held procedure", true);
  writeLaneText(e.vault, join(e.vault, HELD), heldText);
  mkdirSync(dirname(join(e.vault, HELD)), { recursive: true });
  writeFileSync(join(e.vault, HELD), heldText);
  writeLaneText(e.vault, join(e.vault, SHARED), procedure("Zqround8 shared procedure", false));
  expect(laneEntryInPrivate(e.vault, join(e.vault, HELD), e.env.configPath)).toBe(true);
  expect(laneEntryInPrivate(e.vault, join(e.vault, SHARED), e.env.configPath)).toBe(false);
  const reconciled = await callJson(localServer(e), "brain_procedural_memory", {
    operation: "reconcile",
  });
  expect(reconciled["error"]).toBeUndefined();
  expect(indexedIds(e)).toEqual([HELD_ID, SHARED_ID].toSorted());
  expect(removeLanePage(e.vault, join(e.vault, HELD))).toBe(true);
  const place = lanePlaceOf(HELD.slice("Brain/".length));
  expect(place).not.toBeNull();
  expect(winnerHeldInPrivate(place!.lane, place!.entry, e.env.configPath)).toBe(true);
  return e;
}

describe("a remote reconcile after a private procedure was removed", () => {
  test("the removed count leaves out the private procedure, the index is reconciled whole", async () => {
    const e = await seeded("remote");

    const remote = await callJson(server(e), "brain_procedural_memory", {
      operation: "reconcile",
    });

    expect(remote["error"] ?? null).toBeNull();
    expect({
      total: remote["total"],
      added: remote["added"],
      updated: remote["updated"],
      removed: remote["removed"],
      names_held: JSON.stringify(remote).includes(HELD_ID),
    }).toEqual({ total: 1, added: 0, updated: 0, removed: 0, names_held: false });
    // The machine's index was reconciled on the whole fold: the removed
    // private procedure is gone from it for a local reader too.
    expect(indexedIds(e)).toEqual([SHARED_ID]);
    const after = await callJson(localServer(e), "brain_procedural_memory", {
      operation: "reconcile",
    });
    expect(after["error"] ?? null).toBeNull();
    expect({ total: after["total"], removed: after["removed"] }).toEqual({
      total: 1,
      removed: 0,
    });
  });

  test("a local reconcile counts the removal of the private procedure", async () => {
    const e = await seeded("local");

    const local = await callJson(localServer(e), "brain_procedural_memory", {
      operation: "reconcile",
    });

    expect(local["error"] ?? null).toBeNull();
    expect({
      total: local["total"],
      added: local["added"],
      updated: local["updated"],
      removed: local["removed"],
    }).toEqual({ total: 1, added: 0, updated: 0, removed: 1 });
    expect(indexedIds(e)).toEqual([SHARED_ID]);
  });

  test("the reference view of a remote caller agrees: the removed private path is hidden", async () => {
    const e = await seeded("view");

    const remote = reachView(e.vault, TRANSPORT_REACH.remote);
    const local = reachView(e.vault, TRANSPORT_REACH.local);

    expect({
      held_remote: remote.visible(HELD),
      shared_remote: remote.visible(SHARED),
      held_local: local.visible(HELD),
    }).toEqual({ held_remote: false, shared_remote: true, held_local: true });
  });
});

/**
 * A write decides reach and privacy from the fold it writes from (change
 * `lane-reach-residuals`, package 5, design R5, sequence B2): an entry
 * raised to `private` after a write's first check and before its records
 * are built refuses a remote overwrite, a remote move and a remote folder
 * operation with the fixed answer, and a local move writes the moved
 * entry and its tombstone in `private`.
 *
 * The raise is injected by a test double of the fold cache: the first
 * fold read that a store write's record builder makes appends the raised
 * record first (`raiseWithoutTombstone`), so the builder reads a fold the
 * first check did not.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import * as foldCache from "../../src/core/store/lane-fold-cache.ts";
import {
  laneEntryInPrivate,
  lanePageExists,
  moveLanePage,
  moveLaneTree,
  readLaneText,
  removeLaneTree,
  writeLanePage,
} from "../../src/core/store/lane-pages.ts";
import { LANE_ENTRY_REMOVE_KIND } from "../../src/core/store/lane-records.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  raiseWithoutTombstone,
  sharedLaneRecord,
} from "./lane-private-partition-reach-store-fixture.ts";

let lane: LaneEnv | null = null;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-builder-race-");
  return lane;
}

const WITHHELD = "this entry cannot be written at this reach";
/** The raised text: private by its partition alone, with no region and no visibility field. */
const RAISED = "# held\n\nzqraceprivate text\n";

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** `<name>: <message>` of what `fn` throws, or `none`. */
function thrown(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** A shared lane entry at the vault-relative `rel`. */
function sharedEntry(e: LaneEnv, rel: string): void {
  writeLanePage(e.vault, join(e.vault, rel), { kind: "note" }, "# shared\n\nOpen text.\n");
  expect(laneEntryInPrivate(e.vault, join(e.vault, rel))).toBe(false);
}

/**
 * Install the race: the first fold read made inside a store write raises
 * the entry `lane`/`name` to `private` first. Returns the state of the
 * race: whether it fired, and the raw records right after the raise.
 */
function raceOn(
  e: LaneEnv,
  laneName: string,
  name: string,
): { fired: boolean; afterRaise: string } {
  const body = sharedLaneRecord(e, laneName, name);
  const state = { fired: false, afterRaise: "" };
  const original = foldCache.wholeLaneStoreFold;
  const spy = spyOn(foldCache, "wholeLaneStoreFold").mockImplementation((...args) => {
    if (!state.fired && (new Error().stack ?? "").includes("storeWrite")) {
      state.fired = true;
      raiseWithoutTombstone(e, body, RAISED);
      state.afterRaise = rawRecords(e);
    }
    return original(...args);
  });
  restore = () => spy.mockRestore();
  return state;
}

describe("an entry raised to private between the first check and the record builder", () => {
  test("a remote overwrite is refused and the private text is unchanged", () => {
    const e = env();
    const rel = "Brain/decisions/zqraceoverwrite.md";
    sharedEntry(e, rel);
    const race = raceOn(e, "decisions", "zqraceoverwrite");
    const outcome = thrown(() =>
      withPrivateWithheld(true, () =>
        writeLanePage(e.vault, join(e.vault, rel), { kind: "note" }, "# remote\n\nRemote text.\n", {
          overwrite: true,
        }),
      ),
    );
    restore?.();
    restore = null;
    expect(race.fired).toBe(true);
    expect({
      outcome,
      text: readLaneText(e.vault, join(e.vault, rel))?.includes("zqraceprivate"),
    }).toEqual({ outcome: `LaneEntryWithheldError: ${WITHHELD}`, text: true });
  });

  test("a local move of a source raised meanwhile writes the moved entry and its tombstone in private", () => {
    const e = env();
    const from = "Brain/decisions/zqracemovelocal.md";
    const to = "Brain/decisions/zqracemovelocal-moved.md";
    sharedEntry(e, from);
    const race = raceOn(e, "decisions", "zqracemovelocal");
    const outcome = thrown(() => moveLanePage(e.vault, join(e.vault, from), join(e.vault, to)));
    restore?.();
    restore = null;
    expect(race.fired).toBe(true);
    const sharedText = e
      .laneRecords("shared")
      .some((r) => JSON.stringify(r.body).includes("zqraceprivate"));
    const privateTombstone = e
      .laneRecords("private")
      .some(
        (r) =>
          r.kind === LANE_ENTRY_REMOVE_KIND && String(r.body["entry"]).includes("zqracemovelocal"),
      );
    expect({
      outcome,
      movedPrivate: laneEntryInPrivate(e.vault, join(e.vault, to)),
      privateTombstone,
      sharedText,
    }).toEqual({ outcome: "none", movedPrivate: true, privateTombstone: true, sharedText: false });
  });

  test("a remote move of a source raised meanwhile is refused and writes nothing", () => {
    const e = env();
    const from = "Brain/decisions/zqracemoveremote.md";
    const to = "Brain/decisions/zqracemoveremote-moved.md";
    sharedEntry(e, from);
    const race = raceOn(e, "decisions", "zqracemoveremote");
    const outcome = thrown(() =>
      withPrivateWithheld(true, () =>
        moveLanePage(e.vault, join(e.vault, from), join(e.vault, to)),
      ),
    );
    restore?.();
    restore = null;
    expect(race.fired).toBe(true);
    expect({ outcome, unchanged: rawRecords(e) === race.afterRaise }).toEqual({
      outcome: `LaneEntryWithheldError: ${WITHHELD}`,
      unchanged: true,
    });
  });

  for (const verb of ["move", "remove"] as const) {
    test(`a remote folder ${verb} with a member raised meanwhile is refused whole`, () => {
      const e = env();
      const dir = `Brain/decisions/zqracetree${verb}`;
      const members = ["zqracemember1", "zqracemember2"].map((m) => `${dir}/${m}-${verb}.md`);
      for (const member of members) sharedEntry(e, member);
      const race = raceOn(e, "decisions", `zqracemember1-${verb}`);
      const outcome = thrown(() =>
        withPrivateWithheld(true, () =>
          verb === "move"
            ? moveLaneTree(e.vault, join(e.vault, dir), join(e.vault, `${dir}-moved`))
            : removeLaneTree(e.vault, join(e.vault, dir)),
        ),
      );
      restore?.();
      restore = null;
      expect(race.fired).toBe(true);
      expect({
        outcome,
        unchanged: rawRecords(e) === race.afterRaise,
        secondMemberKept: lanePageExists(e.vault, join(e.vault, members[1]!)),
      }).toEqual({
        outcome: `LaneEntryWithheldError: ${WITHHELD}`,
        unchanged: true,
        secondMemberKept: true,
      });
    });
  }

  test("local control: a local overwrite with no raise replaces the shared entry", () => {
    const e = env();
    const rel = "Brain/decisions/zqraceoverwritelocal.md";
    sharedEntry(e, rel);
    writeLanePage(e.vault, join(e.vault, rel), { kind: "note" }, "# local\n\nLocal text.\n", {
      overwrite: true,
    });
    expect(readLaneText(e.vault, join(e.vault, rel))).toContain("Local text.");
  });
});

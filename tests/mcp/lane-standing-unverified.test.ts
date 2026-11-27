/**
 * A read-back that could not be made is not "not applied", and the writers
 * that add to a list on each call are idempotent on a repeat (change
 * `tool-lane-write-keeps-standing`, the review of its second batch,
 * findings 1 and 2).
 *
 * `LaneWriteNotAppliedError` is raised only when a fold read in full shows
 * another winner for the key. A read-back whose fold read fails, or whose
 * fold may miss a record (a store that could not be opened for that one
 * read), raises `LaneWriteUnverifiedError`: the record landed, and the
 * message says to read the entry before repeating the call. The failure is
 * injected with the fold double of `lane-standing-reach.test.ts`: the
 * fresh fold read made by the read-back (`assertWriteApplied`). A repeated
 * obligation completion for the date it already holds, and an intention
 * set to the text it already has, write nothing and answer as already
 * recorded.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import {
  addObligation,
  completeObligation,
  showObligation,
} from "../../src/core/brain/obligations.ts";
import { setIntention, showIntention } from "../../src/core/brain/intentions.ts";
import * as foldCache from "../../src/core/store/lane-fold-cache.ts";
import { readLaneText, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { AGENT, callJson, localServer } from "./lane-private-partition-reach-writes-fixture.ts";

const lanes: LaneEnv[] = [];
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-standing-unverified-");
  lanes.push(e);
  return e;
}

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

/**
 * The fold double: the fresh fold read the read-back makes answers
 * `replace(original)` instead, once.
 */
function onReadBack(replace: (original: () => foldCache.LaneFolded) => foldCache.LaneFolded): {
  fired: boolean;
} {
  const state = { fired: false };
  const original = foldCache.freshLaneStoreFold;
  const spy = spyOn(foldCache, "freshLaneStoreFold").mockImplementation((...args) => {
    if (!state.fired && (new Error().stack ?? "").includes("assertWriteApplied")) {
      state.fired = true;
      return replace(() => original(...args));
    }
    return original(...args);
  });
  restore = () => spy.mockRestore();
  return state;
}

const REL = "Brain/decisions/zqunverified.md";
const UNVERIFIED =
  "LaneWriteUnverifiedError: decisions/zqunverified.md was written and could not be verified: " +
  "read the entry before repeating the call";

describe("a read-back that could not be made", () => {
  test("a fold read that fails after the append is reported as unverified, and the write landed", () => {
    const e = env();
    writeLanePage(e.vault, join(e.vault, REL), { kind: "note" }, "# first\n\nFirst text.\n");
    const race = onReadBack(() => {
      throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    });
    const outcome = thrown(() =>
      writeLanePage(e.vault, join(e.vault, REL), { kind: "note" }, "# second\n\nSecond text.\n", {
        overwrite: true,
      }),
    );
    restore?.();
    restore = null;
    expect({ fired: race.fired, outcome }).toEqual({ fired: true, outcome: UNVERIFIED });
    expect(readLaneText(e.vault, join(e.vault, REL))).toContain("Second text.");
  });

  test("a store that cannot be opened for the read-back is reported as unverified, not as not applied", () => {
    const e = env();
    writeLanePage(e.vault, join(e.vault, REL), { kind: "note" }, "# first\n\nFirst text.\n");
    const race = onReadBack((original) => ({
      ...original(),
      entries: new Map(),
      authorities: new Map(),
      unreadable: ["the store cannot be opened"],
    }));
    const outcome = thrown(() =>
      writeLanePage(e.vault, join(e.vault, REL), { kind: "note" }, "# second\n\nSecond text.\n", {
        overwrite: true,
      }),
    );
    restore?.();
    restore = null;
    expect({ fired: race.fired, outcome }).toEqual({ fired: true, outcome: UNVERIFIED });
    expect(readLaneText(e.vault, join(e.vault, REL))).toContain("Second text.");
  });
});

describe("a repeated call that adds to a list writes nothing", () => {
  test("a completion for the date the obligation already holds last answers as already recorded", async () => {
    const e = env();
    const added = addObligation(e.vault, {
      title: "Zqunverified weekly review",
      cadence: "weekly",
      agent: AGENT,
      anchor: "2026-06-01",
    });
    completeObligation(e.vault, { slug: added.slug, date: "2026-06-22" });
    const before = rawRecords(e);

    const repeat = await callJson(localServer(e), "brain_obligation", {
      operation: "done",
      slug: added.slug,
      date: "2026-06-22",
    });

    expect({
      already: repeat["already_recorded"],
      completions: showObligation(e.vault, added.slug)?.completions,
    }).toEqual({ already: true, completions: ["2026-06-22"] });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a completion for another date is recorded as before", () => {
    const e = env();
    const added = addObligation(e.vault, {
      title: "Zqunverified weekly check",
      cadence: "weekly",
      agent: AGENT,
      anchor: "2026-06-01",
    });
    completeObligation(e.vault, { slug: added.slug, date: "2026-06-22" });
    completeObligation(e.vault, { slug: added.slug, date: "2026-06-29" });
    expect(showObligation(e.vault, added.slug)?.completions).toEqual(["2026-06-29", "2026-06-22"]);
  });

  test("an intention set to the text it already has answers as already recorded", async () => {
    const e = env();
    setIntention(e.vault, { scope: "zqunverified", text: "Ship the report", agent: AGENT });
    const before = rawRecords(e);

    const repeat = await callJson(localServer(e), "brain_intention", {
      operation: "set",
      scope: "zqunverified",
      text: "Ship the report",
    });

    expect({
      already: repeat["already_recorded"],
      version: showIntention(e.vault, "zqunverified")?.version,
      history: showIntention(e.vault, "zqunverified")?.history,
    }).toEqual({ already: true, version: 1, history: [] });
    expect(rawRecords(e)).toEqual(before);
  });

  test("an intention set to new text adds a version as before", () => {
    const e = env();
    setIntention(e.vault, { scope: "zqunverified", text: "Ship the report", agent: AGENT });
    const next = setIntention(e.vault, {
      scope: "zqunverified",
      text: "Ship the slides",
      agent: AGENT,
    });
    expect({ version: next.version, history: next.history.length }).toEqual({
      version: 2,
      history: 1,
    });
  });
});

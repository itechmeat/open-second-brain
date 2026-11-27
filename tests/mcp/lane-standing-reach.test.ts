/**
 * Reach before the base (change `tool-lane-write-keeps-standing`, design
 * D7, spec "A tool's lane write below local reach that meets a private
 * holder gets the fixed answer").
 *
 * Below local reach a holder in `private` is never named: the reach guard
 * runs first, then the base check, and both judge the fold they read. A
 * completion whose entry the caller's view does not hold answers as for an
 * absent one (the 2.0.4 rule); a write that reaches the reach guard over a
 * private holder gets the fixed answer, and so does a base check that meets
 * an entry raised to `private` after the guard. Each case has a local
 * control: at local reach the same state answers as it always did.
 *
 * A raise between two reads is injected by a test double of the fold
 * cache, as `lane-reach-residuals-builder-race.test.ts` does: the first
 * fold read made from a named step appends the raised record first.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { ORIGIN_CHANNEL, setOriginChannel } from "../../src/core/origin-channel.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { HLC_MAX_DRIFT_MS } from "../../src/core/store/hlc.ts";
import * as foldCache from "../../src/core/store/lane-fold-cache.ts";
import {
  laneEntryInPrivate,
  readLaneText,
  writeLanePage,
} from "../../src/core/store/lane-pages.ts";
import { lanePlaceOf } from "../../src/core/store/lane-paths.ts";
import { LANE_ENTRY_KIND, laneEntryKey } from "../../src/core/store/lane-records.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  dropPrivateEvents,
  raiseWithoutTombstone,
  sharedLaneRecord,
} from "./lane-private-partition-reach-store-fixture.ts";
import {
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-standing-reach-");
  return lane;
}

const WITHHELD = "this entry cannot be written at this reach";
/** The raised text: private by its partition alone. */
const RAISED = "# held\n\nzqstandingraised text\n";
const DONE = "2026-06-22";

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** The page path of the obligation `slug`. */
function obligationPath(e: LaneEnv, slug: string): string {
  return join(e.vault, "Brain", "obligations", `${slug}.md`);
}

/**
 * An obligation titled `title` added by an operator's command (authority
 * `human`); `hidden` puts a `<private>` region in its notes, so its record
 * is held in `private`. Returns its slug.
 */
async function humanObligation(e: LaneEnv, title: string, hidden: boolean): Promise<string> {
  setOriginChannel(ORIGIN_CHANNEL.cli);
  const added = await callJson(localServer(e), "brain_obligation", {
    operation: "add",
    title,
    cadence: "weekly",
    anchor: DONE,
    ...(hidden ? { notes: `zqstanding notes ${REGION}` } : {}),
  });
  setOriginChannel(ORIGIN_CHANNEL.mcpTool);
  const slug = String((added["obligation"] as Record<string, unknown>)["slug"]);
  expect(laneEntryInPrivate(e.vault, obligationPath(e, slug))).toBe(hidden);
  return slug;
}

/** The answer of `answer` with every occurrence of `slug` replaced, for comparison. */
function shapeOf(answer: Record<string, unknown>, slug: string): string {
  return JSON.stringify(answer).split(slug).join("<slug>");
}

/**
 * Install the race: the first fold read made from the step `step` (a name
 * on the stack) raises the obligation `slug` to `private` first.
 */
function raceOn(e: LaneEnv, slug: string, step: string): { fired: boolean } {
  const body = sharedLaneRecord(e, "obligations", slug);
  const state = { fired: false };
  const original = foldCache.wholeLaneStoreFold;
  const spy = spyOn(foldCache, "wholeLaneStoreFold").mockImplementation((...args) => {
    if (!state.fired && (new Error().stack ?? "").includes(step)) {
      state.fired = true;
      raiseWithoutTombstone(e, body, RAISED);
    }
    return original(...args);
  });
  restore = () => spy.mockRestore();
  return state;
}

/** Whether the store holds a `human` removal of the obligation `slug` in `private`. */
function humanPrivateRemoval(e: LaneEnv, slug: string): boolean {
  const place = lanePlaceOf(`obligations/${slug}.md`)!;
  const key = laneEntryKey(place.lane, place.entry);
  return foldCache.wholeLaneStoreFold().privateRemovals.has(key);
}

describe("a tool's lane write below local reach that meets a private holder", () => {
  test("(o1) completing an obligation whose winning version is human and private answers as for an absent one", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding private duty", true);
    const before = rawRecords(e);
    const remote = server(e);
    const hidden = await callJson(remote, "brain_obligation", {
      operation: "done",
      slug,
      date: DONE,
    });
    const absent = await callJson(remote, "brain_obligation", {
      operation: "done",
      slug: `${slug}-zq`,
      date: DONE,
    });
    expect({
      likeAbsent: shapeOf(hidden, slug) === shapeOf(absent, `${slug}-zq`),
      named: JSON.stringify(hidden).includes("zqstanding notes"),
      unchanged: rawRecords(e) === before,
    }).toEqual({ likeAbsent: true, named: false, unchanged: true });
  });

  test("(o1) local control: a local completion of that obligation is kept", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding private duty", true);
    const done = await callJson(localServer(e), "brain_obligation", {
      operation: "done",
      slug,
      date: DONE,
    });
    expect((done["obligation"] as Record<string, unknown>)["last_done"]).toBe(DONE);
    const shown = await callJson(localServer(e), "brain_obligation", { operation: "show", slug });
    expect((shown["obligation"] as Record<string, unknown>)["last_done"]).toBe(DONE);
  });

  test("(o2) an add over a human removal held in private gets the fixed answer", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding removed duty", true);
    setOriginChannel(ORIGIN_CHANNEL.cli);
    await callJson(localServer(e), "brain_obligation", { operation: "remove", slug });
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    expect(humanPrivateRemoval(e, slug)).toBe(true);
    const before = rawRecords(e);
    const answer = await callJson(server(e), "brain_obligation", {
      operation: "add",
      title: "Zqstanding removed duty",
      cadence: "weekly",
    });
    const text = JSON.stringify(answer);
    expect({
      fixed: text.includes(WITHHELD),
      names: ["removal", "human", slug].filter((mark) => text.includes(mark)),
      unchanged: rawRecords(e) === before,
    }).toEqual({ fixed: true, names: [], unchanged: true });
  });

  test("(o2) local control: a local add over that removal lands", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding removed duty", true);
    setOriginChannel(ORIGIN_CHANNEL.cli);
    await callJson(localServer(e), "brain_obligation", { operation: "remove", slug });
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const answer = await callJson(localServer(e), "brain_obligation", {
      operation: "add",
      title: "Zqstanding removed duty",
      cadence: "weekly",
    });
    expect(answer["error"]).toBeUndefined();
    const shown = await callJson(localServer(e), "brain_obligation", { operation: "show", slug });
    expect(shown["present"]).toBe(true);
  });

  test("(o3) an entry raised to private after the reach guard and before the base check gets the fixed answer", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding raised duty", false);
    const race = raceOn(e, slug, "checkLaneBase");
    const answer = await callJson(server(e), "brain_obligation", {
      operation: "done",
      slug,
      date: DONE,
    });
    restore?.();
    restore = null;
    const text = JSON.stringify(answer);
    expect({
      fired: race.fired,
      fixed: text.includes(WITHHELD),
      changed: text.includes("changed since it was read"),
    }).toEqual({ fired: true, fixed: true, changed: false });
  });

  test("(o3) local control: the same raise at local reach is refused as changed", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding raised duty", false);
    const race = raceOn(e, slug, "checkLaneBase");
    const answer = await callJson(localServer(e), "brain_obligation", {
      operation: "done",
      slug,
      date: DONE,
    });
    restore?.();
    restore = null;
    expect({
      fired: race.fired,
      changed: JSON.stringify(answer).includes("changed since it was read"),
    }).toEqual({ fired: true, changed: true });
  });

  test("(o3b) an entry raised to private before the write's reach guard gets the fixed answer", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding raised early duty", false);
    const race = raceOn(e, slug, "assertLaneWriteAtReach");
    const answer = await callJson(server(e), "brain_obligation", {
      operation: "done",
      slug,
      date: DONE,
    });
    restore?.();
    restore = null;
    const text = JSON.stringify(answer);
    expect({
      fired: race.fired,
      fixed: text.includes(WITHHELD),
      changed: text.includes("changed since it was read"),
    }).toEqual({ fired: true, fixed: true, changed: false });
  });

  test("(o4) a remote completion while the fold may miss a record answers as for an absent one", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding gap duty", false);
    // A private record, so the private partition has an events shard to lose.
    await humanObligation(e, "Zqstanding hidden duty", true);
    dropPrivateEvents(e);
    const before = rawRecords(e);
    const remote = server(e);
    const done = await callJson(remote, "brain_obligation", {
      operation: "done",
      slug,
      date: DONE,
    });
    const absent = await callJson(remote, "brain_obligation", {
      operation: "done",
      slug: `${slug}-zq`,
      date: DONE,
    });
    const text = JSON.stringify(done);
    expect({
      likeAbsent: shapeOf(done, slug) === shapeOf(absent, `${slug}-zq`),
      gap: ["doctor", "could not be read"].filter((mark) => text.includes(mark)),
      unchanged: rawRecords(e) === before,
    }).toEqual({ likeAbsent: true, gap: [], unchanged: true });
  });

  test("(o4) local control: a local completion while the fold may miss a record names the gap", async () => {
    const e = env();
    const slug = await humanObligation(e, "Zqstanding gap duty", false);
    // A private record, so the private partition has an events shard to lose.
    await humanObligation(e, "Zqstanding hidden duty", true);
    dropPrivateEvents(e);
    const before = rawRecords(e);
    const done = await callJson(localServer(e), "brain_obligation", {
      operation: "done",
      slug,
      date: DONE,
    });
    expect({
      doctor: JSON.stringify(done).includes("o2b brain doctor"),
      unchanged: rawRecords(e) === before,
    }).toEqual({ doctor: true, unchanged: true });
  });
});

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
 * Install the race of the read-back: the first fresh fold read
 * (`freshLaneStoreFold`) made by the read-back of a write
 * (`assertWriteApplied`, after the store write returned) appends a `human` version of `rel` held in `private` and
 * stamped further ahead than the clock accepts.
 */
function aheadOnReadBack(e: LaneEnv, rel: string): { fired: boolean } {
  const place = lanePlaceOf(rel.replace(/^Brain\//u, ""))!;
  const state = { fired: false };
  const original = foldCache.freshLaneStoreFold;
  const spy = spyOn(foldCache, "freshLaneStoreFold").mockImplementation((...args) => {
    if (!state.fired && (new Error().stack ?? "").includes("assertWriteApplied")) {
      state.fired = true;
      appendRecord(
        openStore({ root: e.env.storeRoot, device: "dev-b" }),
        {
          partition: "private",
          stream: "events",
          kind: LANE_ENTRY_KIND,
          agent: "o2b",
          body: {
            authority: "human",
            lane: place.lane,
            entry: place.entry,
            fields: { kind: "note" },
            text: "zqstandingahead private text\n",
          },
        },
        { now: () => Date.now() + HLC_MAX_DRIFT_MS + 60 * 60 * 1000 },
      );
    }
    return original(...args);
  });
  restore = () => spy.mockRestore();
  return state;
}

describe("a read-back that meets a private holder", () => {
  const rel = "Brain/decisions/zqstandingreadback.md";

  test("(k2) below local reach the read-back answers the fixed answer and names nothing", () => {
    const e = env();
    writeLanePage(e.vault, join(e.vault, rel), { kind: "note" }, "# shared\n\nOpen text.\n");
    const race = aheadOnReadBack(e, rel);
    const outcome = thrown(() =>
      withPrivateWithheld(true, () =>
        writeLanePage(e.vault, join(e.vault, rel), { kind: "note" }, "# remote\n\nRemote text.\n", {
          overwrite: true,
        }),
      ),
    );
    restore?.();
    restore = null;
    expect({
      fired: race.fired,
      outcome,
      names: ["zqstandingreadback", "human", "authority", "version"].filter((mark) =>
        outcome.includes(mark),
      ),
    }).toEqual({ fired: true, outcome: `LaneEntryWithheldError: ${WITHHELD}`, names: [] });
  });

  test("(k2) local control: at local reach the read-back names the version that holds the entry", () => {
    const e = env();
    writeLanePage(e.vault, join(e.vault, rel), { kind: "note" }, "# shared\n\nOpen text.\n");
    const race = aheadOnReadBack(e, rel);
    const outcome = thrown(() =>
      writeLanePage(e.vault, join(e.vault, rel), { kind: "note" }, "# local\n\nLocal text.\n", {
        overwrite: true,
      }),
    );
    restore?.();
    restore = null;
    expect({ fired: race.fired, outcome }).toEqual({
      fired: true,
      outcome:
        "LaneWriteNotAppliedError: decisions/zqstandingreadback.md was not changed: " +
        "the store keeps a version written at authority human",
    });
    expect(readLaneText(e.vault, join(e.vault, rel))).toContain("zqstandingahead");
  });
});

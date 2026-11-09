/**
 * A store-only machine enumerates its lane pages from `lane-entry` records,
 * and a synced peer can write any entry id (FORMAT.md, Trust). An entry id
 * that climbs out of `Brain/` (`..`, absolute, Windows-style) never turns
 * into a path a lane reader lists, checks or removes, and a signal's
 * recorded path never names its page outside its own inbox folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { storeRecordPages } from "../../../src/core/brain/memory-pages.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { lanePageExists, listLaneFiles, listLaneTree } from "../../../src/core/store/lane-pages.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const HOSTILE = ["../../../../escape", "/etc/escape", "..\\..\\escape", "C:/escape", "a//b"];

describe("hostile peer lane entries", () => {
  test("are not listed, found or turned into paths outside Brain/", () => {
    lane = makeLaneEnv("store");
    const peer = openStore({ root: lane.env.storeRoot, device: "dev-b" });
    for (const entry of [...HOSTILE, "fine"]) {
      appendRecord(peer, {
        partition: "shared",
        stream: "events",
        kind: "lane-entry",
        agent: "t",
        body: { authority: "agent", lane: "captures", entry, fields: {}, text: "x" },
      });
    }
    const { vault } = lane;
    const brain = resolve(vault, "Brain");
    const tree = listLaneTree(vault, join(vault, "Brain"));
    expect(tree).toEqual([join(vault, "Brain", "captures", "fine.md")]);
    for (const path of tree) expect(resolve(path).startsWith(brain)).toBe(true);
    expect(listLaneFiles(vault, join(vault, "Brain", "captures"))).toEqual(["fine.md"]);
    expect(lanePageExists(vault, join(vault, "escape.md"))).toBe(false);
  });

  test("a signal whose recorded path is no record path keeps its page in its own folder", () => {
    lane = makeLaneEnv("store");
    const peer = openStore({ root: lane.env.storeRoot, device: "dev-b" });
    for (const [id, path] of [
      ["sig-win", "Brain\\..\\..\\notes\\victim.md"],
      ["sig-up", "Brain/inbox/../../notes/victim.md"],
    ] as const) {
      appendRecord(peer, {
        partition: "shared",
        stream: "events",
        kind: "signal",
        agent: "t",
        body: { id, path, staged: false, frontmatter: { id, topic: "t" }, raw: "x" },
      });
    }
    const rels = storeRecordPages(lane.vault, { signalStates: "all" })
      .filter((page) => page.kind === "signal")
      .map((page) => page.rel)
      .toSorted();
    expect(rels).toEqual(["Brain/inbox/sig-up.md", "Brain/inbox/sig-win.md"]);
  });
});

/**
 * The repair of lane entry ids an earlier release gave a page named
 * `x.json.md` (task 3.9, design D15 item 1): its imported record sat under
 * `x.json`, the id of the file beside it. The repair moves it to the id its
 * legacy path maps to and gives the old key back the file's own record.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import {
  LANE_FOLDER_UNIMPORTABLE_CODE,
  LANE_ID_MISFILED_CODE,
} from "../../../src/core/brain/doctor/lane-id-check.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";

import { dream } from "../../../src/core/brain/dream.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readLanePage, readLaneText, removeLanePage } from "../../../src/core/store/lane-pages.ts";
import { foldLaneEntries } from "../../../src/core/store/lane-records.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import {
  planLaneIdRepairs,
  repairLaneEntryIds,
} from "../../../src/core/store-migration/lane-id-repair.ts";
import { makeLaneEnv, type LaneEnv } from "../lanes/fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** A lane-entry record as an earlier migration imported it from `key`. */
function imported(
  e: LaneEnv,
  entry: string,
  key: string,
  fields: Record<string, unknown>,
  text: string,
  authority: "agent" | "human" = "agent",
  device = "dev-a",
  partition: "shared" | "private" = "shared",
): string {
  return appendRecord(openStore({ root: e.env.storeRoot, device }), {
    partition,
    stream: "events",
    kind: "lane-entry",
    agent: "o2b",
    body: {
      authority,
      lane: "entities",
      entry,
      fields,
      text,
      migrated: { key, sum: `sum-of-${key}` },
    },
  }).path;
}

describe("a page filed under the id of the file beside it", () => {
  test("moves to its own id, and the old id gets the file back", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json", { a: 1 }, "");
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "The page.\n");
    const json = join(vault, "Brain", "entities", "x.json");
    const page = join(vault, "Brain", "entities", "x.json.md");
    // Before: the page reads by no path, and the file reads the page.
    expect(readLanePage(vault, page)).toBeNull();

    expect(repairLaneEntryIds(vault)).toEqual([
      { from: "entities/x.json", to: "entities/x.json.md", left: "restored" },
    ]);
    expect(readLanePage(vault, page)?.body).toBe("The page.\n");
    expect(JSON.parse(readLaneText(vault, json) ?? "null")).toEqual({ a: 1 });
    // The record under the new id still names the legacy path it came from.
    const moved = lane
      .laneRecords()
      .filter((r) => r.kind === "lane-entry" && r.body["entry"] === "x.json.md");
    expect(moved.map((r) => (r.body["migrated"] as { key: string }).key)).toEqual([
      "Brain/entities/x.json.md",
    ]);
    // Repaired once: a second run finds nothing.
    const records = lane.laneRecords().length;
    expect(repairLaneEntryIds(vault)).toEqual([]);
    expect(lane.laneRecords()).toHaveLength(records);
  });

  test("with no file beside it the old id is removed, by the dream pass", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "y.yaml", "Brain/entities/y.yaml.md", { kind: "note" }, "Only a page.\n");
    dream(vault, { now: new Date("2026-11-15T12:00:00Z") });
    expect(readLanePage(vault, join(vault, "Brain", "entities", "y.yaml.md"))?.body).toBe(
      "Only a page.\n",
    );
    expect(readLaneText(vault, join(vault, "Brain", "entities", "y.yaml"))).toBeNull();
  });
});

/** What the repair would write for the store as this machine holds it now. */
function planned(e: LaneEnv) {
  const all = (["shared", "private"] as const).flatMap((partition) =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.records)
      .map((record) => ({ record, partition })),
  );
  return planLaneIdRepairs(all);
}

describe("the repair stays repaired", () => {
  test("a page removed after its repair is never written back", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "The page.\n");
    repairLaneEntryIds(vault);
    const page = join(vault, "Brain", "entities", "x.json.md");
    expect(removeLanePage(vault, page)).toBe(true);
    expect(planned(lane).records).toEqual([]);
    expect(readLanePage(vault, page)).toBeNull();
  });

  test("a page imported with human authority gives its id back to the file", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json", { a: 1 }, "");
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "Mine.\n", "human");
    repairLaneEntryIds(vault);
    expect(
      JSON.parse(readLaneText(vault, join(vault, "Brain", "entities", "x.json")) ?? "null"),
    ).toEqual({
      a: 1,
    });
    expect(planned(lane).records).toEqual([]);
  });

  test("a machine without the private partition repairs nothing", () => {
    lane = makeLaneEnv("store", "osb-lane-", { partitions: ["shared"] });
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "The page.\n");
    const before = lane.laneRecords().length;
    expect(repairLaneEntryIds(vault)).toEqual([]);
    expect(lane.laneRecords()).toHaveLength(before);
  });
});

describe("a pass that could not read every shard", () => {
  test("runs again, and repairs a record that arrives with the shard", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const shard = imported(
      lane,
      "x.json",
      "Brain/entities/x.json.md",
      { kind: "note" },
      "Late.\n",
      "agent",
      "dev-b",
    );
    // Read once, then gone (sync is moving it): this pass cannot see it.
    readStreamRecords(lane.env.storeRoot, "shared", { stream: "events" });
    renameSync(shard, `${shard}.away`);
    expect(repairLaneEntryIds(vault)).toEqual([]);
    renameSync(`${shard}.away`, shard);
    expect(repairLaneEntryIds(vault)).toEqual([
      { from: "entities/x.json", to: "entities/x.json.md", left: "removed" },
    ]);
  });
});

function misfiled(vault: string) {
  return runDoctor(vault).warnings.filter((w) => w.code === LANE_ID_MISFILED_CODE);
}

describe("a page mis-filed after a finished pass", () => {
  test("is repaired by the next pass, as the doctor says", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "a.json", "Brain/entities/a.json.md", { kind: "note" }, "First.\n");
    expect(repairLaneEntryIds(vault)).toHaveLength(1);
    // A machine still on the earlier release imports another one later.
    imported(
      lane,
      "b.json",
      "Brain/entities/b.json.md",
      { kind: "note" },
      "Late.\n",
      "agent",
      "dev-b",
    );
    expect(misfiled(vault)[0]?.message).toContain("the next `o2b brain dream`");
    expect(repairLaneEntryIds(vault)).toEqual([
      { from: "entities/b.json", to: "entities/b.json.md", left: "removed" },
    ]);
    expect(misfiled(vault)).toEqual([]);
  });
});

describe("the doctor", () => {
  test("names a mis-filed page on a machine without private, with the remedy", () => {
    lane = makeLaneEnv("store", "osb-lane-", { partitions: ["shared"] });
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "The page.\n");
    const [finding] = misfiled(lane.vault);
    expect(finding?.message).toContain("entities/x.json (its own id is entities/x.json.md)");
    expect(finding?.message).toContain("o2b store init --partitions shared,private");
  });

  test("is quiet once a machine that holds private repaired it", () => {
    lane = makeLaneEnv("store");
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "The page.\n");
    expect(misfiled(lane.vault)[0]?.message).toContain("the next `o2b brain dream`");
    repairLaneEntryIds(lane.vault);
    expect(misfiled(lane.vault)).toEqual([]);
  });
});

describe("the doctor before a migration", () => {
  test("names legacy folders whose pages no lane takes, not a folder spelled otherwise", () => {
    lane = makeLaneEnv("legacy");
    for (const folder of ["My Notes", "my-notes", "brain", "Lone Folder"]) {
      mkdirSync(join(lane.vault, "Brain", folder), { recursive: true });
    }
    const finding = runDoctor(lane.vault).warnings.find(
      (w) => w.code === LANE_FOLDER_UNIMPORTABLE_CODE,
    );
    expect(finding?.message).toContain("My Notes (lane my-notes, also my-notes)");
    expect(finding?.message).toContain("brain (its name is no lane of its own)");
    expect(finding?.message).not.toContain("Lone Folder");
  });
});

/** A removal of `<entities>/<entry>` as an earlier release or a person wrote it. */
function removed(e: LaneEnv, entry: string, authority: "agent" | "human"): void {
  appendRecord(openStore({ root: e.env.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "events",
    kind: "lane-entry-remove",
    agent: "o2b",
    body: { authority, lane: "entities", entry },
  });
}

describe("review cases of the repair", () => {
  test("a file removed before the page was filed over it stays removed", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json", { a: 1 }, "");
    removed(lane, "x.json", "human");
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "Page.\n", "human");
    expect(repairLaneEntryIds(vault)).toEqual([
      { from: "entities/x.json", to: "entities/x.json.md", left: "removed" },
    ]);
    expect(readLaneText(vault, join(vault, "Brain", "entities", "x.json"))).toBeNull();
    expect(readLanePage(vault, join(vault, "Brain", "entities", "x.json.md"))?.body).toBe(
      "Page.\n",
    );
  });

  test("a page whose own id holds the next mis-filed page: both reach their own ids", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "One.\n");
    imported(lane, "x.json.md", "Brain/entities/x.json.md.md", { kind: "note" }, "Two.\n");
    repairLaneEntryIds(vault);
    const at = (rel: string) => join(vault, "Brain", "entities", rel);
    expect(readLanePage(vault, at("x.json.md"))?.body).toBe("One.\n");
    expect(readLanePage(vault, at("x.json.md.md"))?.body).toBe("Two.\n");
    expect(readLaneText(vault, at("x.json"))).toBeNull();
    expect(planned(lane).records).toEqual([]);
  });

  test("a read that misses the file beside the page writes nothing, then restores it", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    const shard = imported(lane, "x.json", "Brain/entities/x.json", { a: 1 }, "", "agent", "dev-b");
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "Page.\n", "human");
    readStreamRecords(lane.env.storeRoot, "shared", { stream: "events" });
    renameSync(shard, `${shard}.away`);
    const before = lane.laneRecords().length;
    expect(repairLaneEntryIds(vault)).toEqual([]);
    expect(lane.laneRecords()).toHaveLength(before);
    renameSync(`${shard}.away`, shard);
    repairLaneEntryIds(vault);
    expect(
      JSON.parse(readLaneText(vault, join(vault, "Brain", "entities", "x.json")) ?? "null"),
    ).toEqual({
      a: 1,
    });
  });
});

describe("the doctor below local reach", () => {
  test("names no private mis-filed id, no legacy folder and no partition this machine holds", () => {
    lane = makeLaneEnv("store");
    imported(lane, "a.json", "Brain/entities/a.json.md", { kind: "note" }, "Shared.\n");
    appendRecord(openStore({ root: lane.env.storeRoot, device: "dev-a" }), {
      partition: "private",
      stream: "events",
      kind: "lane-entry",
      agent: "o2b",
      body: {
        authority: "agent",
        lane: "entities",
        entry: "secret.json",
        fields: { kind: "note" },
        text: "Private.\n",
        migrated: { key: "Brain/entities/secret.json.md", sum: "s" },
      },
    });
    mkdirSync(join(lane.vault, "Brain", "My Notes"), { recursive: true });
    mkdirSync(join(lane.vault, "Brain", "my-notes"), { recursive: true });
    const result = runDoctor(lane.vault, { reach: TRANSPORT_REACH.remote });
    const text = JSON.stringify(result);
    expect(text).toContain("entities/a.json");
    expect(text).not.toContain("secret");
    // One remedy whatever this machine holds: its partitions are not named.
    expect(text).toContain("on a machine that holds every partition");
    expect(text).not.toContain("on this machine repairs them");
    expect(text).not.toContain("My Notes");
    expect((result.uncertain ?? []).map((u) => u.code)).toContain(LANE_FOLDER_UNIMPORTABLE_CODE);
    // Locally both are named.
    const local = JSON.stringify(runDoctor(lane.vault));
    expect(local).toContain("entities/secret.json");
    expect(local).toContain("My Notes");
  });
});

describe("the repair resolves each side as the register does", () => {
  test("the page moved is the one its records resolve to, not the latest", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "Approved.\n", "human");
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "Draft.\n", "agent");
    repairLaneEntryIds(vault);
    expect(readLanePage(vault, join(vault, "Brain", "entities", "x.json.md"))?.body).toBe(
      "Approved.\n",
    );
  });

  test("the file restored is the one its records resolve to, not the latest", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json", { a: "human" }, "", "human");
    imported(lane, "x.json", "Brain/entities/x.json", { a: "agent" }, "", "agent");
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "Page.\n", "human");
    repairLaneEntryIds(vault);
    expect(
      JSON.parse(readLaneText(vault, join(vault, "Brain", "entities", "x.json")) ?? "null"),
    ).toEqual({ a: "human" });
  });
});

/** The lane entry `entities/<entry>` as a machine that holds only `shared` folds it. */
function sharedValue(e: LaneEnv, entry: string) {
  const records = readPartition(join(e.env.storeRoot, "shared")).flatMap((shard) => shard.records);
  return foldLaneEntries(records).entries.get(`entities/${entry}`)?.value ?? null;
}

describe("the repair across partitions", () => {
  test("a file restored in private over a shared page: the page leaves shared too", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(lane, "x.json", "Brain/entities/x.json", { a: 1 }, "", "agent", "dev-a", "private");
    imported(lane, "x.json", "Brain/entities/x.json.md", { kind: "note" }, "Page.\n");
    repairLaneEntryIds(vault);
    expect(sharedValue(lane, "x.json")).toBeNull();
    expect(
      JSON.parse(readLaneText(vault, join(vault, "Brain", "entities", "x.json")) ?? "null"),
    ).toEqual({
      a: 1,
    });
  });

  test("a page moved in private over a shared mis-filed page: that page leaves shared", () => {
    lane = makeLaneEnv("store");
    const { vault } = lane;
    imported(
      lane,
      "x.json",
      "Brain/entities/x.json.md",
      { kind: "note" },
      "One.\n",
      "agent",
      "dev-a",
      "private",
    );
    imported(lane, "x.json.md", "Brain/entities/x.json.md.md", { kind: "note" }, "Two.\n");
    repairLaneEntryIds(vault);
    expect(sharedValue(lane, "x.json.md")).toBeNull();
    expect(readLanePage(vault, join(vault, "Brain", "entities", "x.json.md"))?.body).toBe("One.\n");
    expect(readLanePage(vault, join(vault, "Brain", "entities", "x.json.md.md"))?.body).toBe(
      "Two.\n",
    );
  });
});

describe("the doctor for a caller who may not read a page", () => {
  test("neither names nor counts a mis-filed page of it", () => {
    lane = makeLaneEnv("store");
    imported(lane, "a.json", "Brain/entities/a.json.md", { kind: "note" }, "Open.\n");
    imported(lane, "b.json", "Brain/entities/b.json.md", { kind: "note" }, "Hidden.\n");
    const result = runDoctor(lane.vault, {
      readable: (rel) => !rel.startsWith("Brain/entities/b.json"),
    });
    const finding = result.warnings.find((w) => w.code === LANE_ID_MISFILED_CODE);
    expect(finding?.message).toContain("entities/a.json");
    expect(finding?.message).toStartWith("1 lane page(s)");
    expect(finding?.message).not.toContain("entities/b.json");
  });
});

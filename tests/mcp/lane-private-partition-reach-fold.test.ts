/**
 * Private-partition lane entries are withheld below local reach: the
 * common read boundary, the projections a caller below local reach can
 * rebuild, and the removal that binds its reach check to the fold it
 * builds from (change `lane-private-partition-reach`, the review round).
 *
 * The machine under test keeps its lane pages in the store. A server with
 * no reach minted is a caller below local reach; a server at the local
 * reach is the control.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import * as guard from "../../src/core/store/lane-reach-guard.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import {
  laneEntryInPrivate,
  moveLanePage,
  readLaneText,
  removeLanePage,
  removeLaneTree,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  call,
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";
import {
  dropPrivateEvents,
  raiseWithoutTombstone,
  sharedLaneRecord,
} from "./lane-private-partition-reach-store-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const NOW = new Date("2026-11-20T10:00:00Z");

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-fold-");
  return lane;
}

/** Open a write session at local reach on `target`; returns its id. */
async function openSession(e: LaneEnv, target: string, prompt: string): Promise<string> {
  const opened = await callJson(localServer(e), "brain_write_session", {
    op: "open",
    kind: "artifact",
    target,
    prompt,
  });
  const id = String(opened["session_id"] ?? opened["id"] ?? "");
  expect(id).not.toBe("");
  return id;
}

// ----- The common read boundary (design D3) -----------------------------------------

describe("private-partition lane entries are withheld below local reach: the read boundary", () => {
  test("a reader with no predicate lists nothing while the fold is incomplete", async () => {
    const e = env();
    const id = await openSession(e, "Brain/reports/zqfoldshared.md", "zqfoldprompt shared");
    // A hidden session gives the private partition its `events` shard.
    await openSession(e, "Brain/reports/zqfoldhidden.md", `zqfoldhidden ${REGION}`);
    const remote = server(e);
    // The control: the shared session is listed below local reach.
    expect((await call(remote, "brain_write_session", { op: "list" })).includes(id)).toBe(true);
    dropPrivateEvents(e);
    const remoteList = await call(remote, "brain_write_session", { op: "list" });
    const localList = await call(localServer(e), "brain_write_session", { op: "list" });
    expect({
      remote: remoteList.includes(id),
      remote_names_private_gap: remoteList.includes("private/events/"),
      local: localList.includes(id),
    }).toEqual({ remote: false, remote_names_private_gap: false, local: true });
  });

  test("a reader with no predicate does not see a stale shared value of a raised entry", async () => {
    const e = env();
    const id = await openSession(e, "Brain/reports/zqraisedshared.md", "zqraisedprompt plain");
    const kept = await openSession(e, "Brain/reports/zqkeptshared.md", "zqkeptprompt plain");
    const record = sharedLaneRecord(e, "write-session", id);
    // The raise arrived without the tombstone of the shared value.
    raiseWithoutTombstone(e, record, `${String(record["text"])}\n${REGION}`);
    const remote = server(e);
    const list = await call(remote, "brain_write_session", { op: "list" });
    const status = await call(remote, "brain_write_session", { op: "status", session_id: id });
    // Ids are matched quoted: one session id can be the prefix of another.
    expect({
      listed: list.includes(`"${id}"`),
      control_listed: list.includes(`"${kept}"`),
      status_known: !status.includes("unknown write-session"),
    }).toEqual({ listed: false, control_listed: true, status_known: false });
    // The view's stamp carries the verdict: it moved with the raise.
    const before = withPrivateWithheld(true, () => laneStoreFold().fingerprint);
    expect(before).toContain("withheld=");
  });

  test("an entity list below local reach leaves out a raised entity's shared value", async () => {
    const e = env();
    const entity = (name: string) =>
      upsertEntity(e.vault, {
        category: "people",
        name,
        agent: AGENT,
        now: NOW,
        body: `${name.toLowerCase()} notes\n`,
      });
    entity("Zqentraised Person");
    entity("Zqentkept Person");
    expect(await call(server(e), "brain_entity", { view: "list" })).toContain("Zqentraised");
    const record = sharedLaneRecord(e, "entities", "ent-people-zqentraised-person");
    raiseWithoutTombstone(e, record, `${String(record["text"])}\n${REGION}`);
    const after = await call(server(e), "brain_entity", { view: "list" });
    expect({ raised: after.includes("Zqentraised"), kept: after.includes("Zqentkept") }).toEqual({
      raised: false,
      kept: true,
    });
  });
});

// ----- Projections a caller below local reach can rebuild (design D5) ---------------

describe("private-partition lane entries are withheld below local reach: rebuilt projections", () => {
  test("a remote claim-graph rebuild keeps the local history whole", async () => {
    const e = env();
    const thesis = (slug: string, region: string) =>
      writeLaneText(
        e.vault,
        join(e.vault, "Brain", "theses", `${slug}.md`),
        `---\ntopic: zqclaimtopic\nprinciple: ${slug} principle\nvalid_from: 2026-01-01\n---\n\n${slug} body\n\n${region}\n`,
      );
    thesis("zqclaimhidden", REGION);
    thesis("zqclaimshared", "");
    expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain/theses/zqclaimhidden.md"))).toBe(true);
    const rebuilt = await callJson(server(e), "brain_claims", { operation: "rebuild" });
    const localHistory = await call(localServer(e), "brain_claims", { operation: "history" });
    const remoteHistory = await call(server(e), "brain_claims", { operation: "history" });
    expect({
      count: rebuilt["node_count"],
      truncated: rebuilt["truncated"],
      local_hidden: localHistory.includes("zqclaimhidden"),
      local_shared: localHistory.includes("zqclaimshared"),
      remote_hidden: remoteHistory.includes("zqclaimhidden"),
    }).toEqual({
      count: 1,
      truncated: false,
      local_hidden: true,
      local_shared: true,
      remote_hidden: false,
    });
  });
});

// ----- A removal binds its reach check to the fold it builds from -------------------

/**
 * Run `fn` below local reach with a raise of the entry at `path` landing
 * right after the removal's own reach check of that path read the fold:
 * the private record alone, with the same authority, as another writer's
 * raise lands between two reads of one removal.
 */
function raisedDuringRemoval(e: LaneEnv, path: string, entry: string, fn: () => void): void {
  const original = guard.withheldPrivateKey;
  let raised = false;
  const spy = spyOn(guard, "withheldPrivateKey").mockImplementation(
    (vault: string, at: string, configPath?: string) => {
      const answer = original(vault, at, configPath);
      if (!raised && at === path) {
        raised = true;
        const record = sharedLaneRecord(e, "procedures", entry);
        raiseWithoutTombstone(e, record, `${String(record["text"])}\n${REGION}`);
      }
      return answer;
    },
  );
  try {
    withPrivateWithheld(true, fn);
  } finally {
    spy.mockRestore();
  }
  expect(raised).toBe(true);
}

/**
 * Run `fn` below local reach with the entry raised as the removal's store
 * write starts to build its records: after every read the removal made
 * before it (`removalRecordsAtReach` is the builder the write calls).
 */
function raisedAtBuild(e: LaneEnv, entry: string, fn: () => void): void {
  const original = guard.removalRecordsAtReach;
  let raised = false;
  const spy = spyOn(guard, "removalRecordsAtReach").mockImplementation(
    (vault: string, paths: ReadonlyArray<string>, configPath?: string) => {
      if (!raised) {
        raised = true;
        const record = sharedLaneRecord(e, "procedures", entry);
        raiseWithoutTombstone(e, record, `${String(record["text"])}\n${REGION}`);
      }
      return original(vault, paths, configPath);
    },
  );
  try {
    withPrivateWithheld(true, fn);
  } finally {
    spy.mockRestore();
  }
  expect(raised).toBe(true);
}

describe("private-partition lane entries are withheld below local reach: removal binding", () => {
  test("a winner that changed before the build is judged again before the append", () => {
    const e = env();
    const path = join(e.vault, "Brain", "procedures", "zqbuildraised.md");
    writeLaneText(e.vault, path, "---\ntitle: Zqbuildraised\n---\n\nsteps\n");
    let removed = null as boolean | null;
    raisedAtBuild(e, "zqbuildraised", () => {
      removed = removeLanePage(e.vault, path);
    });
    expect({
      removed,
      tombstones: e.laneRecords().filter((r) => r.kind === "lane-entry-remove").length,
      local_reads: (readLaneText(e.vault, path) ?? "").includes("synthetic region body"),
    }).toEqual({ removed: false, tombstones: 0, local_reads: true });
  });

  test("a removal whose entry is raised meanwhile writes no private tombstone", () => {
    const e = env();
    const path = join(e.vault, "Brain", "procedures", "zqrmraised.md");
    writeLaneText(e.vault, path, "---\ntitle: Zqrmraised\n---\n\nsteps\n");
    let removed = null as boolean | null;
    raisedDuringRemoval(e, path, "zqrmraised", () => {
      removed = removeLanePage(e.vault, path);
    });
    expect({
      removed,
      private_tombstones: e.laneRecords("private").filter((r) => r.kind === "lane-entry-remove")
        .length,
      local_reads: (readLaneText(e.vault, path) ?? "").includes("synthetic region body"),
    }).toEqual({ removed: false, private_tombstones: 0, local_reads: true });
  });

  test("a move whose source is raised meanwhile writes no private tombstone", () => {
    const e = env();
    const from = join(e.vault, "Brain", "procedures", "zqmvraised.md");
    const to = join(e.vault, "Brain", "procedures", "zqmvmoved.md");
    writeLaneText(e.vault, from, "---\ntitle: Zqmvraised\n---\n\nsteps\n");
    const original = guard.assertLaneWriteAtReach;
    let raised = false;
    const spy = spyOn(guard, "assertLaneWriteAtReach").mockImplementation(
      (vault: string, paths: ReadonlyArray<string>, configPath?: string) => {
        original(vault, paths, configPath);
        if (!raised && paths.includes(to)) {
          raised = true;
          const record = sharedLaneRecord(e, "procedures", "zqmvraised");
          raiseWithoutTombstone(e, record, `${String(record["text"])}\n${REGION}`);
        }
      },
    );
    try {
      withPrivateWithheld(true, () => moveLanePage(e.vault, from, to));
    } finally {
      spy.mockRestore();
    }
    expect({
      raised,
      private_tombstones: e.laneRecords("private").filter((r) => r.kind === "lane-entry-remove")
        .length,
      source_reads: (readLaneText(e.vault, from) ?? "").includes("synthetic region body"),
    }).toEqual({ raised: true, private_tombstones: 0, source_reads: true });
  });

  test("a tree removal whose entry is raised meanwhile writes no private tombstone", () => {
    const e = env();
    const dir = join(e.vault, "Brain", "procedures");
    const raisedPath = join(dir, "zqtreeraised.md");
    const keptPath = join(dir, "zqtreekept.md");
    writeLaneText(e.vault, raisedPath, "---\ntitle: Zqtreeraised\n---\n\nsteps\n");
    writeLaneText(e.vault, keptPath, "---\ntitle: Zqtreekept\n---\n\nsteps\n");
    raisedDuringRemoval(e, raisedPath, "zqtreeraised", () => removeLaneTree(e.vault, dir));
    expect({
      private_tombstones: e.laneRecords("private").filter((r) => r.kind === "lane-entry-remove")
        .length,
      raised_reads: (readLaneText(e.vault, raisedPath) ?? "").includes("synthetic region body"),
      kept_removed: readLaneText(e.vault, keptPath) === null,
    }).toEqual({ private_tombstones: 0, raised_reads: true, kept_removed: true });
  });
});

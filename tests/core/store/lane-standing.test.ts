/**
 * The kept standing of a lane write (change `tool-lane-write-keeps-standing`,
 * design D1 and D4): on a machine whose lane pages live in the store, a
 * lane write that replaces, removes, moves or re-creates an entry is stored
 * at the stronger of the writer's own authority and the authority of the
 * record that holds the entry, and names the writer's own authority in
 * `acted_by` when the two differ. A version another device wrote apart is
 * arbitrated by the authority order, then the clock.
 *
 * Every case runs through the lane page API on a switched machine with the
 * origin channel set: `cli` is an operator's command (authority `human`),
 * `mcp-tool` an agent's tool call (authority `agent`). The winning record
 * of a key is read through `foldLaneEntries`, the fold the lane store uses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { ORIGIN_CHANNEL, setOriginChannel } from "../../../src/core/origin-channel.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StorePartition } from "../../../src/core/store/constants.ts";
import type { RecordBody, StoreRecord } from "../../../src/core/store/envelope.ts";
import { SIGNAL_STATE_KIND } from "../../../src/core/store/fold-signals.ts";
import { HLC_MAX_DRIFT_MS, parseHlc } from "../../../src/core/store/hlc.ts";
import { storeEntryRead } from "../../../src/core/store/lane-entry-store.ts";
import { wholeLaneStoreFold } from "../../../src/core/store/lane-fold-cache.ts";
import {
  LaneEntryChangedError,
  LaneWriteNotAppliedError,
  lanePageExists,
  moveLanePage,
  moveLaneTree,
  readLaneBase,
  readLaneText,
  removeLanePage,
  removeLaneTree,
  writeLanePage,
  writeLaneText,
} from "../../../src/core/store/lane-pages.ts";
import { lanePlaceOf } from "../../../src/core/store/lane-paths.ts";
import {
  foldLaneEntries,
  laneEntryKey,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
} from "../../../src/core/store/lane-records.ts";
import { readStoreEntities } from "../../../src/core/store/read/store-entities.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { StoreWriteError } from "../../../src/core/store/store-write.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { shardMonth, shardPath } from "../../../src/core/store/store-paths.ts";
import { partitionRecords, switchDevice } from "../brain/store-only/fixtures.ts";
import { authored, rec } from "./fixtures/fold-records.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

/** A machine whose lane pages live in the store: switched, no legacy tree. */
function switchedMachine(prefix: string): StoreEnv {
  const made = makeStoreEnv(prefix, { legacyTree: false });
  // This device's own `device-switched` record, as the migration writes it.
  switchDevice(made.storeRoot);
  expect(storeOnlyMode({ vault: made.vault })).toMatchObject({
    storeOnly: true,
    reason: "device-switched",
  });
  return made;
}

/** An operator's command: channel `cli`, authority `human`. */
function asOperator(): void {
  setOriginChannel(ORIGIN_CHANNEL.cli);
}

/** An agent's tool call: channel `mcp-tool`, authority `agent`. */
function asAgent(): void {
  setOriginChannel(ORIGIN_CHANNEL.mcpTool);
}

/** The absolute path of the vault-relative `rel`. */
function at(e: StoreEnv, rel: string): string {
  return join(e.vault, rel);
}

/** The fold key of the vault-relative lane path `rel`. */
function keyOf(rel: string): string {
  const place = lanePlaceOf(rel.replace(/^Brain\//u, ""));
  if (place === null) throw new Error(`no lane entry: ${rel}`);
  return laneEntryKey(place.lane, place.entry);
}

/** Every lane record of the store, of one partition when given. */
function laneRecords(e: StoreEnv, only?: StorePartition): StoreRecord[] {
  return (only !== undefined ? [only] : (["shared", "private"] as const)).flatMap((partition) =>
    partitionRecords(e.storeRoot, partition).filter(
      (r) => r.kind === LANE_ENTRY_KIND || r.kind === LANE_ENTRY_REMOVE_KIND,
    ),
  );
}

/** The winning record of the lane path `rel`, read through `foldLaneEntries`. */
function winnerOf(e: StoreEnv, rel: string): StoreRecord {
  const records = laneRecords(e);
  const state = foldLaneEntries(records).entries.get(keyOf(rel));
  if (state === undefined) throw new Error(`no record of ${rel}`);
  const winner = records.find((r) => r.id === state.winner);
  if (winner === undefined) throw new Error(`no winning record of ${rel}`);
  return winner;
}

/** The kind, authority and `acted_by` of the winning record of `rel`. */
function standingOf(e: StoreEnv, rel: string): Record<string, unknown> {
  const winner = winnerOf(e, rel);
  return {
    kind: winner.kind,
    authority: winner.body["authority"],
    acted_by: winner.body["acted_by"],
  };
}

/** The physical clock (ms) of the newest record of the lane path `rel`. */
function clockOf(e: StoreEnv, rel: string): number {
  const key = keyOf(rel);
  let newest = 0;
  for (const r of laneRecords(e)) {
    if (laneEntryKey(String(r.body["lane"]), String(r.body["entry"])) !== key) continue;
    newest = Math.max(newest, parseHlc(r.hlc)!.physical);
  }
  return newest;
}

/** Append one record from another device, stamped at `ms`. */
function write(
  store: StoreHandle,
  ms: number,
  kind: string,
  body: RecordBody,
  partition: StorePartition = "shared",
) {
  return appendRecord(
    store,
    { partition, stream: "events", kind, agent: "agent-1", body },
    { now: () => ms },
  );
}

/** The body of a `human` version of the lane path `rel` with `text`. */
function humanVersion(rel: string, text: string): RecordBody {
  const place = lanePlaceOf(rel.replace(/^Brain\//u, ""))!;
  return { authority: "human", lane: place.lane, entry: place.entry, fields: {}, text };
}

/** A `human` version of the lane path `rel` written on another device at `ms`. */
function otherDeviceVersion(e: StoreEnv, rel: string, ms: number, text: string): void {
  write(
    openStore({ root: e.storeRoot, device: "dev-b" }),
    ms,
    LANE_ENTRY_KIND,
    humanVersion(rel, text),
  );
}

/**
 * A `human` version of the lane path `rel` another device stamped at `ms`,
 * delivered into this store as that device's own `events` shard line, as a
 * sync delivers it. An append through this process stamps after the newest
 * record the process read (the receive rule, `clock-floor.ts`), so a
 * version stamped before a record this machine already read can only
 * arrive this way.
 */
function deliveredVersion(e: StoreEnv, rel: string, ms: number, text: string): void {
  const record = rec({
    physical: ms,
    device: "dev-b",
    kind: LANE_ENTRY_KIND,
    body: humanVersion(rel, text),
  });
  const path = shardPath(e.storeRoot, "shared", { stream: "events" }, "dev-b", shardMonth(ms));
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

/** The page text of a note with body `body`. */
function note(body: string): string {
  return `---\nkind: note\n---\n\n${body}\n`;
}

/** The value `foldLaneEntries` gives the obligation entry of one record. */
function foldedValue(record: StoreRecord) {
  return foldLaneEntries([record]).entries.get(laneEntryKey("obligations", "obl-a"))?.value;
}

const HUMAN_KEPT = { kind: LANE_ENTRY_KIND, authority: "human", acted_by: "agent" };
const HUMAN_TOMBSTONE = { kind: LANE_ENTRY_REMOVE_KIND, authority: "human", acted_by: "agent" };

describe("a lane write keeps the standing of the entry it replaces", () => {
  test("(a) a writeLaneText rewrite at mcp-tool of a cli entry reads back at human, acted by agent", () => {
    env = switchedMachine("osb-lane-standing-a-");
    const rel = "Brain/decisions/zq-standing-a.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Operator text."));
    asAgent();
    writeLaneText(env.vault, at(env, rel), note("Agent text."));
    expect({ text: readLaneText(env.vault, at(env, rel)), standing: standingOf(env, rel) }).toEqual(
      { text: note("Agent text."), standing: HUMAN_KEPT },
    );
  });

  test("(b) a writeLanePage overwrite at mcp-tool of a cli entry reads back at human, acted by agent", () => {
    env = switchedMachine("osb-lane-standing-b-");
    const rel = "Brain/decisions/zq-standing-b.md";
    asOperator();
    writeLanePage(env.vault, at(env, rel), { kind: "note" }, "Operator text.\n", {
      overwrite: true,
    });
    asAgent();
    writeLanePage(env.vault, at(env, rel), { kind: "note" }, "Agent text.\n", { overwrite: true });
    expect({
      body: readLaneText(env.vault, at(env, rel))?.includes("Agent text."),
      standing: standingOf(env, rel),
    }).toEqual({ body: true, standing: HUMAN_KEPT });
  });

  test("(c) a cli rewrite of an agent entry is stored at human with no acted_by", () => {
    env = switchedMachine("osb-lane-standing-c-");
    const rel = "Brain/decisions/zq-standing-c.md";
    asAgent();
    writeLaneText(env.vault, at(env, rel), note("Agent text."));
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Operator text."));
    expect({ text: readLaneText(env.vault, at(env, rel)), standing: standingOf(env, rel) }).toEqual(
      {
        text: note("Operator text."),
        standing: { kind: LANE_ENTRY_KIND, authority: "human", acted_by: undefined },
      },
    );
  });

  test("(d) a removeLanePage at mcp-tool of a cli entry leaves a human tombstone, acted by agent", () => {
    env = switchedMachine("osb-lane-standing-d-");
    const rel = "Brain/decisions/zq-standing-d.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Operator text."));
    asAgent();
    expect(removeLanePage(env.vault, at(env, rel))).toBe(true);
    expect({
      present: lanePageExists(env.vault, at(env, rel)),
      standing: standingOf(env, rel),
    }).toEqual({ present: false, standing: HUMAN_TOMBSTONE });
  });

  test("(e) a moveLanePage at mcp-tool of a cli entry is gone at the source and present at the destination", () => {
    env = switchedMachine("osb-lane-standing-e-");
    const from = "Brain/decisions/zq-standing-e.md";
    const to = "Brain/decisions/zq-standing-e-moved.md";
    asOperator();
    writeLaneText(env.vault, at(env, from), note("Operator text."));
    asAgent();
    moveLanePage(env.vault, at(env, from), at(env, to));
    expect({
      source: lanePageExists(env.vault, at(env, from)),
      destination: readLaneText(env.vault, at(env, to)),
      tombstone: standingOf(env, from),
      moved: standingOf(env, to),
    }).toEqual({
      source: false,
      destination: note("Operator text."),
      tombstone: HUMAN_TOMBSTONE,
      moved: HUMAN_KEPT,
    });
  });

  test("(f) a moveLaneTree at mcp-tool of a folder holding a cli entry keeps its standing", () => {
    env = switchedMachine("osb-lane-standing-f-move-");
    const from = "Brain/decisions/zq-tree-f";
    const to = "Brain/decisions/zq-tree-f-moved";
    asOperator();
    writeLaneText(env.vault, at(env, `${from}/member.md`), note("Operator text."));
    asAgent();
    moveLaneTree(env.vault, at(env, from), at(env, to));
    expect({
      source: lanePageExists(env.vault, at(env, `${from}/member.md`)),
      destination: readLaneText(env.vault, at(env, `${to}/member.md`)),
      tombstone: standingOf(env, `${from}/member.md`),
      moved: standingOf(env, `${to}/member.md`),
    }).toEqual({
      source: false,
      destination: note("Operator text."),
      tombstone: HUMAN_TOMBSTONE,
      moved: HUMAN_KEPT,
    });
  });

  test("(f) a removeLaneTree at mcp-tool of a folder holding a cli entry keeps its standing", () => {
    env = switchedMachine("osb-lane-standing-f-remove-");
    const dir = "Brain/decisions/zq-tree-f-gone";
    asOperator();
    writeLaneText(env.vault, at(env, `${dir}/member.md`), note("Operator text."));
    asAgent();
    removeLaneTree(env.vault, at(env, dir));
    expect({
      present: lanePageExists(env.vault, at(env, `${dir}/member.md`)),
      tombstone: standingOf(env, `${dir}/member.md`),
    }).toEqual({ present: false, tombstone: HUMAN_TOMBSTONE });
  });

  test("(g) a lane-entry record with acted_by folds with the same value as one without", () => {
    const body = { lane: "obligations", entry: "obl-a", fields: { s: 1 }, text: "Same." };
    const plain = rec({ physical: 10, kind: LANE_ENTRY_KIND, body: authored("human", body) });
    const marked = rec({
      physical: 10,
      kind: LANE_ENTRY_KIND,
      body: authored("human", { ...body, acted_by: "agent" }),
    });
    expect(foldLaneEntries([marked]).rejected).toEqual([]);
    expect(foldedValue(marked)).toEqual(foldedValue(plain)!);
  });

  test("(n) a create over a cli removal keeps the removal's standing", () => {
    env = switchedMachine("osb-lane-standing-n-");
    const rel = "Brain/decisions/zq-standing-n.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Operator text."));
    removeLanePage(env.vault, at(env, rel));
    const read = storeEntryRead(env.vault, at(env, rel));
    asAgent();
    writeLaneText(env.vault, at(env, rel), note("Agent text."), { exclusive: true });
    expect({
      removed: (read as { removed?: boolean }).removed,
      authority: read.authority,
      text: readLaneText(env.vault, at(env, rel)),
      standing: standingOf(env, rel),
    }).toEqual({
      removed: true,
      authority: "human",
      text: note("Agent text."),
      standing: HUMAN_KEPT,
    });
  });

  test("(o) a move at mcp-tool onto a path a cli entry holds keeps that entry's standing", () => {
    env = switchedMachine("osb-lane-standing-o-");
    const from = "Brain/decisions/zq-standing-o.md";
    const to = "Brain/decisions/zq-standing-o-held.md";
    asAgent();
    writeLaneText(env.vault, at(env, from), note("Agent text."));
    asOperator();
    writeLaneText(env.vault, at(env, to), note("Operator text."));
    asAgent();
    moveLanePage(env.vault, at(env, from), at(env, to));
    expect({
      source: lanePageExists(env.vault, at(env, from)),
      destination: readLaneText(env.vault, at(env, to)),
      moved: standingOf(env, to)["authority"],
    }).toEqual({ source: false, destination: note("Agent text."), moved: "human" });
  });

  test("(p) a raise to private at mcp-tool over a cli shared entry writes its shared tombstone at human", () => {
    env = switchedMachine("osb-lane-standing-p-");
    const rel = "Brain/decisions/zq-standing-p.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Operator text."));
    asAgent();
    writeLaneText(
      env.vault,
      at(env, rel),
      "---\nkind: note\nvisibility: private\n---\n\nAgent text.\n",
    );
    const sharedTombstones = laneRecords(env, "shared").filter(
      (r) =>
        r.kind === LANE_ENTRY_REMOVE_KIND &&
        laneEntryKey(String(r.body["lane"]), String(r.body["entry"])) === keyOf(rel),
    );
    expect(sharedTombstones.map((r) => r.body["authority"])).toEqual(["human"]);
  });
});

describe("versions written apart on two devices are arbitrated by authority, then clock", () => {
  test("(r) another device's human version stamped between the two writes loses to the kept rewrite", () => {
    env = switchedMachine("osb-lane-standing-r-");
    const rel = "Brain/decisions/zq-standing-r.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Operator text."));
    const first = clockOf(env, rel);
    Bun.sleepSync(5);
    asAgent();
    writeLaneText(env.vault, at(env, rel), note("Agent text."));
    const second = clockOf(env, rel);
    expect(second).toBeGreaterThan(first + 1);
    deliveredVersion(env, rel, first + 1, "Other device text.\n");
    expect(laneRecords(env).some((r) => r.body["text"] === "Other device text.\n")).toBe(true);
    expect(readLaneText(env.vault, at(env, rel))).toBe(note("Agent text."));
  });

  test("(s) another device's human version stamped after the rewrite wins", () => {
    env = switchedMachine("osb-lane-standing-s-");
    const rel = "Brain/decisions/zq-standing-s.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Operator text."));
    asAgent();
    writeLaneText(env.vault, at(env, rel), note("Agent text."));
    const second = clockOf(env, rel);
    otherDeviceVersion(env, rel, second + 1000, "Other device text.\n");
    expect(readLaneText(env.vault, at(env, rel))).toContain("Other device text.");
  });
});

/**
 * Make the lane fold miss a record: a peer's `events` shard this machine
 * has read, then gone (as the restamp's store-only test does for its
 * "could not be read in full" case). The lane fold reads the shard too
 * before it goes, so a fold cached before the gap is rebuilt after it.
 */
function openGap(e: StoreEnv): void {
  const peerShard = appendRecord(openStore({ root: e.storeRoot, device: "dev-b" }), {
    partition: "shared",
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    agent: "u",
    body: { authority: "human", signal: "sig-elsewhere", fields: { topic: "elsewhere" } },
  }).path;
  readStoreEntities();
  wholeLaneStoreFold();
  rmSync(peerShard);
}

/** What `fn` throws, or null. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** The ids of every lane record of the store, sorted. */
function laneRecordIds(e: StoreEnv): string {
  return JSON.stringify(
    laneRecords(e)
      .map((r) => r.id)
      .toSorted(),
  );
}

describe("a read-modify-write is refused visibly when the entry changed since its base", () => {
  test("(h) a version written after the base is refused as changed, and the entry keeps it", () => {
    env = switchedMachine("osb-lane-standing-h-");
    const rel = "Brain/decisions/zq-standing-h.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("First text."));
    const base = readLaneBase(env.vault, at(env, rel));
    writeLaneText(env.vault, at(env, rel), note("Second text."));
    asAgent();
    const err = thrownBy(() =>
      writeLaneText(env!.vault, at(env!, rel), note("Agent text."), { replaces: base }),
    );
    expect({
      changed: err instanceof LaneEntryChangedError,
      reason: (err as LaneEntryChangedError | null)?.reason,
      storeError: err instanceof StoreWriteError,
      readAgain: String((err as Error | null)?.message).includes("read it again"),
      doctor: String((err as Error | null)?.message).includes("o2b brain doctor"),
      text: readLaneText(env.vault, at(env, rel)),
    }).toEqual({
      changed: true,
      reason: "changed",
      storeError: false,
      readAgain: true,
      doctor: false,
      text: note("Second text."),
    });
  });

  test("(i) a base read while the fold may miss a record is refused as incomplete, nothing written", () => {
    env = switchedMachine("osb-lane-standing-i-");
    const rel = "Brain/decisions/zq-standing-i.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("First text."));
    openGap(env);
    const base = readLaneBase(env.vault, at(env, rel));
    expect(base?.whole).toBe(false);
    const before = laneRecordIds(env);
    asAgent();
    const err = thrownBy(() =>
      writeLaneText(env!.vault, at(env!, rel), note("Agent text."), { replaces: base }),
    );
    expect({
      changed: err instanceof LaneEntryChangedError,
      reason: (err as LaneEntryChangedError | null)?.reason,
      doctor: String((err as Error | null)?.message).includes("o2b brain doctor"),
      unchanged: laneRecordIds(env) === before,
    }).toEqual({ changed: true, reason: "incomplete", doctor: true, unchanged: true });
  });

  test("(i2) a gap that opens after a whole base is refused as incomplete, not changed", () => {
    env = switchedMachine("osb-lane-standing-i2-");
    const rel = "Brain/decisions/zq-standing-i2.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("First text."));
    const base = readLaneBase(env.vault, at(env, rel));
    expect(base?.whole).toBe(true);
    openGap(env);
    const before = laneRecordIds(env);
    asAgent();
    const err = thrownBy(() =>
      writeLanePage(env!.vault, at(env!, rel), { kind: "note" }, "Agent text.\n", {
        overwrite: true,
        replaces: base,
      }),
    );
    expect({
      changed: err instanceof LaneEntryChangedError,
      reason: (err as LaneEntryChangedError | null)?.reason,
      unchanged: laneRecordIds(env) === before,
    }).toEqual({ changed: true, reason: "incomplete", unchanged: true });
  });

  test("(j) a null base on a switched machine changes nothing", () => {
    env = switchedMachine("osb-lane-standing-j-");
    const rel = "Brain/decisions/zq-standing-j.md";
    asAgent();
    expect(readLaneBase(env.vault, at(env, rel))).toBeNull();
    writeLaneText(env.vault, at(env, rel), note("Agent text."), { replaces: null });
    expect(readLaneText(env.vault, at(env, rel))).toBe(note("Agent text."));
  });

  test("(j) on a machine that has not switched there is no base and the file is written", () => {
    env = makeStoreEnv("osb-lane-standing-j-legacy-");
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({ storeOnly: false });
    const rel = "Brain/decisions/zq-standing-j-legacy.md";
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Operator text."));
    const base = readLaneBase(env.vault, at(env, rel));
    asOperator();
    writeLaneText(env.vault, at(env, rel), note("Second text."));
    asAgent();
    writeLaneText(env.vault, at(env, rel), note("Agent text."), { replaces: base });
    expect({
      base,
      file: existsSync(at(env, rel)) ? readFileSync(at(env, rel), "utf8") : null,
    }).toEqual({ base: null, file: note("Agent text.") });
  });
});

/** A stamp further ahead of this machine's clock than the clock accepts. */
function farAhead(): number {
  return Date.now() + HLC_MAX_DRIFT_MS + 60 * 60 * 1000;
}

/** A `human` removal of the lane path `rel` written on another device at `ms`. */
function otherDeviceRemoval(e: StoreEnv, rel: string, ms: number): void {
  const place = lanePlaceOf(rel.replace(/^Brain\//u, ""))!;
  write(openStore({ root: e.storeRoot, device: "dev-b" }), ms, LANE_ENTRY_REMOVE_KIND, {
    authority: "human",
    lane: place.lane,
    entry: place.entry,
  });
}

/** The fields of a `LaneWriteNotAppliedError` a call threw, or what it threw instead. */
function notApplied(fn: () => unknown): Record<string, unknown> {
  const err = thrownBy(fn);
  if (!(err instanceof LaneWriteNotAppliedError)) {
    return { thrown: err === null ? "none" : `${(err as Error).name}: ${(err as Error).message}` };
  }
  return {
    heldBy: err.heldBy,
    removed: err.removed,
    storeError: (err as unknown) instanceof StoreWriteError,
    message: err.message,
  };
}

describe("a write the store does not apply fails visibly", () => {
  test("(k) a rewrite under a human version stamped far ahead names that version", () => {
    env = switchedMachine("osb-lane-standing-k-");
    const rel = "Brain/decisions/zq-standing-k.md";
    otherDeviceVersion(env, rel, farAhead(), "Ahead text.\n");
    asAgent();
    const outcome = notApplied(() => writeLaneText(env!.vault, at(env!, rel), note("Agent text.")));
    expect(outcome).toMatchObject({ heldBy: "human", removed: false, storeError: false });
    expect(String(outcome["message"])).toContain("a version written at authority human");
    expect(readLaneText(env.vault, at(env, rel))).toContain("Ahead text.");
  });

  test("(l) a removal under a human version stamped far ahead names that version", () => {
    env = switchedMachine("osb-lane-standing-l-");
    const rel = "Brain/decisions/zq-standing-l.md";
    otherDeviceVersion(env, rel, farAhead(), "Ahead text.\n");
    asAgent();
    const outcome = notApplied(() => removeLanePage(env!.vault, at(env!, rel)));
    expect(outcome).toMatchObject({ heldBy: "human", removed: false, storeError: false });
    expect(String(outcome["message"])).toContain("a version written at authority human");
    expect(lanePageExists(env.vault, at(env, rel))).toBe(true);
  });

  test("(n2) a create under a human removal stamped far ahead names the removal", () => {
    env = switchedMachine("osb-lane-standing-n2-");
    const rel = "Brain/decisions/zq-standing-n2.md";
    otherDeviceRemoval(env, rel, farAhead());
    asAgent();
    const outcome = notApplied(() =>
      writeLaneText(env!.vault, at(env!, rel), note("Agent text."), { exclusive: true }),
    );
    expect(outcome).toMatchObject({ heldBy: "human", removed: true, storeError: false });
    expect(String(outcome["message"])).toContain("a removal written at authority human");
    expect(lanePageExists(env.vault, at(env, rel))).toBe(false);
  });

  test("(m) on a machine that has not switched no read-back runs", () => {
    env = makeStoreEnv("osb-lane-standing-m-");
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({ storeOnly: false });
    const rel = "Brain/decisions/zq-standing-m.md";
    otherDeviceVersion(env, rel, farAhead(), "Ahead text.\n");
    asAgent();
    writeLaneText(env.vault, at(env, rel), note("Agent text."));
    expect(readFileSync(at(env, rel), "utf8")).toBe(note("Agent text."));
  });
});

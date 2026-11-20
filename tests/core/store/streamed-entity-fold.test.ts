/**
 * The entity fold read record by record (`store-entities.ts`: only the
 * entity kinds kept, through kept tails) folds to exactly what a fold of
 * every shard read whole folds to, on a mixed store: conflicting versions
 * of one preference from two devices, a removal, evidence, signals in both
 * partitions with state moves and a tombstone, the pinned context, records
 * no entity fold reads, a pending body and quarantined lines; and still
 * after more appends (this process's own, another device's, and bytes a
 * sync tool wrote) are read through the kept tails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { appendRecord, type AppendInput } from "../../../src/core/store/appender.ts";
import type { StorePartition } from "../../../src/core/store/constants.ts";
import { buildRecord, type StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldPinned } from "../../../src/core/store/fold-pinned.ts";
import { foldPreferences } from "../../../src/core/store/fold-preferences.ts";
import { foldSignals } from "../../../src/core/store/fold-signals.ts";
import {
  holdStoreEntities,
  readEntitiesOf,
  type StoreEntities,
} from "../../../src/core/store/read/store-entities.ts";
import { readShard } from "../../../src/core/store/reader.ts";
import { addQuarantine } from "../../../src/core/store/shard-quarantine-write.ts";
import { lineSha256At } from "../../../src/core/store/shard-quarantine.ts";
import { listShards } from "../../../src/core/store/shard-list.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { inspectStore, openStore } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const T0 = Date.UTC(2026, 10, 3, 9);
let tick = 0;

function put(
  e: StoreEnv,
  device: string,
  partition: StorePartition,
  kind: string,
  body: Record<string, unknown>,
): string {
  tick += 1;
  const input: AppendInput = { partition, stream: "events", kind, agent: "t", body };
  return appendRecord(openStore({ root: e.storeRoot, device }), input, {
    now: () => T0 + tick * 1000,
  }).path;
}

const human = { authority: "human" };

/** The mixed store; returns the path of dev-b's shared events shard. */
function mixedStore(e: StoreEnv): string {
  // Two devices set one preference: conflicting versions of one id.
  put(e, "dev-a", "shared", "preference-set", {
    ...human,
    preference: "pref-one",
    fields: { title: "from a", status: "active" },
  });
  const devB = put(e, "dev-b", "shared", "preference-set", {
    ...human,
    preference: "pref-one",
    fields: { title: "from b" },
  });
  put(e, "dev-a", "shared", "preference-evidence", {
    preference: "pref-one",
    result: "applied",
  });
  put(e, "dev-a", "private", "preference-evidence", {
    preference: "pref-one",
    result: "violated",
  });
  put(e, "dev-a", "shared", "preference-set", {
    ...human,
    preference: "pref-two",
    fields: { title: "two" },
  });
  put(e, "dev-b", "shared", "preference-remove", { ...human, preference: "pref-two" });
  put(e, "dev-a", "private", "preference-set", {
    ...human,
    preference: "pref-secret",
    fields: { title: "secret" },
  });
  // Signals in both partitions, moved, patched and forgotten.
  put(e, "dev-a", "shared", "signal", { ...human, id: "sig-one", frontmatter: { tags: [] } });
  put(e, "dev-b", "shared", "signal-state", { ...human, signal: "sig-one", state: "consumed" });
  put(e, "dev-a", "shared", "signal-state", {
    ...human,
    signal: "sig-one",
    fields: { note: "kept" },
  });
  put(e, "dev-a", "private", "signal", { ...human, id: "sig-private", frontmatter: {} });
  put(e, "dev-a", "shared", "signal", { ...human, id: "sig-gone", frontmatter: {} });
  put(e, "dev-b", "shared", "signal-removed", { ...human, signal: "sig-gone" });
  put(e, "dev-a", "shared", "pinned-set", { ...human, content: "pinned text" });
  // Records no entity fold reads.
  for (let n = 0; n < 5; n++) put(e, "dev-a", "shared", "note", { n });
  put(e, "dev-b", "shared", "correction", { ...human, target: "x" });
  // A pending body: a capture spilled to a blob that has not arrived,
  // quarantined as such, and a corrupt line, quarantined.
  const spilled = put(e, "dev-b", "shared", "signal", {
    ...human,
    id: "sig-big",
    frontmatter: { text: "x".repeat(40_000) },
  });
  const blobs = join(partitionDir(e.storeRoot, "shared"), "blobs");
  rmSync(blobs, { recursive: true, force: true });
  put(e, "dev-b", "shared", "note", { n: 99 });
  quarantineLine(e, spilled, "blob-pending", (l) => l.includes('"__blob"') || l.includes("blob"));
  quarantineLine(e, devB, "corrupt-line", (l) => l.includes('"n":99'), true);
  return devB;
}

/** Quarantine the first line of `path` `match` passes; `corrupt` breaks it first. */
function quarantineLine(
  e: StoreEnv,
  path: string,
  kind: "corrupt-line" | "blob-pending",
  match: (line: string) => boolean,
  corrupt = false,
): void {
  const root = partitionDir(e.storeRoot, "shared");
  const lines = readFileSync(path, "utf8").split("\n");
  const index = lines.findIndex(match);
  expect(index).toBeGreaterThanOrEqual(0);
  if (corrupt) {
    lines[index] = lines[index]!.replace('"n":99', '"n":98');
    writeFileSync(path, lines.join("\n"));
  }
  const offset = lines.slice(0, index).reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0);
  addQuarantine(e.storeRoot, {
    partition: "shared",
    shard: relative(root, path).split("\\").join("/"),
    offset,
    sha256: lineSha256At(path, offset, root)!,
    kind,
    reason: "test",
  });
}

/** Every record of every `events` shard, each shard read whole, pending bodies left out. */
function wholeShardRecords(e: StoreEnv): Map<StorePartition, StoreRecord[]> {
  const out = new Map<StorePartition, StoreRecord[]>();
  for (const partition of ["shared", "private"] as const) {
    const root = partitionDir(e.storeRoot, partition);
    const records: StoreRecord[] = [];
    for (const shard of listShards(root, { stream: "events" })) {
      for (const r of readShard(shard.path, { partitionRoot: root }).records) {
        if (r.bodyState !== "pending") records.push(r.record);
      }
    }
    out.set(partition, records);
  }
  return out;
}

const ids = (records: ReadonlyArray<StoreRecord>): string[] => records.map((r) => r.id);

/** The streamed entities against the folds of the whole-shard read. */
function expectSameFolds(e: StoreEnv, entities: StoreEntities): void {
  const whole = wholeShardRecords(e);
  const all = [...whole.values()].flat();
  const preferences = foldPreferences(all).preferences;
  expect([...entities.preferences.keys()].toSorted()).toEqual([...preferences.keys()].toSorted());
  for (const [id, state] of preferences) {
    const streamed = entities.preferences.get(id)!.state;
    expect(streamed.fields).toEqual(state.fields);
    expect(streamed.removed).toEqual(state.removed);
    expect(ids(streamed.history)).toEqual(ids(state.history));
  }
  const signals = foldSignals(all).signals;
  expect([...entities.signals.keys()].toSorted()).toEqual([...signals.keys()].toSorted());
  for (const [id, entry] of signals) {
    const streamed = entities.signals.get(id)!;
    expect(streamed.state).toEqual(entry.state);
    expect(streamed.frontmatter).toEqual(entry.frontmatter);
    expect(ids(streamed.history)).toEqual(ids(entry.history));
  }
  for (const [partition, records] of whole) {
    expect(entities.pinned.get(partition)).toEqual(foldPinned(records));
  }
}

describe("the streamed entity fold", () => {
  test("folds as the whole-shard fold on a mixed store, and through kept tails after appends", () => {
    env = makeStoreEnv("osb-streamed-fold-", { legacyTree: false });
    const devB = mixedStore(env);
    const store = inspectStore(env.storeRoot)!;
    const first = readEntitiesOf(store);
    expect(first.unreadable).toEqual([]);
    expect(first.preferences.get("pref-one")!.state.fields["title"]).toBe("from b");
    expect(first.preferences.get("pref-secret")!.private).toBe(true);
    expect(first.signals.get("sig-private")!.private).toBe(true);
    expect(first.signals.get("sig-one")!.private).toBe(false);
    expect(first.signals.has("sig-big")).toBe(false);
    expectSameFolds(env, first);

    // This process's appends, another device's, and a synced copy's bytes.
    put(env, "dev-a", "shared", "preference-set", {
      ...human,
      preference: "pref-one",
      fields: { title: "from a again" },
    });
    put(env, "dev-b", "shared", "signal-state", { ...human, signal: "sig-one", state: "archived" });
    put(env, "dev-a", "private", "pinned-set", { ...human, content: "private pin" });
    // A record dev-b wrote elsewhere, its line delivered by a sync tool.
    const elsewhere = makeStoreEnv("osb-streamed-fold-b-", { legacyTree: false });
    let line: string;
    try {
      const path = put(elsewhere, "dev-b", "shared", "signal-state", {
        ...human,
        signal: "sig-private",
        state: "consumed",
      });
      line = readFileSync(path, "utf8");
    } finally {
      elsewhere.cleanup();
    }
    appendFileSync(devB, line);
    const later = readEntitiesOf(inspectStore(env.storeRoot)!);
    expect(later.preferences.get("pref-one")!.state.fields["title"]).toBe("from a again");
    expect(later.signals.get("sig-one")!.state).toBe("archived");
    expect(later.signals.get("sig-private")!.state).toBe("consumed");
    expect(later.unreadable).toEqual([]);
    expectSameFolds(env, later);
  });

  test("a shard replaced under its name reads as the whole-shard fold of the new file", () => {
    env = makeStoreEnv("osb-streamed-fold-", { legacyTree: false });
    const devB = mixedStore(env);
    readEntitiesOf(inspectStore(env.storeRoot)!);
    const lines = readFileSync(devB, "utf8").split("\n");
    writeFileSync(`${devB}.new`, lines.filter((l) => !l.includes("signal-removed")).join("\n"));
    renameSync(`${devB}.new`, devB);
    expectSameFolds(env, readEntitiesOf(inspectStore(env.storeRoot)!));
  });
  test("a shard replaced by one of the same size and modification time is read again", () => {
    env = makeStoreEnv("osb-streamed-fold-", { legacyTree: false });
    const hlc = { physical: T0, counter: 0 };
    const pin = (content: string) =>
      `${JSON.stringify(
        buildRecord({
          hlc,
          device: "dev-b",
          agent: "t",
          kind: "pinned-set",
          scope: null,
          topic: null,
          body: { ...human, content },
        }),
      )}\n`;
    const first = pin("alpha");
    const second = pin("omega");
    expect(second.length).toBe(first.length);
    const path = put(env, "dev-b", "shared", "note", { n: 1 });
    writeFileSync(path, first);
    // A whole second, which every filesystem keeps exactly.
    const mtime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(path, mtime, mtime);
    const read = () => readEntitiesOf(inspectStore(env!.storeRoot)!).pinned.get("shared");
    expect(JSON.stringify(read())).toContain("alpha");
    writeFileSync(`${path}.new`, second);
    utimesSync(`${path}.new`, mtime, mtime);
    renameSync(`${path}.new`, path);
    expect(statSync(path).size).toBe(first.length);
    expect(statSync(path).mtimeMs).toBe(mtime.getTime());
    expect(JSON.stringify(read())).toContain("omega");
  });
});

describe("entities held across this process's own writes", () => {
  test("a partition this machine comes to hold is read in, by the held read and the cache", () => {
    env = makeStoreEnv("osb-held-partitions-", { legacyTree: false, partitions: ["shared"] });
    put(env, "dev-a", "shared", "signal", { ...human, id: "sig-one", frontmatter: {} });
    const held = holdStoreEntities(env.configPath);
    expect(held.current()!.store.partitions.has("private")).toBe(false);
    expect(readEntitiesOf(inspectStore(env.storeRoot)!).store.partitions.has("private")).toBe(
      false,
    );
    // Its identity file arrives; it holds no events shard yet.
    initStore({ root: env.storeRoot, partitions: ["shared", "private"] });
    expect(held.current()!.store.partitions.has("private")).toBe(true);
    expect(readEntitiesOf(inspectStore(env.storeRoot)!).store.partitions.has("private")).toBe(true);
  });

  test("answer from the held read until another writer changes the store", () => {
    env = makeStoreEnv("osb-held-entities-", { legacyTree: false });
    put(env, "dev-a", "shared", "signal", { ...human, id: "sig-one", frontmatter: {} });
    const held = holdStoreEntities(env.configPath);
    const first = held.current()!;
    expect(first.signals.get("sig-one")!.state).toBe("active");
    // This process's own appends, a new shard among them: still held.
    put(env, "dev-a", "shared", "signal-state", { ...human, signal: "sig-one", state: "consumed" });
    put(env, "dev-a", "private", "note", { n: 1 });
    expect(held.current()).toBe(first);
    // Another writer's line, delivered by a sync tool: read again.
    const elsewhere = makeStoreEnv("osb-held-entities-b-", { legacyTree: false });
    let line: string;
    let rel: string;
    try {
      const path = put(elsewhere, "dev-c", "shared", "signal", {
        ...human,
        id: "sig-two",
        frontmatter: {},
      });
      line = readFileSync(path, "utf8");
      rel = relative(elsewhere.storeRoot, path);
    } finally {
      elsewhere.cleanup();
    }
    const target = join(env.storeRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, line);
    const later = held.current()!;
    expect(later).not.toBe(first);
    expect(later.signals.get("sig-one")!.state).toBe("consumed");
    expect(later.signals.has("sig-two")).toBe(true);
  });
});

/**
 * A read bounded by recorded positions (dream replay design D3, "The read
 * path this needs"): `readStreamRecords` with `until` returns nothing
 * beyond a shard's limit and nothing of a shard the boundary does not
 * name; `readStoreEntities` and `readStoreLogEvents` pass the boundary
 * through; a bounded entity read neither answers from nor replaces the
 * cached read other readers rely on.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { appendRecord, type AppendInput } from "../../../src/core/store/appender.ts";
import { readStoreLogEvents } from "../../../src/core/store/read/log-events.ts";
import { readShardsFrom, untilOf } from "../../../src/core/store/read/shards-from.ts";
import { readStoreEntities } from "../../../src/core/store/read/store-entities.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const NOV = Date.UTC(2026, 10, 6, 9);

function put(e: StoreEnv, input: Omit<AppendInput, "partition" | "agent">, device = "dev-b") {
  return appendRecord(
    openStore({ root: e.storeRoot, device }),
    { partition: "shared", agent: "t", ...input } as AppendInput,
    { now: () => NOV },
  ).path;
}

function preference(e: StoreEnv, id: string, device = "dev-b"): void {
  put(
    e,
    {
      stream: "events",
      kind: "preference-set",
      body: { authority: "human", preference: id, fields: { title: id, status: "active" } },
    },
    device,
  );
}

function logEvent(e: StoreEnv, n: number): void {
  put(e, {
    stream: "log",
    kind: "log-event",
    body: { timestamp: new Date(NOV).toISOString(), event_type: "note", body: { n: String(n) } },
  });
}

function boundary(e: StoreEnv, stream: "events" | "log") {
  const read = readShardsFrom({
    root: e.storeRoot,
    partitions: ["shared"],
    streams: [{ stream }],
    positions: [],
  });
  return read.shards.map((s) => s.position);
}

const context = (e: StoreEnv) => ({ vault: e.vault, storeOnly: { readSwitched: () => true } });

describe("a read with until", () => {
  test("readStreamRecords returns nothing beyond the limit", () => {
    env = makeStoreEnv("osb-until-stream-", { legacyTree: false });
    preference(env, "pref-a");
    const positions = boundary(env, "events");
    preference(env, "pref-b");
    preference(env, "pref-c", "dev-c");
    const until = untilOf(positions).get("shared")!;
    const read = readStreamRecords(env.storeRoot, "shared", { stream: "events" }, { until });
    expect(read.records.map((r) => r.body["preference"])).toEqual(["pref-a"]);
    expect(read.unreadable).toEqual([]);
    const whole = readStreamRecords(env.storeRoot, "shared", { stream: "events" });
    expect(whole.records.map((r) => r.body["preference"])).toEqual(["pref-a", "pref-b", "pref-c"]);
  });

  test("readStoreEntities with and without until do not share a cache entry", () => {
    env = makeStoreEnv("osb-until-entities-", { legacyTree: false });
    preference(env, "pref-a");
    const until = untilOf(boundary(env, "events"));
    preference(env, "pref-b");
    const cached = readStoreEntities(env.configPath)!;
    expect([...cached.preferences.keys()].toSorted()).toEqual(["pref-a", "pref-b"]);
    const bounded = readStoreEntities(env.configPath, { until })!;
    expect([...bounded.preferences.keys()]).toEqual(["pref-a"]);
    // The bounded read did not replace the cached one, nor answer from it.
    expect(readStoreEntities(env.configPath)).toBe(cached);
    const again = readStoreEntities(env.configPath, { until })!;
    expect(again).not.toBe(bounded);
    expect([...again.preferences.keys()]).toEqual(["pref-a"]);
    expect(readStoreEntities(env.configPath)).toBe(cached);
  });

  test("readStoreLogEvents passes the limit through", () => {
    env = makeStoreEnv("osb-until-log-", { legacyTree: false });
    logEvent(env, 1);
    const until = untilOf(boundary(env, "log"));
    logEvent(env, 2);
    const range = { from: "2026-11-01", to: "2026-11-30" };
    const all = readStoreLogEvents(range, context(env))!;
    expect(all.map((e) => e.entry.body["n"])).toEqual(["1", "2"]);
    const bounded = readStoreLogEvents(range, context(env), { until })!;
    expect(bounded.map((e) => e.entry.body["n"])).toEqual(["1"]);
  });
});

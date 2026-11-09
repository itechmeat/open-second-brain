/**
 * The shards this machine has seen (`seen-shards.ts`, design D14 fail
 * closed): a shard read before and gone now is named unreadable by the
 * stream reader and the partition reader, unless a compaction replaced it
 * or a human retired the device that wrote it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  appendDecisionLedger,
  queryDecisionLedger,
  type DecisionLedgerRow,
} from "../../../src/core/brain/permissions/ledger.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { COMPACTED_KIND, DEVICE_RETIRE_KIND } from "../../../src/core/store/constants.ts";
import { LedgerUnreadableError } from "../../../src/core/store/read/ledger-rows.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";
import { withoutSeenRecording } from "../../../src/core/store/seen-shards.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const NOV = Date.UTC(2026, 10, 6, 9);
const OCT = Date.UTC(2026, 9, 6, 9);

function note(e: StoreEnv, device: string, at = NOV): string {
  return appendRecord(
    openStore({ root: e.storeRoot, device }),
    { partition: "shared", stream: "events", kind: "note", agent: "t", body: { device } },
    { now: () => at },
  ).path;
}

const events = (e: StoreEnv, options = {}) =>
  readStreamRecords(e.storeRoot, "shared", { stream: "events" }, options);

function partitionUnreadable(e: StoreEnv): string[] {
  const out: string[] = [];
  readPartition(partitionDir(e.storeRoot, "shared"), { onUnreadable: ({ rel }) => out.push(rel) });
  return out;
}

describe("a shard this machine has seen", () => {
  test("gone now: the stream and partition readers name it, never read it as empty", () => {
    env = makeStoreEnv("osb-seen-gone-", { legacyTree: false });
    note(env, "dev-a");
    const peer = note(env, "dev-b");
    expect(events(env).unreadable).toEqual([]);
    rmSync(peer);
    const read = events(env);
    expect(read.unreadable).toEqual(["events/dev-b/2026-11.jsonl"]);
    expect(read.records).toHaveLength(1);
    expect(partitionUnreadable(env)).toEqual(["events/dev-b/2026-11.jsonl"]);
  });

  test("a read limited to a device or a month names only the shards it covers", () => {
    env = makeStoreEnv("osb-seen-scope-", { legacyTree: false });
    note(env, "dev-a");
    const old = note(env, "dev-b", OCT);
    events(env);
    rmSync(old);
    expect(events(env, { device: "dev-a" }).unreadable).toEqual([]);
    expect(events(env, { month: (m: string) => m === "2026-11" }).unreadable).toEqual([]);
    expect(events(env, { device: "dev-b" }).unreadable).toEqual(["events/dev-b/2026-10.jsonl"]);
  });

  test("never seen on this machine: an absent shard is just absent", () => {
    env = makeStoreEnv("osb-seen-never-", { legacyTree: false });
    const peer = note(env, "dev-b");
    rmSync(peer);
    expect(events(env).unreadable).toEqual([]);
  });

  test("a store created anew under the same root starts a fresh ledger", () => {
    env = makeStoreEnv("osb-seen-recreated-", { legacyTree: false });
    note(env, "dev-b");
    events(env);
    rmSync(env.storeRoot, { recursive: true, force: true });
    initStore({ root: env.storeRoot, partitions: ["shared", "private"] });
    expect(events(env).unreadable).toEqual([]);
  });
});

describe("a read-only surface", () => {
  test("records nothing, and still names a shard the ledger knows that is gone", () => {
    env = makeStoreEnv("osb-seen-readonly-", { legacyTree: false });
    const unseen = note(env, "dev-b");
    withoutSeenRecording(() => events(env!));
    rmSync(unseen);
    expect(events(env).unreadable).toEqual([]);
    const known = note(env, "dev-c");
    events(env);
    rmSync(known);
    expect(withoutSeenRecording(() => events(env!).unreadable)).toEqual([
      "events/dev-c/2026-11.jsonl",
    ]);
  });
});

describe("a shard removed on purpose is not reported", () => {
  test("every shard of a device a human retired", () => {
    env = makeStoreEnv("osb-seen-retired-", { legacyTree: false });
    const peer = note(env, "dev-b");
    events(env);
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: DEVICE_RETIRE_KIND,
      agent: "o2b",
      body: { authority: "human", device: "dev-b" },
    });
    rmSync(peer);
    expect(events(env).unreadable).toEqual([]);
    expect(partitionUnreadable(env)).toEqual([]);
  });

  test("a shard a compaction replaced", () => {
    env = makeStoreEnv("osb-seen-compacted-", { legacyTree: false });
    const old = note(env, "dev-b", OCT);
    events(env);
    appendRecord(
      openStore({ root: env.storeRoot, device: "dev-b" }),
      {
        partition: "shared",
        stream: "events",
        kind: COMPACTED_KIND,
        agent: "o2b",
        body: { replaces: ["events/dev-b/2026-10.jsonl"], into: ["events/dev-b/2026-11.jsonl"] },
      },
      { now: () => NOV },
    );
    rmSync(old);
    expect(events(env).unreadable).toEqual([]);
  });
});

describe("the decision ledger, an accountability ledger", () => {
  test("a shard of it gone since this machine read it throws, never reads as no decision", () => {
    env = makeStoreEnv("osb-seen-decisions-", { legacyTree: false, configureVault: false });
    const row: DecisionLedgerRow = {
      ts: "2026-11-06T10:00:00Z",
      actor: "codex",
      via: "token",
      action: "write",
      target: "notes/foo.md",
      verdict: "deny",
      source: "entry:freeze-notes",
      reason: "target-scoped entry freeze-notes",
    };
    expect(appendDecisionLedger(null, row)).toEqual({ logged: true });
    expect(queryDecisionLedger(null)).toHaveLength(1);
    const ledger = join(env.storeRoot, "private", "ledgers", "permissions");
    for (const device of readdirSync(ledger)) rmSync(join(ledger, device), { recursive: true });
    expect(() => queryDecisionLedger(null)).toThrow(LedgerUnreadableError);
  });
});

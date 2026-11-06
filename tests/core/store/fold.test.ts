/**
 * The fold engine and the concrete folds: duplicate delivery, fold order,
 * authority precedence, tombstones, kept history, derived counters and
 * the spec scenarios of the brain store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { prepareRecords } from "../../../src/core/store/fold.ts";
import { foldPinned } from "../../../src/core/store/fold-pinned.ts";
import {
  foldPreferences,
  preferencesFingerprint,
} from "../../../src/core/store/fold-preferences.ts";
import { canonicalJson } from "../../../src/core/integrity/digest.ts";
import { foldSettings, settingValue } from "../../../src/core/store/fold-settings.ts";
import { readShard } from "../../../src/core/store/reader.ts";
import { listShards } from "../../../src/core/store/shard-list.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { authored, rec } from "./fixtures/fold-records.ts";
import { makeTempStore, type TempStore } from "./fixtures/temp-store.ts";

const T = Date.UTC(2026, 10, 6, 12, 0, 0);

const prefSet = (
  device: string,
  physical: number,
  authority: "human" | "agent" | "model",
  fields: Record<string, unknown>,
  preference = "p1",
) =>
  rec({
    device,
    physical,
    kind: "preference-set",
    body: authored(authority, { preference, fields }),
  });

const fingerprint = (fold: ReturnType<typeof foldPreferences>): string =>
  canonicalJson(preferencesFingerprint(fold));

/** The folded topic-creation threshold of the settings shards in a partition. */
const threshold = (partitionRoot: string): unknown =>
  settingValue(
    foldSettings(
      listShards(partitionRoot, { stream: "settings" }).flatMap((shard) =>
        readShard(shard.path).records.map((r) => r.record),
      ),
    ),
    "topics.new_min_records",
  );

describe("prepareRecords", () => {
  test("applies a record delivered twice once, in fold order", () => {
    const a = rec({ device: "dev-b", physical: T + 2, kind: "x", body: {} });
    const b = rec({ device: "dev-a", physical: T + 2, kind: "x", body: {} });
    const c = rec({ device: "dev-c", physical: T + 1, kind: "x", body: {} });
    const prepared = prepareRecords([a, b, a, c, b]);
    expect(prepared.records.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(prepared.duplicates).toBe(2);
    expect(prepared.conflicts).toEqual([]);
  });

  test("keeps the same version of a conflicting id in any delivery order", () => {
    const first = rec({ physical: T, kind: "x", body: { n: 1 } });
    const second = { ...rec({ physical: T, kind: "x", body: { n: 2 } }), id: first.id };
    const one = prepareRecords([first, second]);
    const two = prepareRecords([second, first]);
    expect(one.records).toEqual(two.records);
    expect(one.conflicts).toEqual([{ id: first.id, versions: 2 }]);
  });

  test("a delivery that conflicts is a conflict, not also a duplicate", () => {
    const original = rec({ device: "dev-a", physical: T, kind: "x", body: { v: 1 } });
    const altered = { ...original, body: { v: 2 } };
    const prepared = prepareRecords([original, altered, original, altered]);
    expect(prepared.conflicts).toEqual([{ id: original.id, versions: 2 }]);
    // The third and fourth deliveries repeat a version already seen.
    expect(prepared.duplicates).toBe(2);
    expect(prepareRecords([original, altered]).duplicates).toBe(0);
  });

  test("holds out a record whose body is a pending blob", () => {
    const inline = rec({ physical: T, kind: "x", body: {} });
    const pending = {
      ...inline,
      id: rec({ physical: T + 1, kind: "x", body: {} }).id,
      body: { $blob: inline.sum, bytes: 2 },
    };
    const prepared = prepareRecords([inline, pending]);
    expect(prepared.records.map((r) => r.id)).toEqual([inline.id]);
    expect(prepared.pending.map((r) => r.id)).toEqual([pending.id]);
  });
});

describe("authority precedence", () => {
  test("a human record beats a later agent record, which beats a later model record", () => {
    const human = prefSet("dev-a", T, "human", { principle: "human" });
    const agent = prefSet("dev-b", T + 10, "agent", { principle: "agent", scope: "coding" });
    const model = prefSet("dev-c", T + 20, "model", { principle: "model", scope: "model" });
    const state = foldPreferences([model, agent, human]).preferences.get("p1")!;
    expect(state.fields).toEqual({ principle: "human", scope: "coding" });
    expect(state.fieldWinners).toEqual({ principle: human.id, scope: agent.id });
  });

  test("within one authority the later clock wins, the device breaking a clock tie", () => {
    const early = prefSet("dev-z", T, "agent", { principle: "early" });
    const tieLow = prefSet("dev-a", T + 5, "agent", { principle: "tie-a" });
    const tieHigh = prefSet("dev-b", T + 5, "agent", { principle: "tie-b" });
    for (const order of [
      [early, tieLow, tieHigh],
      [tieHigh, early, tieLow],
    ]) {
      expect(foldPreferences(order).preferences.get("p1")!.fields["principle"]).toBe("tie-b");
    }
  });

  test("a record without an authority is rejected, never guessed from the agent name", () => {
    const bad = rec({
      physical: T,
      agent: "human",
      kind: "preference-set",
      body: { preference: "p1", fields: { principle: "x" } },
    });
    const fold = foldPreferences([bad]);
    expect(fold.preferences.size).toBe(0);
    expect(fold.rejected).toEqual([
      { id: bad.id, kind: "preference-set", reason: "missing or invalid authority" },
    ]);
  });
});

describe("preference fold", () => {
  test("a human retire beats later agent evidence and a later agent re-confirm (spec scenario)", () => {
    const created = prefSet("dev-a", T, "agent", { principle: "use tabs", status: "confirmed" });
    const retire = prefSet("dev-a", T + 100, "human", {
      status: "retired",
      retired_reason: "user-rejected",
    });
    const evidence = rec({
      device: "dev-b",
      physical: T + 200,
      kind: "preference-evidence",
      body: { preference: "p1", result: "applied", artifact: "[[x]]" },
    });
    const reconfirm = prefSet("dev-b", T + 300, "agent", { status: "confirmed" });
    const state = foldPreferences([reconfirm, evidence, retire, created]).preferences.get("p1")!;
    expect(state.fields["status"]).toBe("retired");
    expect(state.counters.applied_count).toBe(1);
    expect(state.history.map((r) => r.id)).toEqual([
      created.id,
      retire.id,
      evidence.id,
      reconfirm.id,
    ]);
  });

  test("counters come from evidence only and are never written back", () => {
    const set = prefSet("dev-a", T, "human", {
      principle: "p",
      applied_count: 99,
      violated_count: 7,
    });
    const evidence = ["applied", "violated", "applied", "outdated"].map((result, i) =>
      rec({
        device: "dev-b",
        physical: T + i + 1,
        kind: "preference-evidence",
        body: { preference: "p1", result },
      }),
    );
    const state = foldPreferences([set, ...evidence, evidence[0]!]).preferences.get("p1")!;
    expect(state.counters).toEqual({ applied_count: 2, violated_count: 1, outdated_count: 1 });
    expect(state.fields).toEqual({ principle: "p" });
  });

  test("a removal is a tombstone that keeps the records and the last values", () => {
    const set = prefSet("dev-a", T, "agent", { principle: "p" });
    const remove = rec({
      physical: T + 1,
      kind: "preference-remove",
      body: authored("agent", { preference: "p1" }),
    });
    const state = foldPreferences([remove, set]).preferences.get("p1")!;
    expect(state).toMatchObject({
      exists: false,
      removed: true,
      fields: { principle: "p" },
      existenceWinner: remove.id,
    });
    expect(state.history.map((r) => r.id)).toEqual([set.id, remove.id]);
    const revived = prefSet("dev-a", T + 2, "agent", { principle: "q" });
    expect(foldPreferences([set, remove, revived]).preferences.get("p1")).toMatchObject({
      exists: true,
      removed: false,
    });
  });

  test("an agent removal does not remove a preference a human set", () => {
    const human = prefSet("dev-a", T, "human", { principle: "p" });
    const remove = rec({
      physical: T + 1,
      kind: "preference-remove",
      body: authored("agent", { preference: "p1" }),
    });
    expect(foldPreferences([human, remove]).preferences.get("p1")).toMatchObject({
      exists: true,
      removed: false,
    });
  });

  test("evidence alone does not make a preference exist", () => {
    const evidence = rec({
      physical: T,
      kind: "preference-evidence",
      body: { preference: "p9", result: "violated" },
    });
    expect(foldPreferences([evidence]).preferences.get("p9")).toMatchObject({
      exists: false,
      removed: false,
      existenceWinner: null,
      counters: { violated_count: 1 },
    });
  });

  test("a set that names only derived counters is rejected and cannot undo a removal", () => {
    const set = prefSet("dev-a", T, "agent", { status: "confirmed" });
    const remove = rec({
      device: "dev-a",
      physical: T + 1,
      kind: "preference-remove",
      body: authored("agent", { preference: "p1" }),
    });
    const countersOnly = prefSet("dev-a", T + 2, "human", { applied_count: 3 });
    const fold = foldPreferences([set, remove, countersOnly]);
    expect(fold.preferences.get("p1")!.exists).toBe(false);
    expect(fold.rejected).toEqual([
      { id: countersOnly.id, kind: "preference-set", reason: "fields name only derived counters" },
    ]);
  });

  test("a preference id that is an Object.prototype key still counts in the fingerprint", () => {
    const plain = foldPreferences([prefSet("dev-a", T, "human", { status: "confirmed" }, "p1")]);
    const withProto = foldPreferences([
      prefSet("dev-a", T, "human", { status: "confirmed" }, "p1"),
      prefSet("dev-a", T + 1, "human", { status: "confirmed" }, "__proto__"),
    ]);
    expect(fingerprint(withProto)).not.toBe(fingerprint(plain));
    expect(fingerprint(withProto)).toContain('"__proto__"');
  });

  test("malformed preference records are rejected", () => {
    const records = [
      rec({
        physical: T,
        kind: "preference-evidence",
        body: { preference: "p1", result: "maybe" },
      }),
      rec({
        physical: T + 1,
        kind: "preference-set",
        body: authored("agent", { preference: "p1", fields: {} }),
      }),
      rec({
        physical: T + 2,
        kind: "preference-set",
        body: authored("agent", { preference: "p1", fields: { "Bad-Name": 1 } }),
      }),
      rec({
        physical: T + 3,
        kind: "preference-remove",
        body: authored("agent", { preference: "" }),
      }),
    ];
    const fold = foldPreferences(records);
    expect(fold.preferences.size).toBe(0);
    expect(fold.rejected.map((r) => r.reason)).toEqual([
      "evidence result must be one of applied, violated, outdated",
      "fields must be a non-empty object",
      'invalid field name "Bad-Name"',
      "missing or invalid preference id",
    ]);
  });
});

describe("pinned context fold", () => {
  test("concurrent replacements: the later clock wins on every machine, the other stays in history (spec scenario)", () => {
    const fromA = rec({
      device: "dev-a",
      physical: T,
      kind: "pinned-set",
      body: authored("agent", { content: "from A" }),
    });
    const fromB = rec({
      device: "dev-b",
      physical: T + 3,
      kind: "pinned-set",
      body: authored("agent", { content: "from B" }),
    });
    const onA = foldPinned([fromA, fromB]);
    const onB = foldPinned([fromB, fromA]);
    expect(onA).toEqual(onB);
    expect(onA.content).toBe("from B");
    expect(onA.history.map((e) => e.value)).toEqual(["from A", "from B"]);
  });

  test("a clear is a tombstone; a later set pins again", () => {
    const set = rec({ physical: T, kind: "pinned-set", body: authored("agent", { content: "x" }) });
    const clear = rec({ physical: T + 1, kind: "pinned-clear", body: authored("agent", {}) });
    expect(foldPinned([set, clear])).toMatchObject({
      content: null,
      cleared: true,
      winner: clear.id,
    });
    const again = rec({
      physical: T + 2,
      kind: "pinned-set",
      body: authored("agent", { content: "y" }),
    });
    expect(foldPinned([again, clear, set])).toMatchObject({ content: "y", cleared: false });
  });

  test("a human pin survives a later agent replacement", () => {
    const human = rec({
      physical: T,
      kind: "pinned-set",
      body: authored("human", { content: "mine" }),
    });
    const agent = rec({
      physical: T + 1,
      kind: "pinned-set",
      body: authored("agent", { content: "agent" }),
    });
    expect(foldPinned([agent, human]).content).toBe("mine");
  });

  test("nothing pinned folds to an empty state", () => {
    expect(foldPinned([])).toEqual({
      content: null,
      cleared: false,
      winner: null,
      history: [],
      rejected: [],
    });
  });
});

describe("settings fold", () => {
  test("defaults apply until a key is set, and again after it is unset", () => {
    const set = rec({
      physical: T,
      kind: "setting-set",
      body: authored("human", { key: "topics.new_min_records", value: 8 }),
    });
    const unset = rec({
      physical: T + 1,
      kind: "setting-unset",
      body: authored("human", { key: "topics.new_min_records" }),
    });
    expect(settingValue(foldSettings([]), "topics.new_min_records")).toBe(5);
    expect(settingValue(foldSettings([set]), "topics.new_min_records")).toBe(8);
    expect(settingValue(foldSettings([unset, set]), "topics.new_min_records")).toBe(5);
    expect(settingValue(foldSettings([]), "topics.new_min_sessions")).toBe(2);
    expect(settingValue(foldSettings([]), "view.language")).toBeNull();
  });

  test("an invalid value for a known key is rejected; an unknown key is kept as written", () => {
    const records = [
      rec({
        physical: T,
        kind: "setting-set",
        body: authored("human", { key: "view.language", value: "ru" }),
      }),
      rec({
        physical: T + 1,
        kind: "setting-set",
        body: authored("human", { key: "view.language", value: "not a tag" }),
      }),
      rec({
        physical: T + 2,
        kind: "setting-set",
        body: authored("agent", { key: "view.writer", value: "Bad Device" }),
      }),
      rec({
        physical: T + 3,
        kind: "setting-set",
        body: authored("agent", { key: "future.knob", value: { a: 1 } }),
      }),
    ];
    const fold = foldSettings(records);
    expect(settingValue(fold, "view.language")).toBe("ru");
    expect(settingValue(fold, "view.writer")).toBeNull();
    expect(settingValue(fold, "future.knob")).toEqual({ a: 1 });
    expect(fold.rejected.map((r) => r.reason)).toEqual([
      "view.language must be a language tag such as en or pt-BR",
      "view.writer must be a device id",
    ]);
  });
});

describe("a setting changed on one machine applies on another (spec scenario)", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeTempStore("osb-store-fold-");
  });
  afterEach(() => tmp.cleanup());

  test("machine B folds machine A's threshold record once it has the shard", () => {
    const a = tmp.open("dev-a");
    // Machine B has its own copy of the shared partition, filled only by sync.
    const bShared = partitionDir(join(tmp.parent, "machine-b"), "shared");
    mkdirSync(bShared, { recursive: true });
    expect(threshold(bShared)).toBe(5);
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "settings",
        kind: "setting-set",
        agent: "cli",
        body: { authority: "human", key: "topics.new_min_records", value: 3 },
      },
      { now: () => T },
    );
    expect(threshold(partitionDir(tmp.root, "shared"))).toBe(3);
    // B still folds the default until the sync tool delivers A's shard.
    expect(threshold(bShared)).toBe(5);
    cpSync(join(partitionDir(tmp.root, "shared"), "settings"), join(bShared, "settings"), {
      recursive: true,
    });
    expect(threshold(bShared)).toBe(3);
  });
});

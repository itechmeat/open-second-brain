/**
 * Per-partition state digests over explicit cuts (task 1.7): publishers
 * converge on one cut, an injected fold difference is reported, an
 * offline device is silent and not divergent, a machine without the
 * private partition raises no false alarm, and retired devices leave the
 * roster.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StorePartition } from "../../../src/core/store/constants.ts";
import type { RecordBody } from "../../../src/core/store/envelope.ts";
import { checkStateDigests } from "../../../src/core/store/state-digest-check.ts";
import { compareDigests } from "../../../src/core/store/state-digest-compare.ts";
import {
  buildDigestBody,
  computeCut,
  publishStateDigest,
  readPartition,
} from "../../../src/core/store/state-digest.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeTempStore, type TempStore } from "./fixtures/temp-store.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const at = (ms: number) => () => ms;

function write(
  store: StoreHandle,
  ms: number,
  kind: string,
  body: RecordBody,
  partition: StorePartition = "shared",
  stream: "events" | "settings" = "events",
) {
  return appendRecord(store, { partition, stream, kind, agent: "agent-1", body }, { now: at(ms) });
}

function seedPreferences(
  a: StoreHandle,
  b: StoreHandle,
  ms: number,
  partition: StorePartition = "shared",
) {
  write(
    a,
    ms,
    "preference-set",
    { authority: "agent", preference: "p1", fields: { principle: "tabs" } },
    partition,
  );
  write(b, ms + 1, "preference-evidence", { preference: "p1", result: "applied" }, partition);
  write(b, ms + 2, "pinned-set", { authority: "agent", content: "task" }, partition);
}

function silentDevices(report: ReturnType<typeof checkStateDigests>): string[] {
  return report.findings.flatMap((f) => (f.kind === "silent" ? [f.device] : []));
}

describe("state digests", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeTempStore("osb-store-digest-");
  });
  afterEach(() => tmp.cleanup());

  test("two publishers converge on one identical cut, and their digests agree", () => {
    const a = tmp.open("dev-a");
    const b = tmp.open("dev-b");
    seedPreferences(a, b, NOW - 60_000);
    const fromA = publishStateDigest(a, { partition: "shared", agent: "doctor", now: at(NOW) });
    const fromB = publishStateDigest(b, { partition: "shared", agent: "doctor", now: at(NOW + 5) });
    expect(fromA.published && fromB.published).toBe(true);
    // B read A's digest before publishing; the digests stream is not in the cut.
    expect(fromB.body.cut).toEqual(fromA.body.cut);
    expect(fromB.body.cut_hash).toBe(fromA.body.cut_hash);
    expect(fromB.body.folds).toEqual(fromA.body.folds);
    expect(fromA.body.cut.map((e) => e.shard)).toEqual([
      "events/dev-a/2026-11.jsonl",
      "events/dev-b/2026-11.jsonl",
    ]);

    const report = checkStateDigests(a, { now: at(NOW + 10) });
    const shared = report.partitions.find((p) => p.partition === "shared")!;
    expect(shared.comparedCuts).toEqual([
      { cutHash: fromA.body.cut_hash, devices: ["dev-a", "dev-b"] },
    ]);
    expect(report.findings).toEqual([]);
  });

  test("an unchanged state is not republished within the interval, and is after it", () => {
    const a = tmp.open("dev-a");
    write(a, NOW - 1000, "pinned-set", { authority: "human", content: "x" });
    expect(
      publishStateDigest(a, { partition: "shared", agent: "doctor", now: at(NOW) }).published,
    ).toBe(true);
    const again = publishStateDigest(a, {
      partition: "shared",
      agent: "doctor",
      now: at(NOW + 1000),
    });
    expect(again).toMatchObject({ published: false, reason: "unchanged" });
    const later = publishStateDigest(a, {
      partition: "shared",
      agent: "doctor",
      now: at(NOW + 2 * DAY),
    });
    expect(later.published).toBe(true);
    if (later.published) expect(later.body.cut_hash).toBe(again.body.cut_hash);
  });

  test("an injected fold difference over the same cut is reported with both devices and the fold", () => {
    const a = tmp.open("dev-a");
    const b = tmp.open("dev-b");
    seedPreferences(a, b, NOW - 60_000);
    const good = publishStateDigest(a, { partition: "shared", agent: "doctor", now: at(NOW) });
    // dev-b runs a release whose preference fold differs: same cut, other hash.
    const wrong = { ...good.body, folds: { ...good.body.folds, preferences: "0".repeat(64) } };
    const bad = appendRecord(
      b,
      {
        partition: "shared",
        stream: "digests",
        kind: "state-digest",
        agent: "doctor",
        body: wrong,
      },
      { now: at(NOW + 5) },
    );

    for (const machine of [a, b]) {
      const report = checkStateDigests(machine, { now: at(NOW + 10) });
      expect(report.findings).toEqual([
        {
          kind: "divergent",
          partition: "shared",
          fold: "preferences",
          cutHash: good.body.cut_hash,
          devices: [
            {
              device: "dev-a",
              hash: good.body.folds.preferences,
              digest: good.published ? good.append.record.id : "",
            },
            { device: "dev-b", hash: "0".repeat(64), digest: bad.record.id },
          ],
        },
      ]);
    }
  });

  test("an offline device is reported as silent, never as divergent, and does not stall the others", () => {
    const a = tmp.open("dev-a");
    const b = tmp.open("dev-b");
    const laptop = tmp.open("laptop");
    // The laptop wrote and published two weeks ago, then went offline.
    write(laptop, NOW - 14 * DAY, "pinned-set", { authority: "agent", content: "old" });
    publishStateDigest(laptop, {
      partition: "shared",
      agent: "doctor",
      now: at(NOW - 14 * DAY + 10),
    });
    seedPreferences(a, b, NOW - 60_000);
    publishStateDigest(a, { partition: "shared", agent: "doctor", now: at(NOW) });
    publishStateDigest(b, { partition: "shared", agent: "doctor", now: at(NOW + 5) });

    const report = checkStateDigests(a, { now: at(NOW + 10) });
    const shared = report.partitions.find((p) => p.partition === "shared")!;
    expect(shared.roster.devices.map((d) => d.device)).toEqual(["dev-a", "dev-b", "laptop"]);
    expect(shared.comparedCuts.map((c) => c.devices)).toEqual([["dev-a", "dev-b"]]);
    expect(report.findings).toEqual([
      {
        kind: "silent",
        partition: "shared",
        device: "laptop",
        lastDigestMs: NOW - 14 * DAY + 10,
        lastRecordMs: NOW - 14 * DAY + 10,
      },
    ]);
  });

  test("a machine without the private partition raises no false alarm on either side", () => {
    const a = tmp.open("dev-a");
    const b = tmp.open("dev-b");
    seedPreferences(a, b, NOW - 60_000);
    seedPreferences(a, b, NOW - 30_000, "private");
    // The server syncs only shared: its store root holds no private folder.
    const serverRoot = join(tmp.parent, "server-store");
    cpSync(join(tmp.root, "shared"), join(serverRoot, "shared"), { recursive: true });
    const server = openStore({ root: serverRoot, device: "server", dirs: tmp.dirs("server") });
    expect([...server.partitions]).toEqual(["shared"]);

    for (const laptop of [a, b]) {
      publishStateDigest(laptop, { partition: "shared", agent: "doctor", now: at(NOW) });
      publishStateDigest(laptop, { partition: "private", agent: "doctor", now: at(NOW) });
    }
    // The laptops' shared digests reach the server; the server publishes its own.
    cpSync(join(tmp.root, "shared", "digests"), join(serverRoot, "shared", "digests"), {
      recursive: true,
    });
    const fromServer = publishStateDigest(server, {
      partition: "shared",
      agent: "doctor",
      now: at(NOW + 5),
    });
    cpSync(join(serverRoot, "shared", "digests"), join(tmp.root, "shared", "digests"), {
      recursive: true,
    });

    const onServer = checkStateDigests(server, { now: at(NOW + 10) });
    expect(onServer.skipped).toEqual(["private"]);
    expect(onServer.partitions.map((p) => p.partition)).toEqual(["shared"]);
    expect(onServer.partitions[0]!.comparedCuts).toEqual([
      { cutHash: fromServer.body.cut_hash, devices: ["dev-a", "dev-b", "server"] },
    ]);
    expect(onServer.findings).toEqual([]);

    const onLaptop = checkStateDigests(a, { now: at(NOW + 10) });
    const priv = onLaptop.partitions.find((p) => p.partition === "private")!;
    expect(priv.roster.devices.map((d) => d.device)).toEqual(["dev-a", "dev-b"]);
    expect(onLaptop.findings).toEqual([]);
  });

  test("a human device-retire record takes a device off the roster; an agent one does not", () => {
    const a = tmp.open("dev-a");
    const old = tmp.open("old-pc");
    write(old, NOW - 20 * DAY, "pinned-set", { authority: "agent", content: "x" });
    write(
      a,
      NOW - 1000,
      "device-retire",
      { authority: "agent", device: "old-pc" },
      "shared",
      "settings",
    );
    expect(silentDevices(checkStateDigests(a, { now: at(NOW) }))).toContain("old-pc");

    write(
      a,
      NOW - 500,
      "device-retire",
      { authority: "human", device: "old-pc" },
      "shared",
      "settings",
    );
    const report = checkStateDigests(a, { now: at(NOW) });
    const shared = report.partitions.find((p) => p.partition === "shared")!;
    expect(shared.roster.retired).toEqual(["old-pc"]);
    expect(silentDevices(report)).not.toContain("old-pc");

    // The retired id writes again after its retire record: back on the roster.
    write(old, NOW + 100, "pinned-set", { authority: "agent", content: "back" });
    const back = checkStateDigests(a, { now: at(NOW + 200) }).partitions.find(
      (p) => p.partition === "shared",
    )!;
    expect(back.roster.devices.map((d) => d.device)).toContain("old-pc");
  });

  test("devices outside the 30-day window are not on the roster; new devices get a grace period", () => {
    const a = tmp.open("dev-a");
    const gone = tmp.open("gone");
    write(gone, NOW - 40 * DAY, "pinned-set", { authority: "agent", content: "x" });
    write(a, NOW - 2 * DAY, "pinned-set", { authority: "agent", content: "y" });
    const report = checkStateDigests(a, { now: at(NOW) });
    const shared = report.partitions.find((p) => p.partition === "shared")!;
    expect(shared.roster.devices.map((d) => d.device)).toEqual(["dev-a"]);
    expect(report.findings).toEqual([]);
  });

  test("a torn tail is not part of the cut, and a pending blob is counted in it", () => {
    const a = tmp.open("dev-a");
    const first = write(a, NOW, "pinned-set", { authority: "agent", content: "x" });
    appendFileSync(first.path, '{"v":1,"id":"01K');
    const big = write(a, NOW + 1, "pinned-set", {
      authority: "agent",
      content: "y".repeat(20_000),
    });
    expect(big.spilled).toBe(true);
    const withBlob = computeCut(readPartition(partitionDir(tmp.root, "shared")));
    expect(withBlob).toEqual([{ shard: first.rel, count: 2, last: big.record.id, pending: 0 }]);

    // A machine that has the shard but not yet the blob has a different cut.
    const other = join(tmp.parent, "other");
    cpSync(join(tmp.root, "shared", "events"), join(other, "events"), { recursive: true });
    const shards = readPartition(other);
    expect(computeCut(shards)).toEqual([
      { shard: first.rel, count: 2, last: big.record.id, pending: 1 },
    ]);
    expect(buildDigestBody("shared", shards).cut_hash).not.toBe(
      buildDigestBody("shared", readPartition(partitionDir(tmp.root, "shared"))).cut_hash,
    );
  });

  test("machines that receive shards in different orders, some cut mid-line, reach one digest", () => {
    const writers = ["dev-a", "dev-b", "dev-c"].map((device) => tmp.open(device));
    writers.forEach((store, i) => {
      for (let n = 0; n < 5; n++) {
        const ms = NOW - 10_000 + n * 7 + i;
        write(store, ms, "preference-set", {
          authority: n % 2 === 0 ? "agent" : "model",
          preference: `p${n % 2}`,
          fields: { principle: `${store.device}-${n}` },
        });
        write(store, ms + 1, "pinned-set", { authority: "agent", content: `${store.device}-${n}` });
      }
    });
    const source = readPartition(partitionDir(tmp.root, "shared"));
    const deliver = (machine: string, order: number[], cutFirst: boolean) => {
      const root = join(tmp.parent, machine);
      for (const index of order) {
        const shard = source[index]!;
        const target = join(root, ...shard.rel.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        const bytes = readFileSync(join(partitionDir(tmp.root, "shared"), ...shard.rel.split("/")));
        // A sync tool still copying: the file ends mid-record first.
        if (cutFirst) writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
      }
      const early = buildDigestBody("shared", readPartition(root));
      for (const index of order) {
        const shard = source[index]!;
        cpSync(
          join(partitionDir(tmp.root, "shared"), ...shard.rel.split("/")),
          join(root, ...shard.rel.split("/")),
        );
      }
      return { early, final: buildDigestBody("shared", readPartition(root)) };
    };
    const one = deliver("machine-1", [0, 1, 2], true);
    const two = deliver("machine-2", [2, 0, 1], false);
    // Machine 2 had nothing before its copy: an empty cut, not a partial one.
    expect(two.early.cut).toEqual([]);
    const reference = buildDigestBody("shared", source);
    expect(one.early.cut_hash).not.toBe(reference.cut_hash);
    expect(one.final).toEqual(reference);
    expect(two.final).toEqual(reference);
  });

  test("digests of another partition and malformed digests are ignored", () => {
    const a = tmp.open("dev-a");
    write(a, NOW, "pinned-set", { authority: "agent", content: "x" });
    const body = publishStateDigest(a, {
      partition: "shared",
      agent: "doctor",
      now: at(NOW + 1),
    }).body;
    const records = readPartition(partitionDir(tmp.root, "shared")).flatMap((s) => s.all);
    const foreign = {
      ...records.at(-1)!,
      id: "01KZZZZZZZZZZZZZZZZZZZZZZZ",
      device: "dev-b",
      body: { ...body, partition: "private" },
    };
    const broken = {
      ...records.at(-1)!,
      id: "01KZZZZZZZZZZZZZZZZZZZZZZY",
      device: "dev-c",
      body: { partition: "shared" },
    };
    const result = compareDigests({
      partition: "shared",
      records: [...records, foreign, broken],
      retireRecords: [],
      nowMs: NOW + 2,
    });
    expect(result.comparedCuts).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});

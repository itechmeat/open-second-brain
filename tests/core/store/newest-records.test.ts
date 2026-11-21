/**
 * Each device's newest record, read without verifying every line, must be
 * exactly the record a fold of every record finds, on any store: the
 * cohort's removal gate reads it, and a short answer once let a live
 * device read as silent or as retired.
 *
 * The stores are generated, with every awkward shape a store can hold: an
 * empty newest shard, a newest shard that is a link or cannot be read, a
 * torn last line, lines out of clock order far past any window, records
 * near the line cap, spilled bodies and pending blobs, several shards per
 * month, devices whose clocks run years apart, a corrupt line, keys in
 * another order, a second `hlc` key. Where the fold itself cannot see a
 * shard, the read names the device as one it cannot tell for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { compareRecords, type StoreRecord } from "../../../src/core/store/envelope.ts";
import { newestRecordOfEachDevice } from "../../../src/core/store/newest-records.ts";
import { forEachPartitionRecord } from "../../../src/core/store/state-digest.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { CHMOD_CANNOT_DENY, IS_WINDOWS } from "../../helpers/platform.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | undefined;
const locked: string[] = [];
afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o644);
  env?.cleanup();
  env = undefined;
});

/** The newest record of each device, every record read: the fold. */
function folded(storeRoot: string): Map<string, StoreRecord> {
  const out = new Map<string, StoreRecord>();
  for (const partition of ["shared", "private"] as const) {
    forEachPartitionRecord(
      join(storeRoot, partition),
      { onUnreadable: () => {} },
      {
        record: (_shard, record) => {
          const seen = out.get(record.device);
          if (seen === undefined || compareRecords(record, seen) > 0) {
            out.set(record.device, record);
          }
        },
      },
    );
  }
  return out;
}

function expectEqualToFold(
  store: StoreHandle,
  storeRoot: string,
): ReturnType<typeof newestRecordOfEachDevice> {
  const read = newestRecordOfEachDevice(store);
  const fold = folded(storeRoot);
  expect([...read.newest.keys()].toSorted()).toEqual([...fold.keys()].toSorted());
  for (const [device, record] of fold) expect(read.newest.get(device)?.id).toBe(record.id);
  return read;
}

/** A line whose body no longer matches its checksum. */
function tamper(line: string): string {
  return line.replace('"body":{"text":"', '"body":{"text":"tampered ');
}

/** A seeded generator, so a failing store can be made again. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11"] as const;
const DAY = 86_400_000;

function shardDir(storeRoot: string, device: string, stream = "events"): string {
  return join(storeRoot, "shared", stream, device);
}

function shards(storeRoot: string, device: string, stream = "events"): string[] {
  const dir = shardDir(storeRoot, device, stream);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .toSorted()
    .map((name) => join(shardDir(storeRoot, device, stream), name));
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "");
}

/** Records for `device`, `count` per month over `months`, bodies of mixed size. */
function writeDevice(
  storeRoot: string,
  device: string,
  months: ReadonlyArray<string>,
  count: number,
  rand: () => number,
  skewMs = 0,
): StoreHandle {
  const store = openStore({ root: storeRoot, device });
  let tick = 0;
  for (const month of months) {
    const start = Date.parse(`${month}-02T00:00:00Z`) + skewMs;
    for (let i = 0; i < count; i += 1) {
      const size = rand() < 0.1 ? 15_000 : rand() < 0.05 ? 20_000 : Math.floor(rand() * 2000);
      tick += 1;
      appendRecord(
        store,
        {
          partition: rand() < 0.15 ? "private" : "shared",
          stream: rand() < 0.2 ? "log" : "events",
          kind: "note",
          agent: "t",
          body: { text: `${device} ${i} ${"x".repeat(size)}` },
        },
        { now: () => start + tick * 1000 },
      );
    }
  }
  return store;
}

describe("the shard-end read equals the fold", () => {
  // One store per case, each small: quick on every platform, and a failing
  // seed names itself.
  test.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    "generated store %i, every awkward shape mixed in",
    (seed) => {
      {
        const rand = prng(seed);
        env = makeStoreEnv(`osb-newest-gen-${seed}-`);
        const { storeRoot } = env;
        const devices = ["dev-a", "dev-b", "dev-c"];
        let store: StoreHandle | null = null;
        for (const [index, device] of devices.entries()) {
          const months = MONTHS.slice(Math.floor(rand() * 3));
          // dev-c runs years ahead of the others.
          const skew = index === 2 ? 900 * DAY : 0;
          const written = writeDevice(
            storeRoot,
            device,
            months,
            1 + Math.floor(rand() * 8),
            rand,
            skew,
          );
          store ??= written;
        }
        for (const device of devices) {
          const all = shards(storeRoot, device);
          if (all.length === 0) continue;
          const newest = all.at(-1)!;
          const roll = rand();
          if (roll < 0.15) {
            // An empty shard of a later month: a crash between open and write.
            writeFileSync(join(shardDir(storeRoot, device), "2029-12.jsonl"), "");
          } else if (roll < 0.3) {
            // A torn last line.
            appendFileSync(newest, '{"v":1,"id":"01M7');
          } else if (roll < 0.45) {
            // Every line in reverse: the greatest clock first, far from the end.
            const text = lines(newest).toReversed().join("\n") + "\n";
            writeFileSync(newest, text);
          } else if (roll < 0.55) {
            // A second shard of the month (a compaction output's name).
            copyFileSync(newest, newest.replace(/\.jsonl$/, ".c1.jsonl"));
          } else if (roll < 0.65) {
            // Keys in another order: valid JSON the reader accepts.
            const all2 = lines(newest);
            const parsed = JSON.parse(all2[0]!) as Record<string, unknown>;
            const reordered = Object.fromEntries(Object.entries(parsed).toReversed());
            writeFileSync(newest, [JSON.stringify(reordered), ...all2.slice(1)].join("\n") + "\n");
          } else if (roll < 0.75) {
            // A second hlc key: JSON keeps the later one, past every other clock
            // (a carriage return before its colon on odd seeds: JSON whitespace).
            const all2 = lines(newest);
            const first = all2[0]!;
            const key = seed % 2 === 0 ? '"hlc":' : '"hlc"\r:';
            all2[0] = first.slice(0, -1) + `,${key}"9999999999999.0"}`;
            writeFileSync(newest, all2.join("\n") + "\n");
          } else if (roll < 0.85) {
            // A pending blob: a spilled body whose blob has not arrived.
            for (const blobDir of [join(storeRoot, "shared", "blobs")]) {
              rmSync(blobDir, { recursive: true, force: true });
              mkdirSync(blobDir, { recursive: true });
            }
          }
        }
        expectEqualToFold(store!, storeRoot);
        env.cleanup();
        env = undefined;
      }
    },
  );

  test("an empty newest-month shard never hides a device's older records", () => {
    env = makeStoreEnv("osb-newest-empty-");
    const store = writeDevice(env.storeRoot, "dev-a", ["2026-10"], 5, prng(7));
    writeFileSync(join(shardDir(env.storeRoot, "dev-a"), "2026-11.jsonl"), "");
    const read = expectEqualToFold(store, env.storeRoot);
    expect(read.newest.has("dev-a")).toBe(true);
    expect(read.uncertain.has("dev-a")).toBe(false);
  });

  test.skipIf(IS_WINDOWS)(
    "a newest shard that is a link: the fold skips it, the read cannot tell",
    () => {
      env = makeStoreEnv("osb-newest-link-");
      const store = writeDevice(env.storeRoot, "dev-a", ["2026-10", "2026-11"], 5, prng(8));
      const newest = shards(env.storeRoot, "dev-a").at(-1)!;
      const aside = join(env.parent, "aside.jsonl");
      renameSync(newest, aside);
      symlinkSync(aside, newest);
      const read = expectEqualToFold(store, env.storeRoot);
      expect(read.uncertain.has("dev-a")).toBe(true);
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)("an unreadable newest shard: the read cannot tell", () => {
    env = makeStoreEnv("osb-newest-denied-");
    const store = writeDevice(env.storeRoot, "dev-a", ["2026-10", "2026-11"], 5, prng(9));
    const newest = shards(env.storeRoot, "dev-a").at(-1)!;
    chmodSync(newest, 0o000);
    locked.push(newest);
    const read = expectEqualToFold(store, env.storeRoot);
    expect(read.uncertain.has("dev-a")).toBe(true);
  });

  test("a rejected line: the read cannot tell when it may be the newest", () => {
    env = makeStoreEnv("osb-newest-corrupt-");
    const store = writeDevice(env.storeRoot, "dev-a", ["2026-11"], 8, prng(10));
    const path = shards(env.storeRoot, "dev-a").at(-1)!;
    // A line below the newest verified clock: the fold drops it too, and
    // it cannot be the device's newest record.
    const all = lines(path);
    all[1] = tamper(all[1]!);
    writeFileSync(path, all.join("\n") + "\n");
    expect(expectEqualToFold(store, env.storeRoot).uncertain.has("dev-a")).toBe(false);
    // The line with the greatest clock: the fold drops it and answers an
    // older record; the read gives the same answer and says it cannot tell.
    all[all.length - 1] = tamper(all.at(-1)!);
    writeFileSync(path, all.join("\n") + "\n");
    expect(expectEqualToFold(store, env.storeRoot).uncertain.has("dev-a")).toBe(true);
  });

  test.skipIf(IS_WINDOWS)("a special file under a shard name: the read cannot tell", () => {
    env = makeStoreEnv("osb-newest-fifo-");
    const store = writeDevice(env.storeRoot, "dev-a", ["2026-10"], 3, prng(12));
    const fifo = join(shardDir(env.storeRoot, "dev-a"), "2026-11.jsonl");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const read = expectEqualToFold(store, env.storeRoot);
    expect(read.uncertain.has("dev-a")).toBe(true);
  });

  test("a shard a verified compaction replaced is no gap", () => {
    env = makeStoreEnv("osb-newest-compacted-");
    const store = writeDevice(env.storeRoot, "dev-a", ["2026-10", "2026-11"], 3, prng(13));
    // Read once: this machine has now seen both shards.
    expect(newestRecordOfEachDevice(store).uncertain.has("dev-a")).toBe(false);
    const replaced = "events/dev-a/2026-10.jsonl";
    appendRecord(
      store,
      {
        partition: "shared",
        stream: "events",
        kind: "compacted",
        agent: "t",
        body: { replaces: [replaced], into: ["events/dev-a/2026-11.jsonl"] },
      },
      { now: () => Date.parse("2026-11-20T00:00:00Z") },
    );
    rmSync(join(env.storeRoot, "shared", ...replaced.split("/")));
    const read = expectEqualToFold(store, env.storeRoot);
    expect(read.uncertain.has("dev-a")).toBe(false);
  });

  test("a shard seen before and gone: the read cannot tell", () => {
    env = makeStoreEnv("osb-newest-gone-");
    const store = writeDevice(env.storeRoot, "dev-a", ["2026-10", "2026-11"], 5, prng(11));
    expect(newestRecordOfEachDevice(store).uncertain.has("dev-a")).toBe(false);
    rmSync(shards(env.storeRoot, "dev-a").at(-1)!);
    expect(newestRecordOfEachDevice(store).uncertain.has("dev-a")).toBe(true);
  });
});

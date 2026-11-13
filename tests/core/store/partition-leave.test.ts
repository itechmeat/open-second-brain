/**
 * Leaving a partition (design D7 of change `store-hardening`): the core
 * refuses what it cannot do safely, clears this machine's device-local
 * state of the partition, and a lost identity file fails closed until the
 * verb runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { processDirsEnv } from "../../../src/core/platform-dirs.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { digestCacheRoot } from "../../../src/core/brain/compiled-digest-path.ts";
import { deviceStateDirFor } from "../../../src/core/store/store-paths.ts";
import {
  isHeldPartitionMarked,
  recordHeldPartitions,
} from "../../../src/core/store/held-ledger.ts";
import {
  HeldPartitionLostError,
  openStore,
  readStoreId,
} from "../../../src/core/store/store-open.ts";
import { leavePartition, PartitionLeaveRefusal } from "../../../src/core/store/partition-leave.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { LOCAL_DEVICE, makeStoreIndexFixture } from "../search/fixtures/brain-store-index.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let parent: string;
afterEach(() => {
  if (parent !== undefined) rmSync(parent, { recursive: true, force: true });
});

/** A store with both partitions, opened by dev-a (its markers recorded device-locally). */
function storeUnder(): string {
  parent = mkdtempSync(join(tmpdir(), "osb-partition-leave-"));
  const root = join(parent, "store");
  initStore({ root });
  openStore({ root, device: "dev-a" });
  return root;
}

/** Run `fn`, expect a `PartitionLeaveRefusal`, return it. */
function refusalOf(fn: () => unknown): PartitionLeaveRefusal {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PartitionLeaveRefusal);
    return err as PartitionLeaveRefusal;
  }
  throw new Error("expected a PartitionLeaveRefusal, none was thrown");
}

describe("leaving a partition, the core", () => {
  test("refuses the shared partition", () => {
    const root = storeUnder();
    const err = refusalOf(() => leavePartition({ root, partition: "shared" }));
    expect(err.reason).toBe("shared");
  });

  test("a lost shared/store.json names only the restore, not the verb", () => {
    const root = storeUnder();
    rmSync(join(root, "shared"), { recursive: true, force: true });
    try {
      openStore({ root, device: "dev-a" });
      throw new Error("expected a HeldPartitionLostError, none was thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HeldPartitionLostError);
      const message = String((err as Error).message);
      expect(message).not.toContain("partition leave");
      expect(message).toContain("shared/store.json");
      expect(message).toContain("from sync or a backup");
    }
  });

  test("losing both partitions names only the restores, not the verb", () => {
    const root = storeUnder();
    rmSync(join(root, "shared"), { recursive: true, force: true });
    rmSync(join(root, "private"), { recursive: true, force: true });
    try {
      openStore({ root, device: "dev-a" });
      throw new Error("expected a HeldPartitionLostError, none was thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HeldPartitionLostError);
      const message = String((err as Error).message);
      // The leave verb reads the store id from shared/store.json before it
      // clears anything, so with shared lost it refuses with no-store-id
      // and changes nothing: only the restores can work.
      expect(message).not.toContain("partition leave");
      expect(message).toContain("shared/store.json");
      expect(message).toContain("private/store.json");
      expect(message).toContain("from sync or a backup");
    }
    expect(isHeldPartitionMarked(root, "private")).toBe(true);
  });

  test("refuses while private/store.json is present", () => {
    const root = storeUnder();
    const err = refusalOf(() => leavePartition({ root, partition: "private" }));
    expect(err.reason).toBe("still-held");
    // The file may have arrived by sync alone: the message must not claim
    // this machine holds the partition.
    expect(err.message).not.toContain("still holds");
  });

  test("a lost private/store.json without the verb still fails closed", () => {
    const root = storeUnder();
    rmSync(join(root, "private"), { recursive: true, force: true });
    expect(() => openStore({ root, device: "dev-a" })).toThrow(HeldPartitionLostError);
    try {
      openStore({ root, device: "dev-a" });
    } catch (err) {
      expect(String((err as Error).message)).toContain("o2b store partition leave private");
      expect(String((err as Error).message)).toContain("from sync or a backup");
    }
  });

  test("leaving private turns the machine shared-only", () => {
    const root = storeUnder();
    rmSync(join(root, "private"), { recursive: true, force: true });
    const result = leavePartition({ root, partition: "private" });
    expect(result.left).toBe(true);
    expect(result.cleared.heldMarker).toBe(true);
    const handle = openStore({ root, device: "dev-a" });
    expect(handle.partitions.has("shared")).toBe(true);
    expect(handle.partitions.has("private")).toBe(false);
  });

  test("nothing to leave changes nothing", () => {
    const root = storeUnder();
    rmSync(join(root, "private"), { recursive: true, force: true });
    leavePartition({ root, partition: "private" });
    const second = leavePartition({ root, partition: "private" });
    expect(second.left).toBe(false);
    expect(second.cleared.heldMarker).toBe(false);
  });

  test("files left refuse without force", () => {
    const root = storeUnder();
    rmSync(join(root, "private", "store.json"));
    const err = refusalOf(() => leavePartition({ root, partition: "private" }));
    expect(err.reason).toBe("files-left");
    expect(() => openStore({ root, device: "dev-a" })).toThrow(HeldPartitionLostError);
    const forced = leavePartition({ root, partition: "private", force: true });
    expect(forced.left).toBe(true);
    const handle = openStore({ root, device: "dev-a" });
    expect(handle.partitions.has("shared")).toBe(true);
    expect(handle.partitions.has("private")).toBe(false);
  });

  test("a partition folder that is a regular file refuses files-left, marker kept", () => {
    const root = storeUnder();
    rmSync(join(root, "private"), { recursive: true, force: true });
    writeFileSync(join(root, "private"), "a sync conflict landed here\n");
    const err = refusalOf(() => leavePartition({ root, partition: "private" }));
    expect(err.reason).toBe("files-left");
    expect(err.message).toContain(join(root, "private"));
    expect(err.message).toContain("ENOTDIR");
    expect(isHeldPartitionMarked(root, "private")).toBe(true);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a seen-shards ledger that cannot be written refuses clear-failed, marker last",
    () => {
      const root = storeUnder();
      const store = openStore({ root, device: "dev-a" });
      appendRecord(store, {
        partition: "private",
        stream: "events",
        kind: "decision",
        agent: "t",
        body: { text: "x" },
      });
      readStreamRecords(root, "private", { stream: "events" });
      const storeId = readStoreId(join(root, "shared")) as string;
      const ledgerDir = deviceStateDirFor(storeId, processDirsEnv());
      const ledger = readdirSync(ledgerDir).find(
        (name) => name.startsWith("seen-shards-") && name.endsWith(".json"),
      );
      expect(ledger).toBeDefined();
      rmSync(join(root, "private"), { recursive: true, force: true });
      chmodSync(ledgerDir, 0o500);
      try {
        const err = refusalOf(() => leavePartition({ root, partition: "private" }));
        expect(err.reason).toBe("clear-failed");
        // The marker goes last: a leave it could not clear is still held,
        // and the store still fails closed.
        expect(isHeldPartitionMarked(root, "private")).toBe(true);
      } finally {
        chmodSync(ledgerDir, 0o700);
      }
      expect(() => openStore({ root, device: "dev-a" })).toThrow(HeldPartitionLostError);
    },
  );

  test.each([
    ["unparseable", "{ not json"],
    ["of another version", '{"version":2,"shards":{"private":["events/dev-a/2026-01.jsonl"]}}'],
    ["with no shards map", '{"version":1}'],
    ["with a partition that is no list", '{"version":1,"shards":{"private":{}}}'],
    ["that is a list", "[]"],
    ["with an entry that is no shard name", '{"version":1,"shards":{"private":[42]}}'],
    ["with an unknown partition", '{"version":1,"shards":{"other":[]}}'],
  ])("a seen-shards ledger %s refuses clear-failed, marker kept, bytes unchanged", (_, bytes) => {
    const root = storeUnder();
    const store = openStore({ root, device: "dev-a" });
    appendRecord(store, {
      partition: "private",
      stream: "events",
      kind: "decision",
      agent: "t",
      body: { text: "x" },
    });
    readStreamRecords(root, "private", { stream: "events" });
    const storeId = readStoreId(join(root, "shared")) as string;
    const ledgerDir = deviceStateDirFor(storeId, processDirsEnv());
    const ledger = readdirSync(ledgerDir).find(
      (name) => name.startsWith("seen-shards-") && name.endsWith(".json"),
    );
    expect(ledger).toBeDefined();
    const ledgerFile = join(ledgerDir, ledger as string);
    rmSync(join(root, "private"), { recursive: true, force: true });
    writeFileSync(ledgerFile, bytes);
    const before = readFileSync(ledgerFile);
    const err = refusalOf(() => leavePartition({ root, partition: "private" }));
    expect(err.reason).toBe("clear-failed");
    expect(err.message).toContain("seen-shards ledger");
    expect(err.message).toContain(ledgerFile);
    // The entries stay on disk and the marker is kept: the store still
    // fails closed, so the machine still holds the partition.
    expect(readFileSync(ledgerFile).equals(before)).toBe(true);
    expect(isHeldPartitionMarked(root, "private")).toBe(true);
    expect(() => openStore({ root, device: "dev-a" })).toThrow(HeldPartitionLostError);
  });

  test("a missing seen-shards ledger still leaves cleanly", () => {
    const root = storeUnder();
    const store = openStore({ root, device: "dev-a" });
    appendRecord(store, {
      partition: "private",
      stream: "events",
      kind: "decision",
      agent: "t",
      body: { text: "x" },
    });
    const storeId = readStoreId(join(root, "shared")) as string;
    const ledgerDir = deviceStateDirFor(storeId, processDirsEnv());
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(join(root, "private"), { recursive: true, force: true });
    const result = leavePartition({ root, partition: "private" });
    expect(result.left).toBe(true);
    expect(result.cleared.heldMarker).toBe(true);
    expect(result.cleared.seenShards).toBe(0);
    expect(isHeldPartitionMarked(root, "private")).toBe(false);
  });

  test("clears the seen shards and the digest caches", () => {
    const root = storeUnder();
    const store = openStore({ root, device: "dev-a" });
    appendRecord(store, {
      partition: "private",
      stream: "events",
      kind: "decision",
      agent: "t",
      body: { text: "x" },
    });
    readStreamRecords(root, "private", { stream: "events" });
    const storeId = readStoreId(join(root, "shared")) as string;
    const cacheFile = join(digestCacheRoot(storeId), "k", "active.md");
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, "cache text\n");
    rmSync(join(root, "private"), { recursive: true, force: true });
    const result = leavePartition({ root, partition: "private" });
    expect(result.cleared.seenShards).toBeGreaterThanOrEqual(1);
    expect(result.cleared.digestCaches).toBe(true);
    expect(existsSync(cacheFile)).toBe(false);
  });

  test("a store.json that returns is held again", () => {
    const root = storeUnder();
    rmSync(join(root, "private"), { recursive: true, force: true });
    leavePartition({ root, partition: "private" });
    initStore({ root, partitions: ["shared", "private"] });
    openStore({ root, device: "dev-a" });
    rmSync(join(root, "private", "store.json"));
    expect(() => openStore({ root, device: "dev-a" })).toThrow(HeldPartitionLostError);
  });

  test.each([
    ["its folder removed", false],
    ["its files left and --force", true],
  ])("the search index forgets the partition on its next catch-up, %s", async (_, force) => {
    const fx = makeStoreIndexFixture("osb-partition-leave-index-");
    const saved = process.env[STORE_CATCH_UP_INTERVAL_ENV];
    process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
    try {
      const store = fx.open(LOCAL_DEVICE);
      expect(store.partitions.has("private")).toBe(true);
      appendRecord(store, {
        partition: "private",
        stream: "events",
        kind: "decision",
        agent: "agent-a",
        body: { text: "the private heron sighting" },
      });
      fx.writeNote("notes/a.md", "# A\n\nplain note\n");
      await indexVault(fx.config());
      await catchUpBrainStore(fx.config(), { force: true });
      const local = await search(fx.config(), {
        query: "heron sighting",
        limit: 10,
        transportReach: TRANSPORT_REACH.local,
      });
      expect(local.results.length).toBeGreaterThanOrEqual(1);
      recordHeldPartitions(fx.root, ["shared", "private"]);
      // With --force the shards stay on disk unchanged: the catch-up of
      // this same process must still stop listing them.
      if (force) rmSync(join(fx.root, "private", "store.json"));
      else rmSync(join(fx.root, "private"), { recursive: true, force: true });
      leavePartition({ root: fx.root, partition: "private", force });
      await catchUpBrainStore(fx.config(), { force: true });
      const after = await search(fx.config(), {
        query: "heron sighting",
        limit: 10,
        transportReach: TRANSPORT_REACH.local,
      });
      expect(after.results.length).toBe(0);
    } finally {
      if (saved === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
      else process.env[STORE_CATCH_UP_INTERVAL_ENV] = saved;
      fx.cleanup();
    }
  });

  test("an unreadable shared store id refuses and changes nothing", () => {
    const root = storeUnder();
    const store = openStore({ root, device: "dev-a" });
    appendRecord(store, {
      partition: "private",
      stream: "events",
      kind: "decision",
      agent: "t",
      body: { text: "x" },
    });
    readStreamRecords(root, "private", { stream: "events" });
    const storeId = readStoreId(join(root, "shared")) as string;
    const cacheFile = join(digestCacheRoot(storeId), "k", "active.md");
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, "cache text\n");
    const sharedId = join(root, "shared", "store.json");
    const sharedText = readFileSync(sharedId, "utf8");
    rmSync(join(root, "private"), { recursive: true, force: true });
    writeFileSync(sharedId, "{");
    const err = refusalOf(() => leavePartition({ root, partition: "private" }));
    expect(err.reason).toBe("no-store-id");
    expect(err.message).toContain("shared");
    expect(err.message).toContain("store.json");
    // The read's own error is carried and names the file once, so a
    // corrupt file is told apart from a missing one and the path is not
    // repeated; a file known to be present is not called missing.
    expect(err.message).toContain("is not valid JSON");
    expect(err.message).not.toContain("missing or unreadable");
    expect(err.message.split(join(root, "shared", "store.json")).length - 1).toBe(1);
    expect(isHeldPartitionMarked(root, "private")).toBe(true);
    expect(existsSync(cacheFile)).toBe(true);
    rmSync(sharedId);
    const again = refusalOf(() => leavePartition({ root, partition: "private" }));
    expect(again.reason).toBe("no-store-id");
    // A missing file is said to be missing, with the path once.
    expect(again.message).toContain("store.json is missing");
    expect(again.message.split(join(root, "shared", "store.json")).length - 1).toBe(1);
    expect(isHeldPartitionMarked(root, "private")).toBe(true);
    expect(existsSync(cacheFile)).toBe(true);
    writeFileSync(sharedId, sharedText);
    const result = leavePartition({ root, partition: "private" });
    expect(result.left).toBe(true);
    expect(result.cleared.seenShards).toBeGreaterThanOrEqual(1);
    expect(result.cleared.digestCaches).toBe(true);
  });
});

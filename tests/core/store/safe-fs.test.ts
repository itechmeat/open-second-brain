/**
 * The store never writes through what a sync peer can plant in a partition
 * (a symlinked directory or shard, a hard-linked shard, a symlinked blob
 * folder), and creates its directories and files for the owner only.
 *
 * Symlinks need no privilege on POSIX; on Windows creating one does, so
 * the symlink cases run where the fixture can be built.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendRecord, type AppendInput } from "../../../src/core/store/appender.ts";
import { readBlob, writeBlob } from "../../../src/core/store/blobs.ts";
import { readShard } from "../../../src/core/store/reader.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { ShardScanner } from "../../../src/core/search/brain-store/shard-scan.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { StoreUnsafePathError } from "../../../src/core/store/safe-fs.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import { blobPath, partitionDir, shardPath } from "../../../src/core/store/store-paths.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { makeTempStore, type TempStore } from "./fixtures/temp-store.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const NOV_2026 = Date.UTC(2026, 10, 6, 12, 0, 0);
const NOTE: AppendInput = {
  partition: "shared",
  stream: "events",
  kind: "note",
  agent: "a1",
  body: { text: "hello" },
};

/** Whether this host lets the test create a symlink (Windows needs a privilege). */
const CAN_SYMLINK = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "osb-symlink-probe-"));
  try {
    symlinkSync(probe, join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let tmp: TempStore;
let outside: string;
beforeEach(() => {
  tmp = makeTempStore("osb-store-safe-");
  outside = join(tmp.parent, "outside");
  mkdirSync(outside, { recursive: true });
});
afterEach(() => tmp.cleanup());

function append(device = "dev-a") {
  return appendRecord(tmp.open(device), NOTE, { now: () => NOV_2026 });
}

describe("symlinks and hard links a peer can plant", () => {
  test.if(CAN_SYMLINK)(
    "a symlinked device directory is refused and nothing is written through it",
    () => {
      tmp.open("dev-a");
      const streamDir = join(partitionDir(tmp.root, "shared"), "events");
      mkdirSync(streamDir, { recursive: true });
      symlinkSync(outside, join(streamDir, "dev-a"), "dir");
      expect(() => append()).toThrow(StoreUnsafePathError);
      expect(existsSync(join(outside, "2026-11.jsonl"))).toBe(false);
    },
  );

  test.if(CAN_SYMLINK)("a symlinked stream directory is refused", () => {
    tmp.open("dev-a");
    symlinkSync(outside, join(partitionDir(tmp.root, "shared"), "events"), "dir");
    expect(() => append()).toThrow(StoreUnsafePathError);
    expect(existsSync(join(outside, "dev-a"))).toBe(false);
  });

  test.if(CAN_SYMLINK)("a shard that is a symlink to a file outside the store is refused", () => {
    tmp.open("dev-a");
    const victim = join(outside, "rc-file");
    writeFileSync(victim, "keep me\n");
    const shard = shardPath(tmp.root, "shared", { stream: "events" }, "dev-a", "2026-11");
    mkdirSync(dirname(shard), { recursive: true });
    symlinkSync(victim, shard, "file");
    expect(() => append()).toThrow(StoreUnsafePathError);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });

  test("a shard hard-linked to a file outside the store is refused", () => {
    tmp.open("dev-a");
    const victim = join(outside, "config-file");
    writeFileSync(victim, "keep me\n");
    const shard = shardPath(tmp.root, "shared", { stream: "events" }, "dev-a", "2026-11");
    mkdirSync(dirname(shard), { recursive: true });
    linkSync(victim, shard);
    expect(() => append()).toThrow(StoreUnsafePathError);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });

  test.if(CAN_SYMLINK)(
    "a symlinked blob folder is refused, and a symlinked blob is never read",
    () => {
      tmp.open("dev-a");
      const partition = partitionDir(tmp.root, "shared");
      const text = '{"a":1}';
      const sha = sha256Hex(text);
      const folder = dirname(blobPath(partition, sha));
      mkdirSync(dirname(folder), { recursive: true });
      symlinkSync(outside, folder, "dir");
      expect(() => writeBlob(partition, text)).toThrow(StoreUnsafePathError);
      expect(existsSync(join(outside, sha))).toBe(false);

      // A blob name that is itself a symlink, even to the right content.
      rmSync(folder);
      mkdirSync(folder);
      writeFileSync(join(outside, sha), text);
      symlinkSync(join(outside, sha), join(folder, sha), "file");
      expect(readBlob(partition, sha).status).toBe("mismatch");
    },
  );

  test.if(CAN_SYMLINK)("a shard that is a symlink is reported, never read through", () => {
    const real = append();
    const victim = join(outside, "copied-shard");
    writeFileSync(victim, readFileSync(real.path));
    const shard = shardPath(tmp.root, "shared", { stream: "events" }, "dev-a", "2026-12");
    symlinkSync(victim, shard, "file");
    const read = readShard(shard);
    expect(read.records).toEqual([]);
    expect(read.diagnostics.map((d) => d.kind)).toEqual(["not-a-file"]);
    // Read from a resume offset, the size agrees with the offset it hands back.
    const resumed = readShard(shard, { offset: 10 });
    expect(resumed.nextOffset).toBe(10);
    expect(resumed.size).toBe(10);
  });

  test.if(CAN_SYMLINK)(
    "a linked folder below a partition is never read through: reader, scanner and blobs",
    () => {
      const store = tmp.open("dev-a");
      appendRecord(store, { ...NOTE, partition: "private" }, { now: () => NOV_2026 });
      const shared = partitionDir(tmp.root, "shared");
      const privateEvents = join(partitionDir(tmp.root, "private"), "events");
      // A peer syncs `shared/events` as a link to the private events folder,
      // and `shared/ledgers/x` as a link to a folder holding a device folder.
      symlinkSync(privateEvents, join(shared, "events"), "dir");
      mkdirSync(join(shared, "ledgers"), { recursive: true });
      symlinkSync(privateEvents, join(shared, "ledgers", "x"), "dir");

      const unreadable: string[] = [];
      const shards = readPartition(shared, { onUnreadable: ({ rel }) => unreadable.push(rel) });
      expect(shards.flatMap((s) => s.all)).toEqual([]);
      expect(unreadable).toContain("events/dev-a/2026-11.jsonl");
      const throughLink = join(shared, "events", "dev-a", "2026-11.jsonl");
      expect(
        readShard(throughLink, { partitionRoot: shared }).diagnostics.map((d) => d.kind),
      ).toEqual(["not-a-file"]);

      const scanner = new ShardScanner({
        root: tmp.root,
        storeId: "s",
        deviceStateDir: join(tmp.parent, "state"),
        partitions: ["shared", "private"],
      });
      expect(scanner.scan().map((s) => s.key)).toEqual(["private/events/dev-a/2026-11.jsonl"]);

      // A blob reached through a linked blob folder is not read, even when
      // the file there holds the right content.
      const text = '{"a":1}';
      const sha = sha256Hex(text);
      const folder = dirname(blobPath(shared, sha));
      mkdirSync(dirname(folder), { recursive: true });
      writeFileSync(join(outside, sha), text);
      symlinkSync(outside, folder, "dir");
      expect(readBlob(shared, sha).status).toBe("mismatch");
    },
  );

  test.skipIf(IS_WINDOWS)("a shard that is a FIFO is reported without blocking", () => {
    const shard = shardPath(tmp.root, "shared", { stream: "events" }, "dev-a", "2026-11");
    mkdirSync(dirname(shard), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", shard]).exitCode).toBe(0);
    const read = readShard(shard);
    expect(read.records).toEqual([]);
    expect(read.diagnostics.map((d) => d.kind)).toEqual(["not-a-file"]);
  });
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe.skipIf(IS_WINDOWS)("modes", () => {
  test("partitions, shard directories, shards and blobs are for the owner only", () => {
    const root = join(tmp.parent, "fresh");
    initStore({ root });
    expect(modeOf(partitionDir(root, "shared"))).toBe(0o700);
    expect(modeOf(partitionDir(root, "private"))).toBe(0o700);

    const result = append();
    expect(modeOf(result.path)).toBe(0o600);
    expect(modeOf(dirname(result.path))).toBe(0o700);
    expect(modeOf(dirname(dirname(result.path)))).toBe(0o700);

    const partition = partitionDir(tmp.root, "private");
    const blob = writeBlob(partition, '{"b":2}');
    expect(modeOf(blob.path)).toBe(0o600);
    expect(modeOf(dirname(blob.path))).toBe(0o700);
  });
});

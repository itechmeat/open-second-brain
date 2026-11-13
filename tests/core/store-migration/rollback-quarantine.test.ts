/**
 * A rollback with a quarantined pending blob (change store-hardening,
 * spec `store-shard-gaps`, "Rollback with a quarantined pending blob"): the
 * quarantine skips the record on this machine, yet the rollback still
 * refuses while its blob is pending, names the shard, and restores nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { readShard, shardReadGap } from "../../../src/core/store/reader.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { addQuarantine } from "../../../src/core/store/shard-quarantine-write.ts";
import { lineSha256At } from "../../../src/core/store/shard-quarantine.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { isDeviceSwitched } from "../../../src/core/store-migration/migration-records.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { RollbackRefusedError } from "../../../src/core/store-migration/rollback.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";

const FAST = { settleMs: 0 } as const;
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

describe("rollback with a quarantined pending blob", () => {
  test("refuses and names the shard", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const shared = partitionDir(a.storeRoot, "shared");
    // Another device's record whose body is a blob, then the blob is lost.
    const path = appendRecord(openStore({ root: a.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "events",
      kind: "note",
      agent: "t",
      body: { text: "x".repeat(20_000) },
    }).path;
    rmSync(join(shared, "blobs"), { recursive: true, force: true });
    const rel = relative(shared, path).split("\\").join("/");
    const offset = readShard(path, { partitionRoot: shared }).records.find(
      (r) => r.bodyState === "pending",
    )!.offset;
    addQuarantine(a.storeRoot, {
      partition: "shared",
      shard: rel,
      offset,
      sha256: lineSha256At(path, offset, shared)!,
      kind: "blob-pending",
      reason: "test",
    });
    // The quarantine holds: the shard reads as whole on this machine.
    expect(shardReadGap(readShard(path, { partitionRoot: shared }))).toBeNull();
    const before = readdirSync(join(a.vault, "Brain")).toSorted();
    expect(() => rollback(a.vault)).toThrow(RollbackRefusedError);
    expect(() => rollback(a.vault)).toThrow(`shared/${rel}`);
    expect(isDeviceSwitched(a.store(), "dev-a")).toBe(true);
    expect(readdirSync(join(a.vault, "Brain")).toSorted()).toEqual(before);
  });
});

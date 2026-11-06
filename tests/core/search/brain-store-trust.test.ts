/**
 * Catch-up against what a lower-trust peer can deliver into a synced
 * partition: a blob that hashes to its name but is not a record body, and
 * a record id copied into the other partition. Neither may stop catch-up,
 * and neither may relabel or replace what is already indexed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { BLOB_REF_BYTES_KEY, BLOB_REF_KEY } from "../../../src/core/store/constants.ts";
import { blobPath, partitionDir } from "../../../src/core/store/store-paths.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-trust-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

async function readyIndex(): Promise<ResolvedSearchConfig> {
  fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/a.md", "# A\n\nA note.\n");
  const config = fx.config();
  await indexVault(config);
  return config;
}

async function rows<T>(config: ResolvedSearchConfig, sql: string): Promise<T[]> {
  const store = await Store.open(config, { mode: "read" });
  try {
    return store.rawQuery<T>(sql);
  } finally {
    await store.close();
  }
}

function remoteNote(partition: "shared" | "private", text: string) {
  return appendRecord(fx.open(REMOTE_DEVICE), {
    partition,
    stream: "events",
    kind: "decision",
    agent: "agent-b",
    body: { text },
  });
}

describe("catch-up against a lower-trust peer", () => {
  test("a pending blob that arrives holding no record body keeps the record pending", async () => {
    const config = await readyIndex();
    const first = remoteNote("shared", "Avocet first");
    const content = "null";
    const sum = sha256Hex(content);
    const crafted = {
      ...first.record,
      id: "01M00000000000000000000001",
      sum,
      body: { [BLOB_REF_KEY]: sum, [BLOB_REF_BYTES_KEY]: Buffer.byteLength(content) },
    };
    appendFileSync(first.path, `${JSON.stringify(crafted)}\n`);
    expect((await catchUpBrainStore(config, { force: true })).skipped).toBeNull();

    const blob = blobPath(partitionDir(fx.root, "shared"), sum);
    mkdirSync(dirname(blob), { recursive: true });
    writeFileSync(blob, content);
    const after = await catchUpBrainStore(config, { force: true });
    expect(after.skipped).toBeNull();
    expect(after.error).toBeUndefined();
    const pending = await rows<{ id: string }>(
      config,
      "SELECT id FROM records WHERE body_pending = 1",
    );
    expect(pending.map((r) => r.id)).toEqual([crafted.id]);

    // Later records are still indexed.
    remoteNote("shared", "Avocet second");
    expect((await catchUpBrainStore(config, { force: true })).added).toBe(1);
  });

  test("an id copied into the other partition neither relabels nor replaces the record", async () => {
    const config = await readyIndex();
    const genuine = remoteNote("shared", "Stilt genuine");
    await catchUpBrainStore(config, { force: true });

    const forged = { ...genuine.record };
    const privateShard = join(
      partitionDir(fx.root, "private"),
      "events",
      REMOTE_DEVICE,
      genuine.path.split(/[\\/]/).at(-1)!,
    );
    mkdirSync(dirname(privateShard), { recursive: true });
    writeFileSync(privateShard, `${JSON.stringify(forged)}\n`);
    expect((await catchUpBrainStore(config, { force: true })).skipped).toBeNull();

    const indexed = await rows<{ partition: string; shard: string }>(
      config,
      `SELECT partition, shard FROM records WHERE id = '${genuine.record.id}'`,
    );
    expect(indexed.map((r) => r.partition)).toEqual(["shared"]);
    expect(indexed[0]!.shard).toContain("shared");
  });

  test("a copy in the other partition does not keep a removed record indexed", async () => {
    const config = await readyIndex();
    const genuine = remoteNote("private", "Stilt removed");
    await catchUpBrainStore(config, { force: true });

    // One pass meets both: the private shard rewritten without the record
    // (read first, so the record is orphaned) and a shared copy of it.
    writeFileSync(genuine.path, "");
    const sharedShard = join(
      partitionDir(fx.root, "shared"),
      "events",
      REMOTE_DEVICE,
      genuine.path.split(/[\\/]/).at(-1)!,
    );
    mkdirSync(dirname(sharedShard), { recursive: true });
    writeFileSync(sharedShard, `${JSON.stringify(genuine.record)}\n`);
    expect((await catchUpBrainStore(config, { force: true })).skipped).toBeNull();

    const indexed = await rows<{ partition: string }>(
      config,
      `SELECT partition FROM records WHERE id = '${genuine.record.id}' AND partition = 'private'`,
    );
    expect(indexed).toEqual([]);
  });
});

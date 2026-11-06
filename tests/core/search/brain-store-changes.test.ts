/**
 * The change probe (design D5, task 1.9): new record ids since a
 * watermark, grouped by partition, stream, scope and topic, answered from
 * the index after catch-up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { brainChanges } from "../../../src/core/search/brain-store/changes.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { buildRecord } from "../../../src/core/store/envelope.ts";
import { shardPath } from "../../../src/core/store/store-paths.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-changes-");
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

function neighbourDecision(text: string, scope: string | null, topic: string | null) {
  return appendRecord(fx.open(REMOTE_DEVICE), {
    partition: "shared",
    stream: "events",
    kind: "decision",
    agent: "agent-b",
    scope,
    topic,
    body: { text },
  }).record;
}

describe("brainChanges", () => {
  test("returns a neighbour's record id under its topic and scope", async () => {
    const config = await readyIndex();
    neighbourDecision("an earlier decision", null, null);
    const before = await brainChanges(config);
    expect(before.count).toBe(1);
    const w = before.watermark!;

    const topic = newUlid();
    const record = neighbourDecision("pick the north bank", "project:estuary", topic);
    const after = await brainChanges(config, { since: w });
    expect(after.reset).toBe(false);
    expect(after.count).toBe(1);
    expect(after.groups).toEqual([
      {
        partition: "shared",
        stream: "events",
        ledger: null,
        scope: "project:estuary",
        topic,
        ids: [record.id],
      },
    ]);
    // Nothing new since the watermark it returned.
    const idle = await brainChanges(config, { since: after.watermark! });
    expect(idle).toMatchObject({ count: 0, groups: [], watermark: after.watermark });
  });

  test("a late record with an older clock is still new after the watermark", async () => {
    const config = await readyIndex();
    neighbourDecision("first", null, null);
    const w = (await brainChanges(config)).watermark!;
    const late = buildRecord({
      hlc: { physical: Date.UTC(2025, 0, 1), counter: 0 },
      device: REMOTE_DEVICE,
      agent: "agent-b",
      kind: "decision",
      body: { text: "written offline long ago" },
    });
    const shard = shardPath(fx.root, "shared", { stream: "events" }, REMOTE_DEVICE, "2025-01");
    mkdirSync(dirname(shard), { recursive: true });
    appendFileSync(shard, `${JSON.stringify(late)}\n`);
    const after = await brainChanges(config, { since: w });
    expect(after.groups.flatMap((g) => g.ids)).toEqual([late.id]);
  });

  test("a record ingested after the newest one was removed is still new after the watermark", async () => {
    const config = await readyIndex();
    neighbourDecision("kept", null, null);
    await brainChanges(config);
    const late = buildRecord({
      hlc: { physical: Date.UTC(2025, 0, 1), counter: 0 },
      device: REMOTE_DEVICE,
      agent: "agent-b",
      kind: "decision",
      body: { text: "removed again" },
    });
    const shard = shardPath(fx.root, "shared", { stream: "events" }, REMOTE_DEVICE, "2025-01");
    mkdirSync(dirname(shard), { recursive: true });
    appendFileSync(shard, `${JSON.stringify(late)}\n`);
    const w = (await brainChanges(config)).watermark!;
    // The newest ingested record leaves with its shard; the next record
    // must not reuse its sequence and hide behind the watermark.
    rmSync(shard);
    expect((await brainChanges(config, { since: w })).count).toBe(0);
    const next = neighbourDecision("after the removal", null, null);
    const after = await brainChanges(config, { since: w });
    expect(after.groups.flatMap((g) => g.ids)).toEqual([next.id]);
  });

  test("a limit pages forward through the watermark", async () => {
    const config = await readyIndex();
    const a = neighbourDecision("one", null, null);
    const b = neighbourDecision("two", null, null);
    const first = await brainChanges(config, { limit: 1 });
    expect(first).toMatchObject({ truncated: true, count: 1 });
    expect(first.groups[0]!.ids).toEqual([a.id]);
    const second = await brainChanges(config, { since: first.watermark!, limit: 1 });
    expect(second).toMatchObject({ truncated: false, count: 1 });
    expect(second.groups[0]!.ids).toEqual([b.id]);
  });

  test("a watermark from a replaced index starts over and says so", async () => {
    const config = await readyIndex();
    const a = neighbourDecision("one", null, null);
    const w = (await brainChanges(config)).watermark!;
    await reindexVault(config);
    const after = await brainChanges(config, { since: w });
    expect(after.reset).toBe(true);
    expect(after.groups.flatMap((g) => g.ids)).toEqual([a.id]);
  });

  // An unreadable shard is the portable way to make a catch-up fail; a
  // mode bit cannot stop root or a Windows reader.
  const canDenyRead = !CHMOD_CANNOT_DENY;
  test.skipIf(!canDenyRead)("a failed catch-up is named in the warnings", async () => {
    const config = await readyIndex();
    const first = await brainChanges(config);
    expect(first.warnings).toEqual([]);
    const { path: shard } = appendRecord(fx.open(REMOTE_DEVICE), {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text: "unreadable for now" },
    });
    chmodSync(shard, 0o000);
    try {
      const failed = await brainChanges(config, { since: first.watermark! });
      expect(failed.count).toBe(0);
      expect(failed.warnings).toEqual([
        expect.stringContaining("brain store catch-up failed, records may be missing"),
      ]);
    } finally {
      chmodSync(shard, 0o644);
    }
    const healed = await brainChanges(config, { since: first.watermark! });
    expect(healed).toMatchObject({ count: 1, warnings: [] });
  });

  test("a malformed watermark is refused by name", async () => {
    const config = await readyIndex();
    await expect(brainChanges(config, { since: "yesterday" })).rejects.toThrow("not a watermark");
  });

  test("without a store nothing is reported", async () => {
    const config = makeConfig({ vault: fx.vault, dbPath: `${fx.parent}/legacy.sqlite` });
    expect(await brainChanges(config)).toMatchObject({ storeInUse: false, watermark: null });
  });
});

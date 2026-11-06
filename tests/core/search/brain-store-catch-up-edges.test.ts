/**
 * Catch-up edge cases (design D3, D5): a spilled body whose blob arrives
 * after its line, a line from a newer format version, a rebuild that
 * re-reads every shard from offset 0, and the receive rule of the clock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readClock } from "../../../src/core/store/clock-store.ts";
import { compareHlc, parseHlc } from "../../../src/core/store/hlc.ts";
import { blobPath, partitionDir } from "../../../src/core/store/store-paths.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

let fx: StoreIndexFixture;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved["interval"] = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  saved["device"] = process.env["O2B_DEVICE_ID"];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-edges-");
});
afterEach(() => {
  if (saved["interval"] === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = saved["interval"];
  if (saved["device"] === undefined) delete process.env["O2B_DEVICE_ID"];
  else process.env["O2B_DEVICE_ID"] = saved["device"];
  fx.cleanup();
});

async function readyIndex(): Promise<ResolvedSearchConfig> {
  fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/a.md", "# A\n\nA note.\n");
  const config = fx.config();
  await indexVault(config);
  return config;
}

async function found(config: ResolvedSearchConfig, query: string): Promise<string[]> {
  const outcome = await search(config, { query, limit: 10, transportReach: TRANSPORT_REACH.local });
  return [...new Set(outcome.results.map((r) => r.path))];
}

async function scalar(config: ResolvedSearchConfig, sql: string): Promise<number> {
  const store = await Store.open(config, { mode: "read" });
  try {
    return store.rawQuery<{ n: number }>(sql)[0]!.n;
  } finally {
    await store.close();
  }
}

describe("catch-up edge cases", () => {
  test("a spilled body is indexed once its blob arrives", async () => {
    const config = await readyIndex();
    const filler = "lorem ".repeat(4000);
    const { record, spilled } = appendRecord(fx.open(REMOTE_DEVICE), {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text: `Phalarope migration plan ${filler}` },
    });
    expect(spilled).toBe(true);
    const blob = blobPath(partitionDir(fx.root, "shared"), record.sum);
    const bytes = readFileSync(blob);
    rmSync(blob);

    expect(await found(config, "phalarope")).toEqual([]);
    expect(await scalar(config, "SELECT COUNT(*) AS n FROM records WHERE body_pending = 1")).toBe(
      1,
    );

    writeFileSync(blob, bytes);
    expect(await found(config, "phalarope")).toEqual([storeRecordPath("shared", record.id)]);
    expect(await scalar(config, "SELECT COUNT(*) AS n FROM records WHERE body_pending = 1")).toBe(
      0,
    );
  });

  test("a newer-version line is skipped and counted, and the rest is indexed", async () => {
    const config = await readyIndex();
    const b = fx.open(REMOTE_DEVICE);
    const first = appendRecord(b, {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text: "Godwit decision one" },
    });
    appendFileSync(
      first.path,
      `${JSON.stringify({ ...first.record, v: 99, id: "01M00000000000000000000000" })}\n`,
    );
    appendRecord(b, {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text: "Godwit decision two" },
    });
    expect((await found(config, "godwit")).length).toBe(2);
    expect(await scalar(config, "SELECT SUM(unknown_versions) AS n FROM store_watermarks")).toBe(1);
  });

  test("a rebuild re-reads every shard from offset 0 into the swapped-in index", async () => {
    const config = await readyIndex();
    const { record } = appendRecord(fx.open(REMOTE_DEVICE), {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text: "Whimbrel decision" },
    });
    await catchUpBrainStore(config);
    await reindexVault(config);
    // Straight after the swap, before any catch-up: the record is there.
    expect(await scalar(config, "SELECT COUNT(*) AS n FROM records")).toBe(1);
    expect(await found(config, "whimbrel")).toEqual([storeRecordPath("shared", record.id)]);
  });

  test("catch-up raises the local clock to the largest remote clock it ingested", async () => {
    const config = await readyIndex();
    process.env["O2B_DEVICE_ID"] = LOCAL_DEVICE;
    const ahead = Date.now() + 60 * 60 * 1000;
    const { record } = appendRecord(
      fx.open(REMOTE_DEVICE),
      {
        partition: "shared",
        stream: "events",
        kind: "decision",
        agent: "agent-b",
        body: { text: "x" },
      },
      { now: () => ahead },
    );
    await catchUpBrainStore(config);
    const local = readClock(config.brainStore!.deviceStateDir, LOCAL_DEVICE);
    expect(local).not.toBeNull();
    const remote = parseHlc(record.hlc);
    expect(remote).not.toBeNull();
    expect(compareHlc(local!, remote!)).toBeGreaterThanOrEqual(0);
  });
});

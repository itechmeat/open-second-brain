/**
 * What a rebuild writes into its staging index, which searches read while
 * it is built: never a record its store already forgot, and, for a record
 * id found in both partitions, the same copy every catch-up indexes.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import {
  catchUpBrainStore,
  ingestStoreInto,
} from "../../../src/core/search/brain-store/catch-up.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { getRecord } from "../../../src/core/search/store/brain-records.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { shardPath } from "../../../src/core/store/store-paths.ts";
import {
  LOCAL_DEVICE,
  REMOTE_DEVICE,
  makeStoreIndexFixture,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

let fx: StoreIndexFixture;
let savedInterval: string | undefined;
beforeEach(() => {
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  fx = makeStoreIndexFixture("osb-store-build-order-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

function signalBody(id: string, words: string): Record<string, unknown> {
  return {
    id,
    path: `Brain/inbox/${id}.md`,
    staged: false,
    frontmatter: { principle: words },
    raw: words,
  };
}

test("a forgotten signal is never in the staging index, at any point of the build", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const remote = fx.open(REMOTE_DEVICE);
  const kept = appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: signalBody("sig-k", "Kept narwhal rule"),
    },
    { now: () => T0 },
  ).record;
  const forgotten = appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: signalBody("sig-f", "Forgotten quokka rule"),
    },
    { now: () => T0 + 1000 },
  ).record;
  // The tombstone sits in a shard the build reads after the signal's.
  appendRecord(
    remote,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-removed",
      agent: "t",
      body: { authority: "human", signal: "sig-f" },
    },
    { now: () => T0 + 5000 },
  );
  for (let i = 0; i < 40; i++) {
    appendRecord(
      local,
      {
        partition: "shared",
        stream: "log",
        kind: "log-event",
        agent: "t",
        body: { text: `log line ${i}` },
      },
      { now: () => T0 + 10_000 + i },
    );
  }
  const config = { ...fx.config(), dbPath: join(fx.parent, "staging", "brain.sqlite.new") };
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const index = await Store.open(config, { mode: "write", loadVec: false });
  const present = (id: string): boolean =>
    index.rawQuery<{ n: number }>("SELECT count(*) AS n FROM documents WHERE path = ?", [
      storeRecordPath("shared", id),
    ])[0]!.n > 0;
  let calls = 0;
  let keptSeen = false;
  try {
    ingestStoreInto(index, config, () => {
      // After every record the pass reads, on the connection that writes
      // it: a reader of the file sees at most this.
      calls++;
      expect(present(forgotten.id)).toBe(false);
      if (present(kept.id)) keptSeen = true;
    });
    expect(present(forgotten.id)).toBe(false);
    expect(getRecord(index.brainRecordsConnection(), forgotten.id)).toBeNull();
  } finally {
    await index.close();
  }
  expect(calls).toBeGreaterThan(40);
  expect(keptSeen).toBe(true);
});

test("a record id held in both partitions is indexed from the copy a catch-up indexes", async () => {
  const local = fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/a.md", "# A\n\nA note.\n");
  const { record } = appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "t",
      body: { text: "Twin heron decision" },
    },
    { now: () => Date.UTC(2026, 10, 3) },
  );
  // The same envelope in `private`, in an older month than the shared copy:
  // a rebuild that read newer months first would index the shared copy.
  const twin = shardPath(fx.root, "private", { stream: "events" }, LOCAL_DEVICE, "2026-10");
  mkdirSync(dirname(twin), { recursive: true });
  appendFileSync(twin, `${JSON.stringify(record)}\n`);
  const config = fx.config();
  await indexVault(config);
  await catchUpBrainStore(config, { force: true });
  const partitionOf = async (): Promise<string | undefined> => {
    const index = await Store.open(config, { mode: "read" });
    try {
      return getRecord(index.brainRecordsConnection(), record.id)?.partition;
    } finally {
      await index.close();
    }
  };
  const caughtUp = await partitionOf();
  // The private copy: a catch-up reads the shards in key order.
  expect(caughtUp).toBe("private");
  await reindexVault(config);
  expect(await partitionOf()).toBe(caughtUp);
});

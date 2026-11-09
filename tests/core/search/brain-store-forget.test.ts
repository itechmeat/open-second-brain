/**
 * A forgotten signal leaves the search index with its tombstone (FORMAT.md,
 * "Removal"): after `signal-removed` is caught up, no query finds the
 * capture or a move of it, while the shards still hold the lines.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";

import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { buildRecord } from "../../../src/core/store/envelope.ts";
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
  fx = makeStoreIndexFixture("osb-store-forget-");
});
afterEach(() => {
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
  fx.cleanup();
});

async function hits(config: ResolvedSearchConfig, query: string): Promise<number> {
  const outcome = await search(config, { query, limit: 10, transportReach: TRANSPORT_REACH.local });
  return outcome.results.length;
}

test("a signal-removed tombstone takes the signal's records out of the index, also after a rebuild", async () => {
  const store = fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/a.md", "# A\n\nA note.\n");
  const config = fx.config();
  await indexVault(config);
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "signal",
    agent: "t",
    body: {
      id: "sig-x",
      path: "Brain/inbox/sig-x.md",
      staged: false,
      frontmatter: { principle: "Zanzibar quokka rule" },
      raw: "Zanzibar quokka rule",
    },
  });
  await catchUpBrainStore(config);
  expect(await hits(config, "quokka")).toBeGreaterThan(0);
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "signal-removed",
    agent: "t",
    body: { authority: "human", signal: "sig-x" },
  });
  await catchUpBrainStore(config);
  expect(await hits(config, "quokka")).toBe(0);
  await reindexVault(config);
  expect(await hits(config, "quokka")).toBe(0);
});

const SIGNAL_Y = {
  id: "sig-y",
  path: "Brain/inbox/sig-y.md",
  staged: false,
  frontmatter: { principle: "Okapi lemur rule" },
  raw: "Okapi lemur rule",
};

test("a voided line that reaches an already-read shard after its tombstone stays out", async () => {
  const local = fx.open(LOCAL_DEVICE);
  const remote = fx.open(REMOTE_DEVICE);
  const t0 = Date.UTC(2026, 10, 1, 9, 0, 0);
  const signal = (store: typeof local, ms: number) =>
    appendRecord(
      store,
      {
        partition: "shared",
        stream: "events",
        kind: "signal",
        agent: "t",
        body: SIGNAL_Y,
      },
      { now: () => ms },
    );
  // The remote shard exists and is read before the tombstone.
  appendRecord(
    remote,
    { partition: "shared", stream: "events", kind: "note-unrelated", agent: "t", body: {} },
    { now: () => t0 },
  );
  fx.writeNote("notes/a.md", "# A\n\nA note.\n");
  const config = fx.config();
  await indexVault(config);
  signal(local, t0 + 1000);
  await catchUpBrainStore(config);
  expect(await hits(config, "okapi")).toBeGreaterThan(0);
  appendRecord(
    local,
    {
      partition: "shared",
      stream: "events",
      kind: "signal-removed",
      agent: "t",
      body: { authority: "human", signal: "sig-y" },
    },
    { now: () => t0 + 5000 },
  );
  await catchUpBrainStore(config);
  expect(await hits(config, "okapi")).toBe(0);
  // A copy of the signal from before the tombstone syncs in late, appended
  // to the remote shard this index already read. Sync delivers the remote
  // device's bytes; this process never stamps them (its own clock has read
  // the tombstone).
  const late = buildRecord({
    hlc: { physical: t0 + 2000, counter: 0 },
    device: REMOTE_DEVICE,
    agent: "t",
    kind: "signal",
    scope: null,
    topic: null,
    body: SIGNAL_Y,
  });
  appendFileSync(
    shardPath(fx.root, "shared", { stream: "events" }, REMOTE_DEVICE, "2026-11"),
    `${JSON.stringify(late)}\n`,
  );
  await catchUpBrainStore(config);
  expect(await hits(config, "okapi")).toBe(0);
});

test("a removed preference and a removed lane entry leave the index too", async () => {
  const store = fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/a.md", "# A\n\nA note.\n");
  const config = fx.config();
  await indexVault(config);
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "preference-set",
    agent: "t",
    body: {
      authority: "agent",
      preference: "pref-w",
      fields: { principle: "Wombat cadence rule" },
    },
  });
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "lane-entry",
    agent: "t",
    body: {
      authority: "agent",
      lane: "sources",
      entry: "src-k",
      fields: {},
      text: "Kinkajou summary",
    },
  });
  await catchUpBrainStore(config);
  expect(await hits(config, "wombat")).toBeGreaterThan(0);
  expect(await hits(config, "kinkajou")).toBeGreaterThan(0);
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "preference-remove",
    agent: "t",
    body: { authority: "human", preference: "pref-w" },
  });
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "lane-entry-remove",
    agent: "t",
    body: { authority: "agent", lane: "sources", entry: "src-k" },
  });
  await catchUpBrainStore(config);
  expect(await hits(config, "wombat")).toBe(0);
  expect(await hits(config, "kinkajou")).toBe(0);
});
